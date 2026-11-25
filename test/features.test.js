import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { processWebhookQueue, signPayload } from '../src/integrations.js';

const FUTURE = '2030-12-31';
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let db, server, base, uploadDir, receiver, receiverUrl;
const received = [];

async function call(method, p, { body, cookie, auth } = {}) {
  const headers = {};
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  const res = await fetch(base + p, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
}

const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).cookie;

let gstCounter = 0;
function sellerBody(name, city = 'Delhi') {
  gstCounter += 1;
  const n = String(gstCounter).padStart(2, '0');
  return {
    role: 'seller',
    name,
    email: `${name.toLowerCase()}@example.com`,
    phone: '9876543210',
    password: 'seller-password-1',
    company_name: `${name} Labs`,
    gst_number: `07ABCDE12${n}F1Z5`,
    licence_type: 'md_licence',
    licence_number: `MD-${n}`,
    licence_expiry: FUTURE,
    city,
    state: 'Delhi',
    pincode: '110001',
  };
}

const catId = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

async function verifiedSellerWithLiveListing(adminCookie, name, title, category = 'Diagnostic Kits') {
  const reg = await call('POST', '/api/auth/register', { body: sellerBody(name) });
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE email = ?").run(`${name.toLowerCase()}@example.com`);
  const company = db
    .prepare('SELECT c.id FROM companies c JOIN users u ON u.id = c.owner_user_id WHERE u.email = ?')
    .get(`${name.toLowerCase()}@example.com`);
  await call('POST', `/api/admin/companies/${company.id}/status`, { cookie: adminCookie, body: { status: 'verified' } });
  const l = await call('POST', '/api/seller/listings', {
    cookie: reg.cookie,
    body: { title, category_id: catId(category), composition: 'Test composition', moq: 1 },
  });
  await call('POST', `/api/admin/listings/${l.data.id}/status`, { cookie: adminCookie, body: { status: 'live' } });
  return { cookie: reg.cookie, companyId: company.id, listingId: l.data.id, email: `${name.toLowerCase()}@example.com` };
}

function enquiry(overrides = {}) {
  return {
    buyer_name: 'Asha Buyer',
    buyer_phone: '9000022222',
    buyer_city: 'Delhi',
    category_id: catId('Diagnostic Kits'),
    product_query: 'Diagnostic kit for clinic',
    quantity: 10,
    consent: true,
    ...overrides,
  };
}

before(async () => {
  db = openDb(':memory:'); // free period is active by default on a fresh DB
  uploadDir = mkdtempSync(path.join(tmpdir(), 'hm-uploads-'));
  db.prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES ('Admin','admin@example.com','9999999999',?,'admin')").run(
    hashPassword('admin-password-1'),
  );
  server = createServer(createApp({ db, uploadDir, enquiryMax: 100, loginMax: 100 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, r));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => receiver.close(r));
});

test('launch: everyone can self-register, but company members and admins cannot', async () => {
  const buyer = await call('POST', '/api/auth/register', {
    body: { name: 'Buyer Two', email: 'buyer2@example.com', phone: '9123456781', password: 'buyer-password-2' },
  });
  assert.equal(buyer.status, 201);
  const distributor = await call('POST', '/api/auth/register', {
    body: { role: 'distributor', name: 'Dist One', email: 'dist1@example.com', phone: '9123456782', password: 'dist-password-1' },
  });
  assert.equal(distributor.status, 201);
  assert.equal(distributor.data.user.role, 'distributor');

  const member = await call('POST', '/api/auth/register', {
    body: { role: 'company_member', name: 'X', email: 'x@example.com', phone: '9123456783', password: 'member-password-1' },
  });
  assert.equal(member.status, 422);
  const adminSelf = await call('POST', '/api/auth/register', {
    body: { role: 'admin', name: 'X', email: 'y@example.com', phone: '9123456784', password: 'admin-password-9' },
  });
  assert.equal(adminSelf.status, 422);

  const program = await call('GET', '/api/program');
  assert.equal(program.data.is_free, true);
  assert.ok(program.data.free_until);
});

test('free period: lead reaches seller without a plan and unlocks at no charge', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Alpha', 'Alpha HbA1c Kit');

  const enq = await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'HbA1c kit bulk' }) });
  assert.equal(enq.status, 201);

  const leads = await call('GET', '/api/seller/leads', { cookie: s.cookie });
  assert.equal(leads.data.leads.length, 1);
  const lead = leads.data.leads[0];
  assert.equal(lead.locked, true);

  const unlock = await call('POST', `/api/seller/leads/${lead.id}/unlock`, { cookie: s.cookie });
  assert.equal(unlock.status, 200);
  assert.equal(unlock.data.lead.buyer_phone, '9000022222');

  const sub = await call('GET', '/api/seller/subscription', { cookie: s.cookie });
  assert.equal(sub.data.free_period.is_free, true);
  assert.equal(sub.data.subscription, null, 'no plan needed in free period');
});

