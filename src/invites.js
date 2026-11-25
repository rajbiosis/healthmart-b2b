import { audit, queueMessage, withTx } from './db.js';
import { hashPassword, createSession } from './auth.js';
import { appLink, newToken, sha256, sendVerification } from './accounts.js';
import { validatePermissions } from './permissions.js';
import { templates } from './mailer.js';
import { HttpError, isEmail, isIndianPhone, int, str } from './util.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BULK = 200;

function parseEmails(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const cleaned = raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) throw new HttpError(422, 'कम से कम एक email दें');
  if (unique.length > MAX_BULK) throw new HttpError(422, `एक बार में अधिकतम ${MAX_BULK} emails`);
  const invalid = unique.filter((e) => !isEmail(e));
  if (invalid.length) throw new HttpError(422, `ये emails valid नहीं हैं: ${invalid.slice(0, 5).join(', ')}`);
  return unique;
}

function expiryFrom(days, now) {
  const d = int(days ?? 7, 'expires_days', { min: 1, max: 30 });
  return now + d * DAY;
}

function companyInfo(db, companyId) {
  return db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId);
}

function inviterName(db, userId) {
  return db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? 'Company owner';
}

/** Bulk email invites. Each email gets its own single-use link. Returns what was sent and what was skipped. */
export function createEmailInvites(db, appUrl, companyId, actorUserId, input, now = Date.now()) {
  const emails = parseEmails(input.emails);
  const permissions = validatePermissions(input.permissions ?? []);
  const expires = expiryFrom(input.expires_days, now);
  const company = companyInfo(db, companyId);
  const inviter = inviterName(db, actorUserId);

  const created = [];
  const skipped = [];
  withTx(db, () => {
    for (const email of emails) {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        skipped.push({ email, reason: 'यह email पहले से registered है' });
        continue;
      }
      if (db.prepare('SELECT 1 FROM team_invites WHERE company_id = ? AND email = ? AND revoked_at IS NULL AND used_count = 0 AND expires_at > ?').get(companyId, email, now)) {
        skipped.push({ email, reason: 'पहले से invite भेजा जा चुका है' });
        continue;
      }
      const token = newToken();
      const res = db
        .prepare('INSERT INTO team_invites(company_id,email,permissions,token_hash,invited_by,expires_at,max_uses) VALUES (?,?,?,?,?,?,1)')
        .run(companyId, email, JSON.stringify(permissions), sha256(token), actorUserId, expires);
      const link = appLink(appUrl, '/invite', { token });
      const m = templates.teamInvite({
        companyName: company.name,
        inviterName: inviter,
        link,
        expiresOn: new Date(expires).toISOString().slice(0, 10),
      });
      queueMessage(db, 'email', email, m.text, m.subject);
      audit(db, actorUserId, 'team.invite_sent', 'team_invite', Number(res.lastInsertRowid));
      created.push({ id: Number(res.lastInsertRowid), email, link });
    }
  });
  return { created, skipped };
}

/** Shareable link (WhatsApp, a notice, anywhere). Anyone with it can join with their own email. */
export function createLinkInvite(db, appUrl, companyId, actorUserId, input, now = Date.now()) {
  const permissions = validatePermissions(input.permissions ?? []);
  const maxUses = input.max_uses === undefined || input.max_uses === null ? null : int(input.max_uses, 'max_uses', { min: 1, max: 500 });
  const token = newToken();
  const res = db
    .prepare('INSERT INTO team_invites(company_id,email,permissions,token_hash,invited_by,expires_at,max_uses) VALUES (?,NULL,?,?,?,?,?)')
    .run(companyId, JSON.stringify(permissions), sha256(token), actorUserId, expiryFrom(input.expires_days, now), maxUses);
  audit(db, actorUserId, 'team.link_invite_created', 'team_invite', Number(res.lastInsertRowid));
  return { id: Number(res.lastInsertRowid), link: appLink(appUrl, '/invite', { token }), max_uses: maxUses };
}

function statusOf(row, now) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at < now) return 'expired';
  if (row.max_uses !== null && row.used_count >= row.max_uses) return 'used';
  return 'pending';
}

