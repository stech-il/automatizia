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
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.buttonsResponseMessage?.selectedButtonId
    || msg.listResponseMessage?.title
    || null;
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
      if (m.key.fromMe) continue;
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
        const sites = db.getAllSites();
        const site = sites.find(s => {
          const dbPhone = s.manager_phone.replace(/\D/g, '');
          return phoneVariants.some(p => dbPhone === p || dbPhone.endsWith(p) || p.endsWith(dbPhone));
        });
        if (!site) continue;
        const conv = db.getActiveConversationBySite(site.id);
        if (!conv) continue;
        convId = conv.id;
      }

      db.addMessage(convId, 'incoming', msg);

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