test('buyer dashboard: a logged-in distributor sees their own enquiries', async () => {
  const cookie = await login('dist1@example.com', 'dist-password-1');
  const enq = await call('POST', '/api/enquiries', { cookie, body: enquiry({ product_query: 'Lab reagents for distributor' }) });
  assert.equal(enq.status, 201);
  const mine = await call('GET', '/api/me/enquiries', { cookie });
  assert.equal(mine.data.enquiries.length, 1);
  assert.ok(mine.data.enquiries[0].suppliers_reached >= 1);

  const anon = await call('GET', '/api/me/enquiries');
  assert.equal(anon.status, 401);
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const wrongRole = await call('GET', '/api/me/enquiries', { cookie: adminCookie });
  assert.equal(wrongRole.status, 403);
});

test('company team: separate role, granted permissions only', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Beta', 'Beta Glucose Strip');

  const added = await call('POST', '/api/seller/team', {
    cookie: s.cookie,
    body: {
      name: 'Team Member',
      email: 'member@beta.example',
      phone: '9123400001',
      password: 'member-password-1',
      permissions: ['leads:view'],
    },
  });
  assert.equal(added.status, 201);
  const bad = await call('POST', '/api/seller/team', {
    cookie: s.cookie,
    body: { name: 'T', email: 't@beta.example', phone: '9123400002', password: 'member-password-2', permissions: ['root:all'] },
  });
  assert.equal(bad.status, 422);

  const memberCookie = await login('member@beta.example', 'member-password-1');
  assert.equal((await call('GET', '/api/seller/leads', { cookie: memberCookie })).status, 200);
  assert.equal((await call('POST', '/api/seller/listings', { cookie: memberCookie, body: { title: 'X', category_id: catId('Lab Reagents') } })).status, 403);
  assert.equal((await call('GET', '/api/seller/team', { cookie: memberCookie })).status, 403);
  assert.equal((await call('POST', '/api/seller/webhooks', { cookie: memberCookie, body: { url: receiverUrl } })).status, 403);

  // Owner grants listings:manage; member can now create a listing.
  const memberId = db.prepare("SELECT id FROM users WHERE email = 'member@beta.example'").get().id;
  const upd = await call('PATCH', `/api/seller/team/${memberId}`, {
    cookie: s.cookie,
    body: { permissions: ['leads:view', 'listings:manage'] },
  });
  assert.equal(upd.status, 200);
  const created = await call('POST', '/api/seller/listings', {
    cookie: memberCookie,
    body: { title: 'Member listing', category_id: catId('Lab Reagents') },
  });
  assert.equal(created.status, 201);

  // Removing the member ends their access.
  const removed = await call('DELETE', `/api/seller/team/${memberId}`, { cookie: s.cookie });
  assert.equal(removed.status, 200);
  assert.equal((await call('GET', '/api/seller/leads', { cookie: memberCookie })).status, 401);
});

