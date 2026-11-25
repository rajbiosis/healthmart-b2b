import { createServer } from 'node:http';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data/healthmart.db';
const db = openDb(dbPath);
const app = createApp({ db, secureCookies: process.env.NODE_ENV === 'production' });

createServer(app).listen(port, () => {
  console.log(`HealthMart B2B listening on http://localhost:${port} (db: ${dbPath})`);
});
