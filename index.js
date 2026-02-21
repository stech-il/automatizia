import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import * as db from './src/db.js';
import * as whatsapp from './src/whatsapp.js';
import { lastConvByManager } from './src/convMap.js';
import apiRouter from './src/api.js';
import adminRouter, { setCurrentQR } from './src/admin.js';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create default admin if none exists
const admin = db.getAdminByUsername(process.env.ADMIN_USER || 'admin');
if (!admin) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASS || 'admin123', 10);
  db.createAdminUser(process.env.ADMIN_USER || 'admin', hash);
  console.log('Created default admin (change password in production!)');
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use('/api', apiRouter);
app.use('/admin', adminRouter);

// Serve admin panel
const adminPath = path.join(__dirname, 'admin.html');
const adminHtml = fs.readFileSync(adminPath, 'utf8');

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/admin', (req, res) => {
  res.type('html').send(adminHtml);
});

const PORT = process.env.PORT || 3000;
const INACTIVE_MINUTES = parseInt(process.env.CHAT_INACTIVE_MINUTES || '5', 10);

function runAutoCloseStaleChats() {
  try {
    const stale = db.getStaleConversations(INACTIVE_MINUTES);
    for (const c of stale) {
      const conv = db.getConversationById(c.id);
      if (conv) {
        const site = db.getAllSites().find(s => s.id === conv.site_id);
        if (site) {
          const mp = site.manager_phone.replace(/\D/g, '');
          lastConvByManager.delete(mp);
          if (mp.startsWith('972')) lastConvByManager.delete(mp.slice(3));
        }
      }
      db.closeConversation(c.id);
      db.clearManagerLastConvForConversation(c.id);
    }
    if (stale.length > 0) {
      console.log('[WPWAC] Auto-closed', stale.length, 'inactive conversation(s)');
    }
  } catch (e) {
    console.error('[WPWAC] Auto-close error:', e);
  }
}

async function start() {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Admin: http://localhost:' + PORT + '/admin');
    console.log('Auto-close: chats close after', INACTIVE_MINUTES, 'min of no customer response');
  });

  setInterval(runAutoCloseStaleChats, 60 * 1000);

  await whatsapp.connectWhatsApp(
    (qr) => {
      setCurrentQR(qr);
      qrcode.generate(qr, { small: true });
    },
    () => console.log('WhatsApp connected!'),
    (update) => console.log('WhatsApp disconnected:', update?.reason)
  );
}

start().catch(console.error);
