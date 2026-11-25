import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const APP_URL = 'https://healthmart.test';
let db, server, base;

async function call(method, p, { body, cookie } = {}) {
  const headers = {};
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const setCookie = res.headers.get('set-cookie');
  const data = await res.json();
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

/** Reads the newest email to an address from the outbox and pulls the token out of its link. */
function tokenFor(recipient, { index = 0 } = {}) {
  const rows = db
    .prepare("SELECT body FROM outbox WHERE recipient = ? AND channel = 'email' ORDER BY id DESC")
    .all(recipient);
  const m = /token=([A-Za-z0-9_-]+)/.exec(rows[index]?.body ?? '');
  assert.ok(m, `no token email for ${recipient}`);
  return m[1];
}

const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).cookie;

const sellerBody = (email, gst) => ({
  role: 'seller',
  name: 'Owner Person',
  email,
  phone: '9876500001',
  password: 'owner-password-1',
  company_name: 'Owner Labs',
  gst_number: gst,
  licence_type: 'md_licence',
  licence_number: 'MD-OWN-1',
  licence_expiry: '2030-12-31',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
});

before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES ('Admin','admin@example.com','9999999999',?,'admin')").run(
    hashPassword('admin-password-1'),
  );
  const app = createApp({
    db,
    uploadDir: mkdtempSync(path.join(tmpdir(), 'hm-acc-')),
    appUrl: APP_URL,
    enquiryMax: 100,
    loginMax: 100,
    resetMax: 100,
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('email verification: unverified owner is blocked from company routes until verified', async () => {
  const reg = await call('POST', '/api/auth/register', { body: sellerBody('owner@example.com', '27ABCDE1234F1Z5') });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.email_verified_at, null);

  // Status is readable so the dashboard can show a banner.
  const company = await call('GET', '/api/seller/company', { cookie: reg.cookie });
  assert.equal(company.status, 200);

  const blocked = await call('GET', '/api/seller/listings', { cookie: reg.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'EMAIL_NOT_VERIFIED');

  const token = tokenFor('owner@example.com');
  const bad = await call('POST', '/api/auth/verify-email', { body: { token: 'not-a-real-token' } });
  assert.equal(bad.status, 400);

  const ok = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/seller/listings', { cookie: reg.cookie })).status, 200);

  const reuse = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert.equal(reuse.status, 400, 'a verification link works once');

  const again = await call('POST', '/api/auth/resend-verification', { cookie: reg.cookie, body: {} });
  assert.equal(again.data.already_verified, true);
});

test('forgot password: same answer for known and unknown emails; reset revokes all sessions', async () => {
  const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE recipient = 'nobody@example.com'").get().c, 0);

  const known = await call('POST', '/api/auth/forgot-password', { body: { email: 'owner@example.com' } });
  assert.equal(known.data.ok, unknown.data.ok);
  assert.equal(known.data.message, unknown.data.message, 'answers must not reveal registration');

  const oldSession = await login('owner@example.com', 'owner-password-1');
  const token = tokenFor('owner@example.com');

  const short = await call('POST', '/api/auth/reset-password', { body: { token, new_password: 'short' } });
  assert.equal(short.status, 422);

  const reset = await call('POST', '/api/auth/reset-password', { body: { token, new_password: 'brand-new-owner-pw' } });
  assert.equal(reset.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: oldSession })).status, 401, 'old sessions are gone');
  assert.equal(await login('owner@example.com', 'owner-password-1'), null);
  assert.ok(await login('owner@example.com', 'brand-new-owner-pw'));

  const reuse = await call('POST', '/api/auth/reset-password', { body: { token, new_password: 'another-password-2' } });
  assert.equal(reuse.status, 400, 'reset links work once');
});