export function listInvites(db, companyId, now = Date.now()) {
  return db
    .prepare('SELECT * FROM team_invites WHERE company_id = ? ORDER BY id DESC LIMIT 300')
    .all(companyId)
    .map((r) => ({
      id: r.id,
      email: r.email,
      permissions: JSON.parse(r.permissions),
      status: statusOf(r, now),
      used_count: r.used_count,
      max_uses: r.max_uses,
      expires_at: new Date(r.expires_at).toISOString(),
    }));
}

export function revokeInvite(db, companyId, actorUserId, id) {
  const res = db
    .prepare("UPDATE team_invites SET revoked_at = datetime('now') WHERE id = ? AND company_id = ? AND revoked_at IS NULL AND used_count = 0")
    .run(id, companyId);
  if (res.changes !== 1) throw new HttpError(404, 'Invite नहीं मिला या already used/revoked है');
  audit(db, actorUserId, 'team.invite_revoked', 'team_invite', id);
  return { revoked: true };
}

/** Rotates the token and extends the expiry, then mails the new link again. */
export function resendInvite(db, appUrl, companyId, actorUserId, id, now = Date.now()) {
  const row = db.prepare('SELECT * FROM team_invites WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!row || !row.email || row.revoked_at || row.used_count > 0) {
    throw new HttpError(404, 'Email invite नहीं मिला या already used है');
  }
  const token = newToken();
  db.prepare('UPDATE team_invites SET token_hash = ?, expires_at = ? WHERE id = ?').run(sha256(token), now + 7 * DAY, id);
  const company = companyInfo(db, companyId);
  const m = templates.teamInvite({
    companyName: company.name,
    inviterName: inviterName(db, actorUserId),
    link: appLink(appUrl, '/invite', { token }),
    expiresOn: new Date(now + 7 * DAY).toISOString().slice(0, 10),
  });
  queueMessage(db, 'email', row.email, m.text, m.subject);
  return { resent: true };
}

function loadByToken(db, token, now) {
  const row = db.prepare('SELECT * FROM team_invites WHERE token_hash = ?').get(sha256(String(token ?? '')));
  if (!row || statusOf(row, now) !== 'pending') {
    throw new HttpError(400, 'Invite link invalid, expired या already used है');
  }
  return row;
}

/** Public preview for the join page. Shows the company name, never member data. */
export function previewInvite(db, token, now = Date.now()) {
  const row = loadByToken(db, token, now);
  const company = companyInfo(db, row.company_id);
  return {
    company_name: company.name,
    email: row.email,
    permissions: JSON.parse(row.permissions),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

/** Creates the member account and membership. Email invites are verified by the link itself. */
export function acceptInvite(db, appUrl, input, now = Date.now()) {
  const row = loadByToken(db, input.token, now);
  const name = str(input.name, 'name', { max: 100 });
  const phone = str(input.phone, 'phone', { min: 10, max: 10 });
  if (!isIndianPhone(phone)) throw new HttpError(422, 'phone valid 10-digit Indian number होना चाहिए');
  const password = str(input.password, 'password', { min: 10, max: 200 });
  const email = row.email ?? str(input.email, 'email', { max: 254 }).toLowerCase();
  if (!isEmail(email)) throw new HttpError(422, 'email invalid है');
  if (row.email && input.email && String(input.email).trim().toLowerCase() !== row.email) {
    throw new HttpError(422, 'यह invite किसी और email के लिए है');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'Email पहले से registered है। Login करें');
  }

  const result = withTx(db, () => {
    const userId = Number(
      db
        .prepare(
          `INSERT INTO users(name,email,phone,password_hash,role,email_verified_at)
           VALUES (?,?,?,?,'company_member', ${row.email ? "datetime('now')" : 'NULL'})`,
        )
        .run(name, email, phone, hashPassword(password)).lastInsertRowid,
    );
    db.prepare('INSERT INTO company_members(company_id,user_id,permissions) VALUES (?,?,?)').run(
      row.company_id,
      userId,
      row.permissions,
    );
    db.prepare('UPDATE team_invites SET used_count = used_count + 1 WHERE id = ?').run(row.id);
    audit(db, userId, 'team.joined', 'team_invite', row.id);
    return userId;
  });

  if (!row.email) sendVerification(db, appUrl, { id: result, name, email });
  const session = createSession(db, result);
  return { user: { id: result, name, email, role: 'company_member' }, token: session.token, expiresAt: session.expiresAt };
}
