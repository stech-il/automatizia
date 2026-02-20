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
    .qr-box { background: #fff; padding: 24px; border-radius: 12px; display: inline-block; margin: 15px 0; text-align: center; border: 3px solid #25D366; }
    .qr-box h3 { color: #111; margin: 0 0 12px 0; }
    .qr-box p { color: #666; font-size: 14px; margin: 12px 0 0 0; }
    #qr { display: block; min-width: 300px; min-height: 300px; }
    #qr img, #qr svg { display: block; margin: 0 auto; width: 320px; height: 320px; cursor: pointer; }
    .qr-open { margin-top: 12px; font-size: 13px; color: #25D366; }
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
    <div class="card qr-box" id="qrCard" style="display:none">
      <h3>📱 סרוק ברקוד לחיבור וואטסאפ</h3>
      <p>פתח וואטסאפ → הגדרות → מכשירים מקושרים → קישור מכשיר</p>
      <div id="qr"></div>
      <p class="qr-open">💡 לחיצה על הברקוד תפתח אותו בחלון חדש לסריקה נוחה יותר</p>
      <p>הברקוד מתחדש כל ~20 שניות – אם לא סרקת, יוצג ברקוד חדש</p>
      <button onclick="forceDisconnect()" style="margin-top:12px;background:#666">🔌 התנתק וסרוק ברקוד מחדש</button>
    </div>
    <div class="card" id="connectedCard" style="display:none">
      <p>וואטסאפ מחובר. לסריקת ברקוד חדש: <button onclick="forceDisconnect()" class="logout">התנתק</button></p>
    </div>
    <div class="card" id="leadsCard" style="border:1px solid #25D366">
      <h3>📋 לידים</h3>
      <p style="font-size:13px;color:#888;margin:-8px 0 10px 0">כל פנייה מהטופס נשמרת בשרת</p>
      <select id="leadsSiteFilter" onchange="loadLeads()" style="margin-bottom:10px;padding:8px;background:#222;color:#eee;border:1px solid #333;border-radius:6px;width:100%">
        <option value="">כל האתרים</option>
      </select>
      <div id="leadsList" style="max-height:250px;overflow-y:auto;font-size:14px;min-height:40px"></div>
      <button onclick="exportLeadsCsv()" style="margin-top:10px;background:#25D366;color:#000;font-size:13px">📥 ייצוא ל-CSV</button>
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
    function getHeaders() {
      const t = localStorage.getItem('adminToken');
      return t ? { 'Authorization': 'Bearer ' + t } : {};
    }
    async function login() {
      document.getElementById('loginError').textContent = '';
      const res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        localStorage.setItem('adminToken', data.token);
        loadDashboard();
      } else document.getElementById('loginError').textContent = data.error || 'שגיאה';
    }
    function logout() {
      fetch(API + '/logout', { method: 'POST', headers: getHeaders() });
      localStorage.removeItem('adminToken');
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
      const res = await fetch(API + '/status', { headers: getHeaders() });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      document.getElementById('waStatus').className = 'status ' + (data.whatsapp.connected ? 'connected' : 'disconnected');
      document.getElementById('waStatusText').textContent = data.whatsapp.connected ? 'וואטסאפ מחובר ✓' : 'וואטסאפ מנותק – סרוק ברקוד';
      document.getElementById('qrCard').style.display = data.whatsapp.connected ? 'none' : 'block';
      document.getElementById('connectedCard').style.display = data.whatsapp.connected ? 'block' : 'none';
      document.getElementById('sitesList').innerHTML = data.sites.map(s => 
        '<div class="site-item"><span>' + (s.site_name || '-') + '</span><span class="code">' + s.code + '</span><span>' + s.manager_phone + '</span></div>'
      ).join('') || '<p>אין אתרים</p>';
      const sel = document.getElementById('leadsSiteFilter');
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = '<option value="">כל האתרים</option>' + (data.sites.map(s => '<option value="' + s.code + '">' + (s.site_name || s.code) + '</option>').join(''));
        sel.value = cur || '';
      }
      loadLeads();
    }
    let leadsCache = [];
    async function loadLeads() {
      const site = document.getElementById('leadsSiteFilter')?.value || '';
      const res = await fetch(API + '/leads' + (site ? '?site_code=' + encodeURIComponent(site) : ''), { headers: getHeaders() });
      if (res.status === 401) return;
      const data = await res.json();
      leadsCache = data.leads || [];
      const el = document.getElementById('leadsList');
      if (!el) return;
      if (leadsCache.length === 0) el.innerHTML = '<p style="color:#888">אין לידים עדיין</p>';
      else el.innerHTML = leadsCache.map(l => 
        '<div class="site-item" style="border-bottom:1px solid #333;padding:10px 0;flex-direction:column;align-items:flex-start;gap:4px">' +
        '<span><strong>' + (l.visitor_name || '-') + '</strong> | ' + (l.visitor_phone || '-') + ' | ' + (l.site_name || l.site_code) + '</span>' +
        '<span style="color:#aaa;font-size:12px">' + l.message + '</span>' +
        '<span style="color:#666;font-size:11px">' + l.created_at + '</span>' +
        '</div>'
      ).join('');
    }
    function exportLeadsCsv() {
      if (leadsCache.length === 0) { alert('אין לידים לייצוא'); return; }
      const headers = ['שם','טלפון','הודעה','אתר','תאריך'];
      const rows = leadsCache.map(l => [
        (l.visitor_name || '').replace(/"/g,'""'),
        (l.visitor_phone || '').replace(/"/g,'""'),
        (l.message || '').replace(/"/g,'""'),
        (l.site_name || l.site_code || '').replace(/"/g,'""'),
        l.created_at || ''
      ].map(v => '"' + v + '"').join(','));
      const csv = '\ufeff' + headers.map(h => '"' + h + '"').join(',') + '\n' + rows.join('\n');
      const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'leads_' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }
    async function refreshQR() {
      const res = await fetch(API + '/qr', { headers: getHeaders() });
      if (res.status === 401) return;
      const data = await res.json();
      if (data.connected) return;
      const el = document.getElementById('qr');
      if (data.message) {
        el.innerHTML = '<p style="color:#888;padding:40px">⏳ ' + data.message + '</p>';
        return;
      }
      if (data.qr) {
        window.currentQRData = data.qr;
        window.currentQRFormat = data.format || 'svg';
        if (data.format === 'png') {
          el.innerHTML = '<img src="' + data.qr + '" alt="QR" title="לחץ להגדלה" onclick="openQRFullscreen()">';
        } else {
          el.innerHTML = data.qr;
        }
      }
    }
    async function addSite() {
      const phone = document.getElementById('managerPhone').value.trim();
      const name = document.getElementById('siteName').value.trim();
      if (!phone) { document.getElementById('addResult').textContent = 'הזן מספר טלפון'; return; }
      const res = await fetch(API + '/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
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
    async function forceDisconnect() {
      try {
        const res = await fetch(API + '/disconnect', { method: 'POST', headers: getHeaders() });
        const data = await res.json();
        if (data.success) {
          document.getElementById('qr').innerHTML = '<p style="color:#888;padding:40px">⏳ מתחבר מחדש – הברקוד יופיע בעוד כמה שניות</p>';
          setTimeout(refreshQR, 2000);
          setTimeout(refreshStatus, 2000);
        }
      } catch (e) {}
    }
    function openQRFullscreen() {
      const qr = window.currentQRData;
      if (!qr) return;
      const fmt = window.currentQRFormat || 'svg';
      const w = window.open('', '_blank', 'width=500,height=550');
      if (!w) return;
      if (fmt === 'png') {
        w.document.write('<html dir="rtl"><head><meta charset="UTF-8"><title>סריקת ברקוד</title></head><body style="margin:0;padding:20px;text-align:center;background:#fff"><h3>סרוק עם וואטסאפ</h3><img src="' + qr + '" style="width:400px;height:400px"><p>וואטסאפ - הגדרות - מכשירים מקושרים - קישור מכשיר</p></body></html>');
      } else {
        w.document.write('<html dir="rtl"><head><meta charset="UTF-8"><title>סריקת ברקוד</title></head><body style="margin:0;padding:20px;text-align:center;background:#fff"><h3>סרוק עם וואטסאפ</h3><div style="display:inline-block;background:#fff;padding:20px">' + qr + '</div><p>וואטסאפ - הגדרות - מכשירים מקושרים - קישור מכשיר</p></body></html>');
      }
    }
    (async function init() {
      const t = localStorage.getItem('adminToken');
      if (!t) return;
      const res = await fetch(API + '/status', { headers: { 'Authorization': 'Bearer ' + t } });
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
