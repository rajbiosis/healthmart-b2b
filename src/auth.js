import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

/** Only the SHA-256 of the token is stored, so a leaked DB does not leak live sessions. */
export function createSession(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(
    sha256(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

export function getSessionUser(db, token, now = Date.now()) {
  if (!token) return null;
  const hashed = sha256(token);
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.email_verified_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashed);
  if (!row) return null;
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashed);
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    email_verified_at: row.email_verified_at,
  };
}

export function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function revokeOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken ?? ''));
}
