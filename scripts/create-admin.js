// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' ADMIN_NAME='Name' npm run create-admin
import { hashPassword } from '../src/auth.js';
import { openDb } from '../src/db.js';

const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME = 'Admin', DB_PATH = './data/healthmart.db' } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) {
  console.error('ADMIN_EMAIL और ADMIN_PASSWORD (10+ chars) दें');
  process.exit(1);
}

const db = openDb(DB_PATH);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL.toLowerCase());
if (existing) {
  console.log('Admin पहले से मौजूद है');
} else {
  db.prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?, 'admin')").run(
    ADMIN_NAME,
    ADMIN_EMAIL.toLowerCase(),
    '9999999999',
    hashPassword(ADMIN_PASSWORD),
  );
  console.log(`Admin बन गया: ${ADMIN_EMAIL}`);
}
