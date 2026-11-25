import { createHmac, createHash, randomBytes } from 'node:crypto';
import { audit } from './db.js';
import { HttpError, str } from './util.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const WEBHOOK_EVENTS = ['lead.delivered', 'lead.unlocked'];
const MAX_ATTEMPTS = 6;

// ---- API keys (CRM access) -------------------------------------------------

export function createApiKey(db, company, actorUserId, label) {
  const name = str(label, 'label', { max: 60 });
  const key = `hm_live_${randomBytes(24).toString('base64url')}`;
  const res = db
    .prepare('INSERT INTO api_keys(company_id,label,key_prefix,key_hash,created_by) VALUES (?,?,?,?,?)')
    .run(company.id, name, key.slice(0, 12), sha256(key), actorUserId);
  audit(db, actorUserId, 'api_key.created', 'api_key', Number(res.lastInsertRowid));
  // The full key is shown only once. Only its hash is stored.
  return { id: Number(res.lastInsertRowid), key, key_prefix: key.slice(0, 12), label: name };
}

export function listApiKeys(db, companyId) {
  return db
    .prepare(
      `SELECT id, label, key_prefix, created_at, revoked_at FROM api_keys
        WHERE company_id = ? ORDER BY id DESC`,
    )
    .all(companyId);
}

export function revokeApiKey(db, companyId, actorUserId, keyId) {
  const res = db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND company_id = ? AND revoked_at IS NULL")
    .run(keyId, companyId);
  if (res.changes !== 1) throw new HttpError(404, 'API key नहीं मिली या पहले से revoke है');
  audit(db, actorUserId, 'api_key.revoked', 'api_key', keyId);
  return { revoked: true };
}

/** Returns the company a bearer key belongs to, or null. */
export function companyForApiKey(db, authHeader) {
  const m = /^Bearer\s+(hm_live_[A-Za-z0-9_-]+)$/.exec(String(authHeader ?? ''));
  if (!m) return null;
  const row = db
    .prepare(
      `SELECT c.* FROM api_keys k JOIN companies c ON c.id = k.company_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .get(sha256(m[1]));
  return row ?? null;
}

// ---- Webhooks (push leads to CRM) -----------------------------------------

export function createWebhook(db, company, actorUserId, input) {
  const url = str(input.url, 'url', { max: 500 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(422, 'url invalid है');
  }
  const localDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(localDev && parsed.protocol === 'http:')) {
    throw new HttpError(422, 'Webhook URL https होना चाहिए');
  }
  const events = input.events ?? WEBHOOK_EVENTS;
  if (!Array.isArray(events) || events.length === 0 || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
    throw new HttpError(422, `events में सिर्फ़ ये हो सकते हैं: ${WEBHOOK_EVENTS.join(', ')}`);
  }
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const res = db
    .prepare('INSERT INTO webhook_endpoints(company_id,url,secret,events) VALUES (?,?,?,?)')
    .run(company.id, parsed.toString(), secret, JSON.stringify([...new Set(events)]));
  audit(db, actorUserId, 'webhook.created', 'webhook_endpoint', Number(res.lastInsertRowid));
  // Secret is returned only at creation; it is needed to verify signatures.
  return { id: Number(res.lastInsertRowid), url: parsed.toString(), events, secret };
}

export function listWebhooks(db, companyId) {
  return db
    .prepare('SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE company_id = ? ORDER BY id DESC')
    .all(companyId)
    .map((r) => ({ ...r, events: JSON.parse(r.events), active: Boolean(r.active) }));
}

export function deleteWebhook(db, companyId, actorUserId, id) {
  const res = db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND company_id = ?').run(id, companyId);
  if (res.changes !== 1) throw new HttpError(404, 'Webhook नहीं मिला');
  audit(db, actorUserId, 'webhook.deleted', 'webhook_endpoint', id);
  return { deleted: true };
}

/** Queues one delivery per active endpoint of the company that subscribed to this event. */
export function enqueueWebhook(db, companyId, event, data, now = Date.now()) {
  const endpoints = db
    .prepare('SELECT id, events FROM webhook_endpoints WHERE company_id = ? AND active = 1')
    .all(companyId);
  const payload = JSON.stringify({ event, created_at: new Date(now).toISOString(), data });
  const ins = db.prepare(
    "INSERT INTO webhook_deliveries(endpoint_id,event,payload,next_attempt_at) VALUES (?,?,?,?)",
  );
  for (const ep of endpoints) {
    if (!JSON.parse(ep.events).includes(event)) continue;
    ins.run(ep.id, event, payload, now);
  }
}

export function signPayload(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Sends due webhook deliveries. Failed attempts retry with backoff (30s, 60s, 120s ...)
 * and are marked failed after MAX_ATTEMPTS. Run from the server on an interval.
 */
export async function processWebhookQueue(db, { fetchImpl = globalThis.fetch, now = Date.now(), batch = 20 } = {}) {
  const due = db
    .prepare(
      `SELECT d.id, d.payload, d.attempts, e.url, e.secret FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND e.active = 1
        ORDER BY d.id LIMIT ?`,
    )
    .all(now, batch);

  let delivered = 0;
  for (const job of due) {
    const timestamp = String(now);
    const signature = signPayload(job.secret, timestamp, job.payload);
    let ok = false;
    let error = null;
    try {
      const res = await fetchImpl(job.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-healthmart-timestamp': timestamp,
          'x-healthmart-signature': `sha256=${signature}`,
        },
        body: job.payload,
        signal: AbortSignal.timeout(5000),
      });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err.message;
    }

    if (ok) {
      db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(job.id);
      delivered += 1;
    } else {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, error, job.id);
      } else {
        const next = now + 30_000 * 2 ** (attempts - 1);
        db.prepare('UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(
          attempts,
          next,
          error,
          job.id,
        );
      }
    }
  }
  return { attempted: due.length, delivered };
}