test('listing edit sends live listing back to review; pause and resume', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Gamma', 'Gamma Original Title');

  const edited = await call('PATCH', `/api/seller/listings/${s.listingId}`, { cookie: s.cookie, body: { title: 'Gamma New Title' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.needs_review, true);
  assert.equal(edited.data.status, 'pending');

  const hidden = await call('GET', '/api/search?q=Gamma');
  assert.equal(hidden.data.results.length, 0, 'pending edits are not searchable');

  await call('POST', `/api/admin/listings/${s.listingId}/status`, { cookie: adminCookie, body: { status: 'live' } });
  assert.equal((await call('GET', '/api/search?q=Gamma')).data.results.length, 1);

  const paused = await call('POST', `/api/seller/listings/${s.listingId}/pause`, { cookie: s.cookie });
  assert.equal(paused.data.status, 'paused');
  assert.equal((await call('GET', '/api/search?q=Gamma')).data.results.length, 0);

  const pausedAgain = await call('POST', `/api/seller/listings/${s.listingId}/pause`, { cookie: s.cookie });
  assert.equal(pausedAgain.data.status, 'paused', 'pause is idempotent');

  const resumed = await call('POST', `/api/seller/listings/${s.listingId}/resume`, { cookie: s.cookie });
  assert.equal(resumed.data.status, 'live');
  assert.equal((await call('GET', '/api/search?q=Gamma')).data.results.length, 1);

  const pendingPause = await call('POST', '/api/seller/listings', { cookie: s.cookie, body: { title: 'Draft', category_id: catId('Lab Equipment') } });
  const conflict = await call('POST', `/api/seller/listings/${pendingPause.data.id}/pause`, { cookie: s.cookie });
  assert.equal(conflict.status, 409, 'only live listings can be paused');
});

test('photos: valid image is stored and served; spoofed or non-image files are rejected', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Delta', 'Delta Photo Kit');

  const ok = await call('POST', `/api/seller/listings/${s.listingId}/images`, {
    cookie: s.cookie,
    body: { image: `data:image/png;base64,${PNG_1X1}` },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.images.length, 1);
  const url = ok.data.images[0].url;
  assert.ok(url.startsWith('/uploads/'));

  const served = await call('GET', url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');

  const search = await call('GET', '/api/search?q=Delta%20Photo');
  assert.equal(search.data.results[0].image_url, url);

  const jpegClaimPngBytes = await call('POST', `/api/seller/listings/${s.listingId}/images`, {
    cookie: s.cookie,
    body: { image: `data:image/jpeg;base64,${PNG_1X1}` },
  });
  assert.equal(jpegClaimPngBytes.status, 422, 'declared type must match the file bytes');

  const textFile = Buffer.from('hello world, not an image').toString('base64');
  const notImage = await call('POST', `/api/seller/listings/${s.listingId}/images`, {
    cookie: s.cookie,
    body: { image: `data:image/png;base64,${textFile}` },
  });
  assert.equal(notImage.status, 422);

  const svg = await call('POST', `/api/seller/listings/${s.listingId}/images`, {
    cookie: s.cookie,
    body: { image: `data:image/svg+xml;base64,${textFile}` },
  });
  assert.equal(svg.status, 422, 'SVG is not allowed');

  const traversal = await call('GET', '/uploads/..%2F..%2Fetc%2Fpasswd');
  assert.equal(traversal.status, 404);

  const removed = await call('DELETE', `/api/seller/listings/${s.listingId}/images/${ok.data.images[0].id}`, { cookie: s.cookie });
  assert.equal(removed.data.images.length, 0);
});

test('CRM API: key-based lead fetch, unlock and status; revoked key is refused', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Epsilon', 'Epsilon Reagent', 'Medical Devices');
  await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'Epsilon reagent order', category_id: catId('Medical Devices') }) });

  const key = await call('POST', '/api/seller/api-keys', { cookie: s.cookie, body: { label: 'Zoho CRM' } });
  assert.equal(key.status, 201);
  assert.match(key.data.key, /^hm_live_/);
  const auth = `Bearer ${key.data.key}`;

  assert.equal((await call('GET', '/api/v1/leads')).status, 401);
  assert.equal((await call('GET', '/api/v1/leads', { auth: 'Bearer hm_live_wrong' })).status, 401);

  const list = await call('GET', '/api/v1/leads?status=delivered', { auth });
  assert.equal(list.status, 200);
  const lead = list.data.leads.find((l) => l.product_query === 'Epsilon reagent order');
  assert.ok(lead);
  assert.equal(lead.buyer_phone, null, 'not unlocked yet, so no contact');

  const unlock = await call('POST', `/api/v1/leads/${lead.id}/unlock`, { auth });
  assert.equal(unlock.data.lead.buyer_phone, '9000022222');

  const status = await call('PATCH', `/api/v1/leads/${lead.id}`, { auth, body: { status: 'contacted' } });
  assert.equal(status.data.lead.status, 'contacted');

  const list2 = await call('GET', '/api/seller/api-keys', { cookie: s.cookie });
  assert.equal(list2.data.keys[0].key_prefix, key.data.key.slice(0, 12));
  assert.equal(list2.data.keys[0].key, undefined, 'full key is never returned again');

  const revoked = await call('DELETE', `/api/seller/api-keys/${key.data.id}`, { cookie: s.cookie });
  assert.equal(revoked.status, 200);
  assert.equal((await call('GET', '/api/v1/leads', { auth })).status, 401);
});

