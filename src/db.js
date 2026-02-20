import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'bridge.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    manager_phone TEXT NOT NULL,
    site_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    visitor_id TEXT NOT NULL,
    visitor_name TEXT,
    visitor_phone TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sites_code ON sites(code);
  CREATE INDEX IF NOT EXISTS idx_conversations_site ON conversations(site_id);
`);

try {
  db.prepare('ALTER TABLE conversations ADD COLUMN visitor_name TEXT').run();
} catch (e) {}
try {
  db.prepare('ALTER TABLE conversations ADD COLUMN visitor_phone TEXT').run();
} catch (e) {}

export function getSiteByCode(code) {
  return db.prepare('SELECT * FROM sites WHERE code = ?').get(code);
}

export function createSite(managerPhone, siteName = '') {
  const code = generateCode();
  db.prepare('INSERT INTO sites (code, manager_phone, site_name) VALUES (?, ?, ?)')
    .run(code, normalizePhone(managerPhone), siteName);
  return { ...getSiteByCode(code) };
}

export function getOrCreateConversation(siteId, visitorId, visitorName = '', visitorPhone = '') {
  let conv = db.prepare(
    'SELECT * FROM conversations WHERE site_id = ? AND visitor_id = ? AND status = ?'
  ).get(siteId, visitorId, 'active');

  if (!conv) {
    db.prepare('INSERT INTO conversations (site_id, visitor_id, visitor_name, visitor_phone) VALUES (?, ?, ?, ?)')
      .run(siteId, visitorId, visitorName || null, visitorPhone || null);
    conv = db.prepare(
      'SELECT * FROM conversations WHERE site_id = ? AND visitor_id = ? ORDER BY id DESC'
    ).get(siteId, visitorId);
  } else if (visitorName || visitorPhone) {
    db.prepare('UPDATE conversations SET visitor_name = COALESCE(?, visitor_name), visitor_phone = COALESCE(?, visitor_phone) WHERE id = ?')
      .run(visitorName || null, visitorPhone || null, conv.id);
  }
  return conv;
}

export function addMessage(conversationId, direction, content) {
  db.prepare('INSERT INTO messages (conversation_id, direction, content) VALUES (?, ?, ?)')
    .run(conversationId, direction, content);
}

export function getConversationMessages(conversationId) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at')
    .all(conversationId);
}

export function getAllSites() {
  return db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all();
}

export function getActiveConversationBySite(siteId) {
  return db.prepare(
    'SELECT * FROM conversations WHERE site_id = ? AND status = ? ORDER BY id DESC LIMIT 1'
  ).get(siteId, 'active');
}

export function getConversationById(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function createAdminUser(username, passwordHash) {
  try {
    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return true;
  } catch (e) {
    return false;
  }
}

export function getAdminByUsername(username) {
  return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
}

export function createToken(token) {
  db.prepare('INSERT INTO admin_tokens (token) VALUES (?)').run(token);
}

export function isValidToken(token) {
  return db.prepare('SELECT 1 FROM admin_tokens WHERE token = ?').get(token);
}

export function deleteToken(token) {
  db.prepare('DELETE FROM admin_tokens WHERE token = ?').run(token);
}

function generateCode() {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (getSiteByCode(code)) return generateCode();
  return code;
}

function normalizePhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '972' + p.slice(1);
  else if (!p.startsWith('972')) p = '972' + p;
  return p;
}
