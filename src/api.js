import express from 'express';
import * as db from './db.js';
import * as whatsapp from './whatsapp.js';

const router = express.Router();

// Get site info by code (for plugin validation)
router.get('/site/:code', (req, res) => {
  const site = db.getSiteByCode(req.params.code);
  if (!site) {
    return res.status(404).json({ error: 'Site not found' });
  }
  res.json({
    code: site.code,
    site_name: site.site_name,
    status: whatsapp.getConnectionStatus(),
  });
});

// Send message from chat widget
router.post('/message', async (req, res) => {
  try {
    const { site_code, visitor_id, message } = req.body;
    if (!site_code || !visitor_id || !message) {
      return res.status(400).json({ error: 'Missing site_code, visitor_id or message' });
    }

    const site = db.getSiteByCode(site_code);
    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }

    if (!whatsapp.getConnectionStatus().connected) {
      return res.status(503).json({ error: 'WhatsApp not connected. Please scan QR code in admin.' });
    }

    const conv = db.getOrCreateConversation(site.id, visitor_id);
    db.addMessage(conv.id, 'outgoing', message);

    const phone = site.manager_phone.startsWith('972') ? site.manager_phone : `972${site.manager_phone}`;
    const fullPhone = phone.replace(/\D/g, '');
    const textToSend = `[${site.site_name || site.code}] ${message}`;
    await whatsapp.sendToManager(fullPhone, textToSend, conv.id);

    res.json({ success: true, conversation_id: conv.id });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: err.message || 'Failed to send' });
  }
});

// Get messages (polling from chat widget)
router.get('/messages', (req, res) => {
  const { site_code, visitor_id, since } = req.query;
  if (!site_code || !visitor_id) {
    return res.status(400).json({ error: 'Missing site_code or visitor_id' });
  }

  const site = db.getSiteByCode(site_code);
  if (!site) {
    return res.status(404).json({ error: 'Site not found' });
  }

  const conv = db.getOrCreateConversation(site.id, visitor_id);
  let messages = db.getConversationMessages(conv.id);

  if (since) {
    const sinceTime = parseInt(since, 10);
    messages = messages.filter(m => new Date(m.created_at).getTime() > sinceTime);
  }

  res.json({
    messages: messages.map(m => ({
      id: m.id,
      direction: m.direction,
      content: m.content,
      created_at: m.created_at,
    })),
  });
});

export default router;
