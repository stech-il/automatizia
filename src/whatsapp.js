import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import * as db from './db.js';
import { lastConvByManager, msgIdToConv } from './convMap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wa_auth');

let sock = null;
let isConnected = false;
let connectCallbacks = null;
const pendingReplies = new Map();

function extractText(msg) {
  if (!msg) return null;
  const t = msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.buttonsResponseMessage?.selectedButtonId
    || msg.listResponseMessage?.title
    || msg.listResponseMessage?.singleSelectReply?.selectedRowId
    || msg.templateButtonReplyMessage?.selectedId
    || (typeof msg === 'string' ? msg : null);
  return t ? String(t).trim() || null : null;
}

export function getConnectionStatus() {
  return { connected: isConnected };
}

export async function connectWhatsApp(onQR, onReady, onDisconnect) {
  connectCallbacks = { onQR, onReady, onDisconnect };
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', (update) => {
    if (update.qr) {
      onQR?.(update.qr);
    }
    if (update.connection === 'open') {
      isConnected = true;
      onReady?.();
    }
    if (update.connection === 'close') {
      isConnected = false;
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      onDisconnect?.(update);
      if (statusCode === DisconnectReason.loggedOut) return;
      if (sock) {
        try { sock.end(); } catch (e) {}
        sock = null;
      }
      console.log('Reconnecting in 3s... (reason:', statusCode || 'unknown', ')');
      setTimeout(() => connectWhatsApp(onQR, onReady, onDisconnect), 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const msg = extractText(m.message);
      if (!msg) continue;
      const fromJid = m.key.remoteJid || '';
      if (fromJid.endsWith('@g.us')) continue;
      const phoneRaw = fromJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      const phoneVariants = [phoneRaw, phoneRaw.startsWith('972') ? phoneRaw.slice(3) : '972' + phoneRaw];

      let convId = null;
      const quotedId = m.message?.extendedTextMessage?.contextInfo?.stanzaId
        || m.message?.imageMessage?.contextInfo?.stanzaId
        || m.message?.videoMessage?.contextInfo?.stanzaId
        || m.message?.documentMessage?.contextInfo?.stanzaId;
      if (quotedId) convId = msgIdToConv.get(quotedId);
      if (!convId) {
        for (const p of phoneVariants) {
          convId = lastConvByManager.get(p);
          if (convId) break;
        }
      }
      if (!convId) {
        convId = db.getManagerLastConv(phoneRaw)
          || db.getManagerLastConv(phoneVariants[1]);
      }
      if (!convId) {
        const sites = db.getAllSites();
        const site = sites.find(s => {
          const dbPhone = s.manager_phone.replace(/\D/g, '');
          return phoneVariants.some(p => dbPhone === p || dbPhone.endsWith(p) || p.endsWith(dbPhone));
        });
        if (site) {
          const conv = db.getActiveConversationBySite(site.id);
          if (conv) convId = conv.id;
        }
      }
      if (!convId && m.key.fromMe) {
        const conv = db.getActiveConversationByVisitorPhone(phoneRaw);
        if (conv) convId = conv.id;
      }
      if (!convId) {
        if (process.env.DEBUG_WA) console.log('[WPWAC] No conv for message from', phoneRaw, 'fromMe:', m.key.fromMe);
        continue;
      }

      db.addMessage(convId, 'incoming', msg);

      const isClosePhrase = /הפניה\s*נסגרה\s*בהצלחה/.test(msg) || msg.includes('הפניה נסגרה בהצלחה');
      if (isClosePhrase) {
        console.log('[WPWAC] Closing conversation', convId, 'from', m.key.fromMe ? 'manager' : 'external');
        db.closeConversation(convId);
        db.clearManagerLastConvForConversation(convId);
        for (const p of phoneVariants) lastConvByManager.delete(p);
      }

      const pending = pendingReplies.get(phoneRaw) || pendingReplies.get(phoneVariants[1]);
      if (pending) {
        pendingReplies.delete(phoneRaw);
        pendingReplies.delete(phoneVariants[1]);
        pending.resolver({ conversationId: convId, message: msg });
      }
    }
  });

  return sock;
}

export async function forceReconnect() {
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true });
  }
  if (connectCallbacks) {
    await connectWhatsApp(connectCallbacks.onQR, connectCallbacks.onReady, connectCallbacks.onDisconnect);
  }
}

export async function sendToManager(managerPhone, message, conversationId) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp not connected');
  }
  const jid = managerPhone.includes('@') ? managerPhone : `${managerPhone.replace(/\D/g, '')}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: message });
  return sent?.key?.id || null;
}

export function waitForReply(managerPhone, conversationId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(managerPhone);
      reject(new Error('Timeout waiting for reply'));
    }, timeoutMs);
    pendingReplies.set(managerPhone, {
      conversationId,
      resolver: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
    });
  });
}
