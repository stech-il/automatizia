import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import * as db from './src/db.js';
import * as whatsapp from './src/whatsapp.js';
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
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: true,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use('/api', apiRouter);
app.use('/admin', adminRouter);

// Serve admin panel
const adminHtml = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ניהול צ'אט וואטסאפ</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Segoe UI, Arial; margin: 0; padding: 20px; background: #111; color: #eee; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { color: #25D366; }
    .card { background: #1a1a1a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    input, button { padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #333; }
    input { width: 100%; margin-bottom: 10px; background: #222; color: #eee; }
    button { background: #25D366; color: #000; border: none; cursor: pointer; font-weight: bold; }
    button:hover { opacity: 0.9; }
    .error { color: #f44; }
    .success { color: #25D366; }
    #qr { background: #fff; padding: 20px; border-radius: 12px; display: inline-block; margin: 15px 0; }
    #qr img, #qr svg { display: block; }
    .site-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #333; }
    .code { font-family: monospace; background: #333; padding: 4px 8px; border-radius: 4px; }
    .logout { background: #444; color: #eee; }
    .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-left: 8px; }
    .status.connected { background: #25D366; }
    .status.disconnected { background: #f44; }
  </style>
</head>
<body>
  <div class="container" id="loginForm">
    <h1>כניסה לניהול</h1>
    <div class="card">
      <input type="text" id="username" placeholder="שם משתמש">
      <input type="password" id="password" placeholder="סיסמה">
      <button onclick="login()">התחבר</button>
      <p class="error" id="loginError"></p>
    </div>
  </div>
  <div class="container" id="dashboard" style="display:none">
    <h1>ניהול צ'אט וואטסאפ <span class="status" id="waStatus"></span></h1>
    <p id="waStatusText"></p>
    <div class="card" id="qrCard" style="display:none">
      <h3>סרוק ברקוד להתחברות</h3>
      <div id="qr"></div>
    </div>
    <div class="card">
      <h3>הוסף אתר חדש</h3>
      <input type="text" id="managerPhone" placeholder="מספר טלפון מנהל (לדוגמה 0501234567)">
      <input type="text" id="siteName" placeholder="שם האתר (אופציונלי)">
      <button onclick="addSite()">הוסף אתר</button>
      <p id="addResult"></p>
    </div>
    <div class="card">
      <h3>אתרים מחוברים</h3>
      <div id="sitesList"></div>
    </div>
    <button class="logout" onclick="logout()">התנתק</button>
  </div>
  <script>
    const API = '/admin';
    let statusInterval, qrInterval;
    async function login() {
      document.getElementById('loginError').textContent = '';
      const res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) loadDashboard();
      else document.getElementById('loginError').textContent = data.error || 'שגיאה';
    }
    function logout() {
      fetch(API + '/logout', { method: 'POST', credentials: 'include' });
      clearInterval(statusInterval);
      clearInterval(qrInterval);
      document.getElementById('loginForm').style.display = 'block';
      document.getElementById('dashboard').style.display = 'none';
    }
    async function loadDashboard() {
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      await refreshStatus();
      await refreshQR();
      statusInterval = setInterval(refreshStatus, 5000);
      qrInterval = setInterval(refreshQR, 3000);
    }
    async function refreshStatus() {
      const res = await fetch(API + '/status', { credentials: 'include' });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      document.getElementById('waStatus').className = 'status ' + (data.whatsapp.connected ? 'connected' : 'disconnected');
      document.getElementById('waStatusText').textContent = data.whatsapp.connected ? 'וואטסאפ מחובר ✓' : 'וואטסאפ מנותק – סרוק ברקוד';
      document.getElementById('qrCard').style.display = data.whatsapp.connected ? 'none' : 'block';
      document.getElementById('sitesList').innerHTML = data.sites.map(s => 
        '<div class="site-item"><span>' + (s.site_name || '-') + '</span><span class="code">' + s.code + '</span><span>' + s.manager_phone + '</span></div>'
      ).join('') || '<p>אין אתרים</p>';
    }
    async function refreshQR() {
      const res = await fetch(API + '/qr', { credentials: 'include' });
      if (res.status === 401) return;
      const data = await res.json();
      if (data.connected) return;
      if (data.qr) document.getElementById('qr').innerHTML = data.qr;
    }
    async function addSite() {
      const phone = document.getElementById('managerPhone').value.trim();
      const name = document.getElementById('siteName').value.trim();
      if (!phone) { document.getElementById('addResult').textContent = 'הזן מספר טלפון'; return; }
      const res = await fetch(API + '/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ manager_phone: phone, site_name: name })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('addResult').innerHTML = '<span class="success">נוסף! קוד האתר: <strong>' + data.site.code + '</strong></span>';
        document.getElementById('managerPhone').value = '';
        document.getElementById('siteName').value = '';
        refreshStatus();
      } else document.getElementById('addResult').textContent = data.error || 'שגיאה';
    }
    (async function init() {
      const res = await fetch(API + '/status', { credentials: 'include' });
      if (res.status === 200) loadDashboard();
    })();
  </script>
</body>
</html>
`;

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/admin', (req, res) => {
  res.type('html').send(adminHtml);
});

const PORT = process.env.PORT || 3000;

async function start() {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Admin: http://localhost:' + PORT + '/admin');
  });

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
