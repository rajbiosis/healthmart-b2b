export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 100_000;

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body बहुत बड़ा है'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'Invalid JSON'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject(new HttpError(400, 'JSON object भेजें'));
      }
      resolve(value);
    });
    req.on('error', reject);
  });
}

export function str(v, field, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw new HttpError(422, `${field} is required`);
  }
  if (typeof v !== 'string') throw new HttpError(422, `${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) {
    throw new HttpError(422, `${field} must be ${min}-${max} characters`);
  }
  return t;
}

export function int(v, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new HttpError(422, `${field} is required`);
  }
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(422, `${field} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export function oneOf(v, field, allowed) {
  if (!allowed.includes(v)) throw new HttpError(422, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const isIndianPhone = (s) => /^[6-9]\d{9}$/.test(s);
export const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PINCODE_RE = /^[1-9]\d{5}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fixed-window limiter kept in memory. Fine for one instance; use Redis when scaling out. */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= max;
  };
}