test('bulk email invites: many addresses, skips for existing and duplicate, every invitee gets a notice', async () => {
  const ownerCookie = await login('owner@example.com', 'brand-new-owner-pw');
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const company = db.prepare("SELECT id FROM companies WHERE owner_user_id = (SELECT id FROM users WHERE email='owner@example.com')").get();
  await call('POST', `/api/admin/companies/${company.id}/status`, { cookie: adminCookie, body: { status: 'verified' } });

  const res = await call('POST', '/api/seller/invites', {
    cookie: ownerCookie,
    body: {
      emails: 'staff1@example.com, staff2@example.com;STAFF1@example.com\nowner@example.com',
      permissions: ['leads:view', 'leads:unlock'],
    },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.created.map((c) => c.email), ['staff1@example.com', 'staff2@example.com']);
  assert.equal(res.data.skipped.length, 1, 'duplicates collapse; registered emails are skipped');
  assert.match(res.data.skipped[0].reason, /registered/);
  assert.ok(res.data.created[0].link.startsWith(`${APP_URL}/#/invite?token=`));

  for (const e of ['staff1@example.com', 'staff2@example.com']) {
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE recipient = ? AND subject LIKE '%HealthMart%टीम%'").get(e).c, 1);
  }

  const dupe = await call('POST', '/api/seller/invites', { cookie: ownerCookie, body: { emails: 'staff1@example.com', permissions: [] } });
  assert.equal(dupe.data.created.length, 0);
  assert.match(dupe.data.skipped[0].reason, /पहले से/);

  const invalid = await call('POST', '/api/seller/invites', { cookie: ownerCookie, body: { emails: 'ok@example.com, not-an-email', permissions: [] } });
  assert.equal(invalid.status, 422, 'one bad address refuses the whole batch');

  const list = await call('GET', '/api/seller/invites', { cookie: ownerCookie });
  assert.equal(list.data.invites.filter((i) => i.status === 'pending').length, 2);
});

test('accepting an email invite creates a team member with the granted permissions only', async () => {
  const ownerCookie = await login('owner@example.com', 'brand-new-owner-pw');
  const token = tokenFor('staff1@example.com');

  const preview = await call('GET', `/api/invites/preview?token=${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.company_name, 'Owner Labs');
  assert.deepEqual(preview.data.permissions, ['leads:view', 'leads:unlock']);

  const accepted = await call('POST', '/api/auth/accept-invite', {
    body: { token, name: 'Staff One', phone: '9123400011', password: 'staff-password-1' },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.user.role, 'company_member');
  const staffCookie = accepted.cookie;

  assert.equal((await call('GET', '/api/seller/leads', { cookie: staffCookie })).status, 200);
  assert.equal((await call('POST', '/api/seller/listings', { cookie: staffCookie, body: { title: 'x', category_id: 1 } })).status, 403);

  const again = await call('POST', '/api/auth/accept-invite', {
    body: { token, name: 'Staff Clone', phone: '9123400012', password: 'staff-password-2' },
  });
  assert.equal(again.status, 400, 'invite is single-use');

  // Revoke works on pending invites, and a used invite cannot be revoked.
  const invites = (await call('GET', '/api/seller/invites', { cookie: ownerCookie })).data.invites;
  const used = invites.find((i) => i.email === 'staff1@example.com');
  assert.equal(used.status, 'used');
  const pending = invites.find((i) => i.email === 'staff2@example.com');
  assert.equal((await call('DELETE', `/api/seller/invites/${pending.id}`, { cookie: ownerCookie })).status, 200);
  assert.equal((await call('DELETE', `/api/seller/invites/${used.id}`, { cookie: ownerCookie })).status, 404);
  const revokedToken = tokenFor('staff2@example.com');
  assert.equal((await call('GET', `/api/invites/preview?token=${revokedToken}`)).status, 400);
});

test('resend rotates the link: the old one stops working', async () => {
  const ownerCookie = await login('owner@example.com', 'brand-new-owner-pw');
  // A fresh invite is created because staff2 was revoked in the previous test.
  const fresh = await call('POST', '/api/seller/invites', { cookie: ownerCookie, body: { emails: 'staff3@example.com', permissions: ['leads:view'] } });
  assert.equal(fresh.data.created.length, 1);
  const first = tokenFor('staff3@example.com');
  const resent = await call('POST', `/api/seller/invites/${fresh.data.created[0].id}/resend`, { cookie: ownerCookie, body: {} });
  assert.equal(resent.status, 200);
  const newToken = tokenFor('staff3@example.com');
  assert.notEqual(first, newToken);
  assert.equal((await call('GET', `/api/invites/preview?token=${first}`)).status, 400);
  assert.equal((await call('GET', `/api/invites/preview?token=${newToken}`)).status, 200);
});

test('shareable link invite: several people can join with their own email, then must verify it', async () => {
  const ownerCookie = await login('owner@example.com', 'brand-new-owner-pw');
  const made = await call('POST', '/api/seller/invites/link', {
    cookie: ownerCookie,
    body: { permissions: ['leads:view'], max_uses: 2, expires_days: 7 },
  });
  assert.equal(made.status, 201);
  const token = new URL(made.data.link.replace('/#', '')).searchParams.get('token');

  const joinA = await call('POST', '/api/auth/accept-invite', {
    body: { token, email: 'linka@example.com', name: 'Link A', phone: '9123400021', password: 'link-password-a1' },
  });
  assert.equal(joinA.status, 201);
  assert.equal((await call('GET', '/api/seller/leads', { cookie: joinA.cookie })).data.code, 'EMAIL_NOT_VERIFIED');
  const aToken = tokenFor('linka@example.com');
  await call('POST', '/api/auth/verify-email', { body: { token: aToken } });
  assert.equal((await call('GET', '/api/seller/leads', { cookie: joinA.cookie })).status, 200);

  const joinB = await call('POST', '/api/auth/accept-invite', {
    body: { token, email: 'linkb@example.com', name: 'Link B', phone: '9123400022', password: 'link-password-b1' },
  });
  assert.equal(joinB.status, 201);

  const joinC = await call('POST', '/api/auth/accept-invite', {
    body: { token, email: 'linkc@example.com', name: 'Link C', phone: '9123400023', password: 'link-password-c1' },
  });
  assert.equal(joinC.status, 400, 'link stops after max_uses');

  const invites = (await call('GET', '/api/seller/invites', { cookie: ownerCookie })).data.invites;
  const linkRow = invites.find((i) => i.email === null && i.max_uses === 2);
  assert.equal(linkRow.status, 'used');
  assert.equal(linkRow.used_count, 2);
});

test('payment: order returns a manual checkout; online gateway is off until launch', async () => {
  const ownerCookie = await login('owner@example.com', 'brand-new-owner-pw');
  const order = await call('POST', '/api/seller/orders', { cookie: ownerCookie, body: { plan_code: 'growth' } });
  assert.equal(order.status, 201);
  assert.equal(order.data.checkout.provider, 'manual');

  const plans = await call('GET', '/api/plans');
  assert.ok(plans.data.payment_providers.some((p) => p.name === 'razorpay' && p.enabled === false));

  const hook = await call('POST', '/api/payments/webhook/razorpay', { body: { event: 'payment.captured' } });
  assert.equal(hook.status, 501);
});
