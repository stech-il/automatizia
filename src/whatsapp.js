import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wa_auth');

let sock = null;
let isConnected = false;
const pendingReplies = new Map();

export function getConnectionStatus() {
  return { connected: isConnected };
}

export async function connectWhatsApp(onQR, onReady, onDisconnect) {
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
      onDisconnect?.(update);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const msg = m.message?.conversation || m.message?.extendedTextMessage?.text;
      if (!msg) continue;
      const fromJid = m.key.remoteJid;
      const phone = fromJid.replace('@s.whatsapp.net', '');

      const sites = db.getAllSites();
      const site = sites.find(s => {
        const dbPhone = s.manager_phone.replace(/\D/g, '');
        const incomingPhone = phone.replace(/\D/g, '');
        return dbPhone === incomingPhone || dbPhone.endsWith(incomingPhone) || incomingPhone.endsWith(dbPhone);
      });
      if (!site) continue;

      const conv = db.getActiveConversationBySite(site.id);
      if (!conv) continue;

      db.addMessage(conv.id, 'incoming', msg);

      const pending = pendingReplies.get(phone);
      if (pending) {
        pendingReplies.delete(phone);
        pending.resolver({ conversationId: conv.id, message: msg });
      }
    }
  });

  return sock;
}

export async function sendToManager(managerPhone, message, conversationId) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp not connected');
  }
  const jid = managerPhone.includes('@') ? managerPhone : `${managerPhone.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
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