test('webhooks: lead.delivered is pushed with a verifiable HMAC signature', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Zeta', 'Zeta Analyser', 'Medical Devices');

  const hook = await call('POST', '/api/seller/webhooks', { cookie: s.cookie, body: { url: receiverUrl } });
  assert.equal(hook.status, 201);
  assert.match(hook.data.secret, /^whsec_/);

  const insecure = await call('POST', '/api/seller/webhooks', { cookie: s.cookie, body: { url: 'http://example.com/hook' } });
  assert.equal(insecure.status, 422, 'public webhook URLs must use https');

  const enq = await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'Zeta analyser for lab', category_id: catId('Medical Devices') }) });
  assert.equal(enq.status, 201);

  const before = received.length;
  const now = Date.now();
  const result = await processWebhookQueue(db, { now });
  assert.ok(result.delivered >= 1);
  assert.equal(received.length, before + result.delivered);

  const got = received[received.length - 1];
  const timestamp = got.headers['x-healthmart-timestamp'];
  const body = JSON.parse(got.body);
  assert.equal(body.event, 'lead.delivered');
  assert.equal(got.headers['x-healthmart-signature'], `sha256=${signPayload(hook.data.secret, timestamp, got.body)}`);
  assert.notEqual(got.headers['x-healthmart-signature'], `sha256=${signPayload('whsec_wrong', timestamp, got.body)}`);
});

test('webhooks: failed delivery is retried with backoff, then marked failed', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Eta', 'Eta Tester', 'Medical Devices');
  const closedPort = `http://127.0.0.1:1/hook`;
  await call('POST', '/api/seller/webhooks', { cookie: s.cookie, body: { url: closedPort } });
  await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'Eta tester kit', category_id: catId('Medical Devices') }) });

  const t0 = Date.now();
  const first = await processWebhookQueue(db, { now: t0 });
  assert.ok(first.attempted >= 1);
  const row = db
    .prepare("SELECT d.status, d.attempts, d.next_attempt_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE e.url = ? ORDER BY d.id DESC LIMIT 1")
    .get(closedPort);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > t0, 'next attempt is scheduled in the future');

  // Not due yet, so nothing is attempted before the backoff passes.
  const early = await processWebhookQueue(db, { now: t0 + 1000 });
  assert.equal(early.attempted, 0);

  // Exhaust attempts.
  let t = row.next_attempt_at;
  for (let i = 0; i < 10; i++) {
    await processWebhookQueue(db, { now: t + 1 });
    t += 10 * 60 * 60 * 1000;
  }
  const final = db
    .prepare("SELECT d.status FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE e.url = ? ORDER BY d.id DESC LIMIT 1")
    .get(closedPort);
  assert.equal(final.status, 'failed');
});

test('password change signs out other sessions', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Theta', 'Theta Item');
  const otherSession = await login(s.email, 'seller-password-1');

  const wrong = await call('POST', '/api/auth/change-password', { cookie: s.cookie, body: { current_password: 'not-right-pw', new_password: 'brand-new-pass-1' } });
  assert.equal(wrong.status, 401);

  const ok = await call('POST', '/api/auth/change-password', { cookie: s.cookie, body: { current_password: 'seller-password-1', new_password: 'brand-new-pass-1' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: otherSession })).status, 401, 'other session is revoked');
  assert.equal((await call('GET', '/api/me', { cookie: s.cookie })).status, 200, 'current session stays');
  assert.equal(await login(s.email, 'seller-password-1'), null);
  assert.ok(await login(s.email, 'brand-new-pass-1'));
});

test('after the free period ends, plans apply automatically and unpaid sellers get no leads', async () => {
  const adminCookie = await login('admin@example.com', 'admin-password-1');
  const s = await verifiedSellerWithLiveListing(adminCookie, 'Iota', 'Iota Kit');

  db.prepare("UPDATE settings SET value = ? WHERE key = 'free_period_ends_at'").run(new Date(0).toISOString());
  assert.equal((await call('GET', '/api/program')).data.is_free, false);

  await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'Iota kit after launch' }) });
  const leads = await call('GET', '/api/seller/leads', { cookie: s.cookie });
  assert.equal(leads.data.leads.filter((l) => l.product_query === 'Iota kit after launch').length, 0);

  // After buying a plan, the same kind of enquiry reaches the seller and unlock uses quota.
  const order = await call('POST', '/api/seller/orders', { cookie: s.cookie, body: { plan_code: 'starter' } });
  await call('POST', `/api/admin/orders/${order.data.id}/confirm`, { cookie: adminCookie, body: { provider_ref: 'pay_x' } });
  await call('POST', '/api/enquiries', { body: enquiry({ product_query: 'Iota kit paid', buyer_phone: '9000033333' }) });
  const paidLead = (await call('GET', '/api/seller/leads', { cookie: s.cookie })).data.leads.find((l) => l.product_query === 'Iota kit paid');
  assert.ok(paidLead);
  const unlocked = await call('POST', `/api/seller/leads/${paidLead.id}/unlock`, { cookie: s.cookie });
  assert.equal(unlocked.status, 200);
  const sub = await call('GET', '/api/seller/subscription', { cookie: s.cookie });
  assert.equal(sub.data.subscription.leads_used, 1);
});
