import { hashPassword } from './auth.js';
import { audit, withTx } from './db.js';
import { HttpError, isEmail, isIndianPhone, str } from './util.js';
import { validatePermissions } from './permissions.js';

export function listTeam(db, companyId) {
  return db
    .prepare(
      `SELECT m.user_id, u.name, u.email, u.phone, m.permissions, m.created_at
         FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? ORDER BY m.id`,
    )
    .all(companyId)
    .map((r) => ({ ...r, permissions: JSON.parse(r.permissions) }));
}

/** Owner or a member with team:manage creates a team member login directly. Invite flow comes in Phase 2. */
export function addMember(db, actorUserId, companyId, input) {
  const name = str(input.name, 'name', { max: 100 });
  const email = str(input.email, 'email', { max: 254 }).toLowerCase();
  if (!isEmail(email)) throw new HttpError(422, 'email invalid है');
  const phone = str(input.phone, 'phone', { min: 10, max: 10 });
  if (!isIndianPhone(phone)) throw new HttpError(422, 'phone valid 10-digit Indian number होना चाहिए');
  const password = str(input.password, 'password', { min: 10, max: 200 });
  const permissions = validatePermissions(input.permissions ?? []);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'Email पहले से registered है');
  }
  return withTx(db, () => {
    const userId = Number(
      db
        .prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?,'company_member')")
        .run(name, email, phone, hashPassword(password)).lastInsertRowid,
    );
    db.prepare('INSERT INTO company_members(company_id,user_id,permissions) VALUES (?,?,?)').run(
      companyId,
      userId,
      JSON.stringify(permissions),
    );
    audit(db, actorUserId, 'team.member_added', 'user', userId);
    return { user_id: userId, email, permissions };
  });
}

export function updateMemberPermissions(db, actorUserId, companyId, userId, input) {
  const permissions = validatePermissions(input.permissions);
  const res = db
    .prepare('UPDATE company_members SET permissions = ? WHERE company_id = ? AND user_id = ?')
    .run(JSON.stringify(permissions), companyId, userId);
  if (res.changes !== 1) throw new HttpError(404, 'Team member नहीं मिला');
  audit(db, actorUserId, 'team.permissions_changed', 'user', userId);
  return { user_id: userId, permissions };
}

export function removeMember(db, actorUserId, companyId, userId) {
  const res = withTx(db, () => {
    const r = db.prepare('DELETE FROM company_members WHERE company_id = ? AND user_id = ?').run(companyId, userId);
    if (r.changes === 1) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      audit(db, actorUserId, 'team.member_removed', 'user', userId);
    }
    return r;
  });
  if (res.changes !== 1) throw new HttpError(404, 'Team member नहीं मिला');
  return { removed: true };
}
