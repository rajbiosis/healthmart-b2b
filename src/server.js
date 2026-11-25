import { createServer } from 'node:http';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createMailer, processOutbox } from './mailer.js';
import { processWebhookQueue } from './integrations.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data/healthmart.db';
const uploadDir = process.env.UPLOAD_DIR ?? './data/uploads';

const db = openDb(dbPath);
const mailer = createMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
const app = createApp({ db, uploadDir, secureCookies: process.env.NODE_ENV === 'production' });

// Background workers, in-process for Phase 1.
const timers = [
  setInterval(() => processWebhookQueue(db).catch((e) => console.error('webhook worker', e)), 5_000),
  setInterval(() => processOutbox(db, mailer).catch((e) => console.error('mail worker', e)), 10_000),
];
timers.forEach((t) => t.unref());

if (mailer.dryRun) console.log('Email dry-run: RESEND_API_KEY नहीं है, emails सिर्फ़ outbox में रहेंगे');

createServer(app).listen(port, () => {
  console.log(`HealthMart B2B listening on http://localhost:${port} (db: ${dbPath})`);
});
