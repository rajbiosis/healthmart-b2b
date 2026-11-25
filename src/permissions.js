import { HttpError } from './util.js';

/**
 * Permissions a company owner can grant to team members (role `company_member`).
 * The owner (role `seller`) implicitly has all of them.
 */
export const PERMISSIONS = [
  'listings:manage', // create, edit, pause and resume listings; upload photos
  'leads:view', // see the lead inbox (masked) and quota usage
  'leads:unlock', // spend quota to reveal buyer contact
  'leads:update', // move leads to contacted, converted or lost
  'billing:manage', // buy plans
  'team:manage', // add, edit and remove team members
  'integrations:manage', // API keys and webhooks
];

/**
 * Resolves the company a logged-in user acts for, and checks a permission.
 * - seller (owner): the company they own, every permission.
 * - company_member: the company they belong to, only permissions granted to them.
 * Pass permission = null to only require membership.
 */
export function resolveCompany(db, user, permission = null) {
  if (!user) throw new HttpError(401, 'Login आवश्यक है');

  if (user.role === 'seller') {
    const company = db.prepare('SELECT * FROM companies WHERE owner_user_id = ?').get(user.id);
    if (!company) throw new HttpError(404, 'Company profile नहीं मिली');
    return { company, permissions: PERMISSIONS, isOwner: true };
  }

  if (user.role === 'company_member') {
    const row = db
      .prepare(
        `SELECT c.*, m.permissions AS granted FROM company_members m
           JOIN companies c ON c.id = m.company_id WHERE m.user_id = ?`,
      )
      .get(user.id);
    if (!row) throw new HttpError(403, 'Company से जुड़े नहीं हैं');
    const { granted, ...company } = row;
    const permissions = JSON.parse(granted);
    if (permission && !permissions.includes(permission)) {
      throw new HttpError(403, `इसके लिए permission चाहिए: ${permission}`);
    }
    return { company, permissions, isOwner: false };
  }

  throw new HttpError(403, 'Access नहीं है');
}

export function validatePermissions(list) {
  if (!Array.isArray(list)) throw new HttpError(422, 'permissions array होना चाहिए');
  const unknown = list.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length) throw new HttpError(422, `अज्ञात permissions: ${unknown.join(', ')}`);
  return [...new Set(list)];
}
