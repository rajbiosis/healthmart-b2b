import { createServer } from 'node:http';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { processWebhookQueue } from './integrations.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data/healthmart.db';
const uploadDir = process.env.UPLOAD_DIR ?? './data/uploads';

const db = openDb(dbPath);
const app = createApp({ db, uploadDir, secureCookies: process.env.NODE_ENV === 'production' });

// Webhook worker: delivers queued CRM events with retries. Runs in-process for Phase 1.
const workerTimer = setInterval(() => {
  processWebhookQueue(db).catch((err) => console.error('webhook worker error', err));
}, 5_000);
workerTimer.unref();

createServer(app).listen(port, () => {
  console.log(`HealthMart B2B listening on http://localhost:${port} (db: ${dbPath})`);
});
