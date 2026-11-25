import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, createSession } from './auth.js';
import { queueMessage, withTx, audit } from './db.js';
import { HttpError, str } from './util.js';
import { templates } from './mailer.js';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const HOUR = 60 * 60 * 1000;

export function appLink(appUrl, hashPath, params) {
  const q = new URLSearchParams(params).toString();
  return `${appUrl.replace(/\/$/, '')}/#${hashPath}?${q}`;
}

/** Creates a single-use token for verify_email or reset_password. Previous unused tokens of that purpose are voided. */
export function issueUserToken(db, userId, purpose, ttlMs) {
  db.prepare("UPDATE one_time_tokens SET used_at = datetime('now') WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(
    userId,
    purpose,
  );
  const token = newToken();
  db.prepare('INSERT INTO one_time_tokens(user_id,purpose,token_hash,expires_at) VALUES (?,?,?,?)').run(
    userId,
    purpose,
    sha256(token),
    Date.now() + ttlMs,
  );
  return token;
}

function consumeUserToken(db, token, purpose, now = Date.now()) {
  const row = db
    .prepare('SELECT id, user_id, expires_at, used_at FROM one_time_tokens WHERE token_hash = ? AND purpose = ?')
    .get(sha256(String(token ?? '')), purpose);
  if (!row || row.used_at || row.expires_at < now) {
    throw new HttpError(400, 'Link invalid या expired है। नया link मँगाएँ');
  }
  db.prepare("UPDATE one_time_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row.user_id;
}

export function sendVerification(db, appUrl, user) {
  const token = issueUserToken(db, user.id, 'verify_email', 48 * HOUR);
  const link = appLink(appUrl, '/verify', { token });
  const m = templates.verifyEmail({ name: user.name, link });
  queueMessage(db, 'email', user.email, m.text, m.subject);
}

export function verifyEmail(db, token) {
  const userId = consumeUserToken(db, token, 'verify_email');
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ? AND email_verified_at IS NULL").run(userId);
  return { verified: true };
}

export function resendVerification(db, appUrl, user) {
  const row = db.prepare('SELECT id, name, email, email_verified_at FROM users WHERE id = ?').get(user.id);
  if (row.email_verified_at) return { already_verified: true };
  sendVerification(db, appUrl, row);
  return { sent: true };
}

/** Always answers the same way, so the endpoint cannot be used to find registered emails. */
export function requestPasswordReset(db, appUrl, email) {
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
  if (user) {
    const token = issueUserToken(db, user.id, 'reset_password', HOUR);
    const m = templates.resetPassword({ name: user.name, link: appLink(appUrl, '/reset', { token }) });
    queueMessage(db, 'email', user.email, m.text, m.subject);
  }
  return { ok: true, message: 'अगर यह email registered है, तो reset link भेज दिया गया है।' };
}

export function resetPassword(db, token, newPassword) {
  const password = str(newPassword, 'new_password', { min: 10, max: 200 });
  return withTx(db, () => {
    const userId = consumeUserToken(db, token, 'reset_password');
    db.prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(
      hashPassword(password),
      userId,
    );
    // Reset signs out every device, including the one that asked.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    audit(db, userId, 'auth.password_reset', 'user', userId);
    return { ok: true };
  });
}

export function startSession(db, userId) {
  return createSession(db, userId);
}
