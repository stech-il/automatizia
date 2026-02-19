import express from 'express';
import bcrypt from 'bcryptjs';
import * as db from './db.js';
import * as whatsapp from './whatsapp.js';
import QRCode from 'qrcode';

const router = express.Router();

let currentQR = null;

export function setCurrentQR(qr) {
  currentQR = qr;
}

function requireAuth(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const admin = db.getAdminByUsername(username);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.admin = { username };
  res.json({ success: true });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
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

// Create new site
router.post('/sites', requireAuth, (req, res) => {
  const { manager_phone, site_name } = req.body;
  if (!manager_phone) {
    return res.status(400).json({ error: 'manager_phone required' });
  }
  const site = db.createSite(manager_phone, site_name || '');
  res.json({ success: true, site });
});

// Get QR for WhatsApp (returns SVG)
router.get('/qr', requireAuth, async (req, res) => {
  if (whatsapp.getConnectionStatus().connected) {
    return res.json({ connected: true, qr: null });
  }
  if (currentQR) {
    try {
      const svg = await QRCode.toString(currentQR, { type: 'svg' });
      return res.json({ connected: false, qr: svg });
    } catch (e) {
      return res.json({ connected: false, qr: null });
    }
  }
  res.json({ connected: false, qr: null, message: 'Connecting...' });
});

export { requireAuth };
export default router;
