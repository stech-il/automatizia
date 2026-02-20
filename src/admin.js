import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as db from './db.js';
import * as whatsapp from './whatsapp.js';
import QRCode from 'qrcode';

const router = express.Router();

let currentQR = null;

export function setCurrentQR(qr) {
  currentQR = qr;
}

function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token || '';
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  if (token && db.isValidToken(token)) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Login - returns token (no cookies/session)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const admin = db.getAdminByUsername(username);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.createToken(token);
  res.json({ success: true, token });
});

// Logout - invalidate token
router.post('/logout', (req, res) => {
  const token = getToken(req);
  if (token) db.deleteToken(token);
  res.json({ success: true });
});

// Get status
router.get('/status', requireAuth, (req, res) => {
  res.json({
    whatsapp: whatsapp.getConnectionStatus(),
    sites: db.getAllSites().map(s => ({
      id: s.id,
      code: s.code,
      manager_phone: s.manager_phone,
      site_name: s.site_name,
      created_at: s.created_at,
    })),
  });
});

// Get leads
router.get('/leads', requireAuth, (req, res) => {
  const siteCode = req.query.site_code || null;
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  const leads = db.getAllLeads(siteCode, limit);
  res.json({ leads });
});

// Create new site
router.post('/sites', requireAuth, (req, res) => {
  const { manager_phone, site_name } = req.body;
  if (!manager_phone) {
    return res.status(400).json({ error: 'manager_phone required' });
  }
  const site = db.createSite(manager_phone, site_name || '');
  res.json({ success: true, site });
});

// Get QR for WhatsApp (returns SVG or PNG)
router.get('/qr', requireAuth, async (req, res) => {
  if (whatsapp.getConnectionStatus().connected) {
    return res.json({ connected: true, qr: null });
  }
  if (currentQR) {
    try {
      const format = req.query.format || 'svg';
      if (format === 'png') {
        const dataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
        return res.json({ connected: false, qr: dataUrl, format: 'png' });
      }
      const svg = await QRCode.toString(currentQR, { type: 'svg', width: 350 });
      return res.json({ connected: false, qr: svg, format: 'svg' });
    } catch (e) {
      console.error('QR generation error:', e.message);
      return res.json({ connected: false, qr: null });
    }
  }
  res.json({ connected: false, qr: null, message: 'Connecting...' });
});

// Force disconnect - clears auth and requires new QR scan
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    setCurrentQR(null);
    await whatsapp.forceReconnect();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { requireAuth };
export default router;
