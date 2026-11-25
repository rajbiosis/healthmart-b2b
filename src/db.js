import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer','seller','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  gst_number TEXT NOT NULL UNIQUE,
  licence_type TEXT NOT NULL CHECK (licence_type IN ('drug_licence','md_licence','lab_registration','other')),
  licence_number TEXT NOT NULL,
  licence_expiry TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  composition TEXT NOT NULL DEFAULT '',
  pack_size TEXT NOT NULL DEFAULT '',
  batch_number TEXT NOT NULL DEFAULT '',
  expiry_date TEXT,
  schedule TEXT NOT NULL DEFAULT 'none' CHECK (schedule IN ('none','H','H1','X')),
  price_paise INTEGER CHECK (price_paise IS NULL OR price_paise >= 0),
  moq INTEGER NOT NULL DEFAULT 1 CHECK (moq >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','rejected','paused')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_live ON listings(status, category_id);
CREATE TABLE IF NOT EXISTS plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  lead_quota INTEGER NOT NULL,
  listing_limit INTEGER NOT NULL,
  duration_days INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  lead_quota INTEGER NOT NULL,
  leads_used INTEGER NOT NULL DEFAULT 0,
  listing_limit INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  buyer_email TEXT,
  buyer_city TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  product_query TEXT NOT NULL,
  quantity INTEGER,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lead_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','unlocked','contacted','converted','lost')),
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  unlocked_at TEXT,
  UNIQUE (enquiry_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_company ON lead_deliveries(company_id, status);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_PLANS = [
  // code, name, price_paise, lead_quota, listing_limit, duration_days
  ['starter', 'Starter', 99900, 20, 10, 30],
  ['growth', 'Growth', 249900, 100, 100, 30],
  ['pro', 'Pro', 599900, 500, 1000, 30],
];

const DEFAULT_CATEGORIES = [
  'Diagnostic Kits',
  'Lab Reagents',
  'Medical Devices',
  'Lab Equipment',
  'Surgical Consumables',
  'Hospital Supplies',
  'Pharmaceuticals (Non-Rx)',
];

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const insCat = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)');
  for (const name of DEFAULT_CATEGORIES) insCat.run(name);
  const insPlan = db.prepare(
    'INSERT OR IGNORE INTO plans(code,name,price_paise,lead_quota,listing_limit,duration_days) VALUES (?,?,?,?,?,?)',
  );
  for (const p of DEFAULT_PLANS) insPlan.run(...p);
}

/** Runs fn inside a transaction. Unique-constraint failures become 409 errors. */
export function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    if (/UNIQUE constraint/.test(err.message)) {
      throw new HttpError(409, 'Email या GST number पहले से registered है');
    }
    throw err;
  }
}

export function audit(db, actorUserId, action, entity, entityId) {
  db.prepare('INSERT INTO audit_log(actor_user_id,action,entity,entity_id) VALUES (?,?,?,?)').run(
    actorUserId ?? null,
    action,
    entity,
    entityId ?? null,
  );
}

/** Notifications are queued here; a sender worker (Phase 2) delivers them. */
export function queueMessage(db, channel, recipient, body) {
  db.prepare('INSERT INTO outbox(channel,recipient,body) VALUES (?,?,?)').run(channel, recipient, body);
}
