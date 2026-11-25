import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let db, server, base;
const FUTURE = '2030-12-31';

async function call(method, path, { body, cookie } = {}) {
  const headers = {};
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

function sellerPayload(suffix, city = 'Delhi') {
  return {
    role: 'seller',
    name: `Seller ${suffix}`,
    email: `seller${suffix}@example.com`,
    phone: '9876543210',
    password: 'correct-horse-battery',
    company_name: `Lab Supplies ${suffix}`,
    gst_number: `07ABCDE12${suffix.padStart(2, '0').slice(-2)}F1Z5`,
    licence_type: 'md_licence',
    licence_number: `MD-${suffix}`,
    licence_expiry: FUTURE,
    city,
    state: 'Delhi',
    pincode: '110001',
  };
}

function categoryId(name) {
  return db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
}

before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES ('Admin','admin@example.com','9999999999',?,'admin')").run(
    hashPassword('admin-password-1'),
  );
  server = createServer(createApp({ db, enquiryMax: 100, loginMax: 100 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('registration validates input and rejects duplicate email', async () => {
  const bad = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'nope', phone: '123', password: 'short' } });
  assert.equal(bad.status, 422);

  const ok = await call('POST', '/api/auth/register', {
    body: { name: 'Buyer One', email: 'buyer1@example.com', phone: '9123456780', password: 'a-long-password' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.role, 'buyer');
  assert.ok(ok.cookie.startsWith('hm_session='));

  const dup = await call('POST', '/api/auth/register', {
    body: { name: 'Buyer One', email: 'buyer1@example.com', phone: '9123456780', password: 'a-long-password' },
  });
  assert.equal(dup.status, 409);
});

test('JSON content type is required for state-changing requests', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"email":"x@example.com","password":"x"}',
  });
  assert.equal(res.status, 415);
});

test('login fails with wrong password and succeeds with right one', async () => {
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'nope-nope-nope' } });
  assert.equal(wrong.status, 401);
  const right = await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'admin-password-1' } });
  assert.equal(right.status, 200);
  assert.equal(right.data.user.role, 'admin');
});

test('full lead-generation flow: verify, list, approve, enquire, unlock, quota', async () => {
  // Seller registers and is pending.
  const reg = await call('POST', '/api/auth/register', { body: sellerPayload('01') });
  assert.equal(reg.status, 201);
  const sellerCookie = reg.cookie;
  const admin = await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'admin-password-1' } });
  const adminCookie = admin.cookie;

  // Pending seller cannot list before verification.
  const earlyListing = await call('POST', '/api/seller/listings', {
    cookie: sellerCookie,
    body: { title: 'HbA1c Kit', category_id: categoryId('Diagnostic Kits') },
  });
  assert.equal(earlyListing.status, 403);

  // Admin verifies the company.
  const companies = await call('GET', '/api/admin/companies?status=pending', { cookie: adminCookie });
  const company = companies.data.companies.find((c) => c.owner_email === 'seller01@example.com');
  assert.ok(company);
  const verify = await call('POST', `/api/admin/companies/${company.id}/status`, { cookie: adminCookie, body: { status: 'verified' } });
  assert.equal(verify.status, 200);

  // Seller creates a listing; it stays pending until admin approves.
  const listing = await call('POST', '/api/seller/listings', {
    cookie: sellerCookie,
    body: {
      title: 'HbA1c Rapid Test Kit',
      category_id: categoryId('Diagnostic Kits'),
      composition: 'HbA1c antibody strip',
      pack_size: '25 tests',
      batch_number: 'B-2031-01',
      expiry_date: FUTURE,
      moq: 2,
      price_paise: 150000,
    },
  });
  assert.equal(listing.status, 201);
  assert.equal(listing.data.status, 'pending');

  const pendingSearch = await call('GET', '/api/search?q=HbA1c');
  assert.equal(pendingSearch.data.results.length, 0, 'pending listings must not be searchable');

  const approve = await call('POST', `/api/admin/listings/${listing.data.id}/status`, { cookie: adminCookie, body: { status: 'live' } });
  assert.equal(approve.status, 200);

  // Search returns product cards without seller contact details.
  const search = await call('GET', '/api/search?q=hba1c&city=delhi');
  assert.equal(search.data.results.length, 1);
  const card = search.data.results[0];
  assert.equal(card.title, 'HbA1c Rapid Test Kit');
  assert.equal(card.email, undefined);
  assert.equal(card.phone, undefined);

  // Enquiry without consent is rejected.
  const noConsent = await call('POST', '/api/enquiries', {
    body: enquiryBody({ consent: false }),
  });
  assert.equal(noConsent.status, 422);

  // Before any plan exists, the seller receives no lead.
  const first = await call('POST', '/api/enquiries', { body: enquiryBody() });
  assert.equal(first.status, 201);
  let leads = await call('GET', '/api/seller/leads', { cookie: sellerCookie });
  assert.equal(leads.data.leads.length, 0);

  // Seller buys a plan; admin confirms payment; subscription activates.
  const order = await call('POST', '/api/seller/orders', { cookie: sellerCookie, body: { plan_code: 'starter' } });
  assert.equal(order.status, 201);
  assert.equal(order.data.amount_paise, 99900);
  const confirm = await call('POST', `/api/admin/orders/${order.data.id}/confirm`, { cookie: adminCookie, body: { provider_ref: 'pay_test_1' } });
  assert.equal(confirm.status, 200);
  const again = await call('POST', `/api/admin/orders/${order.data.id}/confirm`, { cookie: adminCookie, body: {} });
  assert.equal(again.data.already_paid, true, 'confirming twice must be idempotent');

  // New enquiry now reaches the seller, masked.
  const second = await call('POST', '/api/enquiries', { body: enquiryBody({ buyer_name: 'Ravi Kumar', buyer_phone: '9000012345' }) });
  assert.equal(second.status, 201);
  leads = await call('GET', '/api/seller/leads', { cookie: sellerCookie });
  assert.equal(leads.data.leads.length, 1, 'only the post-plan enquiry is delivered');
  const masked = leads.data.leads[0];
  assert.equal(masked.locked, true);
  assert.equal(masked.buyer_phone, null);
  assert.equal(masked.buyer_name, 'R***');

  // Unlock reveals contact and consumes exactly one unit of quota.
  const unlocked = await call('POST', `/api/seller/leads/${masked.id}/unlock`, { cookie: sellerCookie });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.data.lead.buyer_phone, '9000012345');
  assert.equal(unlocked.data.lead.buyer_name, 'Ravi Kumar');

  const unlockAgain = await call('POST', `/api/seller/leads/${masked.id}/unlock`, { cookie: sellerCookie });
  assert.equal(unlockAgain.status, 200, 'unlocking an already unlocked lead is idempotent');
  const sub = await call('GET', '/api/seller/subscription', { cookie: sellerCookie });
  assert.equal(sub.data.subscription.leads_used, 1);

  // Pipeline status update.
  const status = await call('PATCH', `/api/seller/leads/${masked.id}`, { cookie: sellerCookie, body: { status: 'converted' } });
  assert.equal(status.data.lead.status, 'converted');
  const bogus = await call('PATCH', `/api/seller/leads/${masked.id}`, { cookie: sellerCookie, body: { status: 'deleted' } });
  assert.equal(bogus.status, 422);

  // Outbox: one verification email + one lead alert (the pre-plan enquiry alerted nobody).
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE channel = 'email'").get();
  assert.equal(count, 2);
});

test('quota exhaustion blocks unlocking', async () => {
  const reg = await call('POST', '/api/auth/register', { body: sellerPayload('02', 'Mumbai') });
  const cookie = reg.cookie;
  const adminCookie = (await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'admin-password-1' } })).cookie;
  const company = db.prepare("SELECT id FROM companies WHERE gst_number LIKE '%F1Z5' AND owner_user_id = (SELECT id FROM users WHERE email='seller02@example.com')").get();
  await call('POST', `/api/admin/companies/${company.id}/status`, { cookie: adminCookie, body: { status: 'verified' } });
  const l = await call('POST', '/api/seller/listings', {
    cookie,
    body: { title: 'Glucometer Strips', category_id: categoryId('Diagnostic Kits') },
  });
  await call('POST', `/api/admin/listings/${l.data.id}/status`, { cookie: adminCookie, body: { status: 'live' } });

  // Give this seller a plan with a quota of 1 by direct DB setup, then deliver 2 leads.
  db.prepare(
    'INSERT INTO subscriptions(company_id,plan_code,lead_quota,leads_used,listing_limit,starts_at,ends_at) VALUES (?,?,?,?,?,?,?)',
  ).run(company.id, 'starter', 1, 0, 10, Date.now(), Date.now() + 86_400_000);
  await call('POST', '/api/enquiries', { body: enquiryBody({ city: 'Mumbai', product_query: 'Glucometer strips for clinic' }) });
  await call('POST', '/api/enquiries', { body: enquiryBody({ product_query: 'Glucometer strips bulk order' }) });

  const leads = (await call('GET', '/api/seller/leads', { cookie })).data.leads;
  assert.equal(leads.length, 2);
  const first = await call('POST', `/api/seller/leads/${leads[0].id}/unlock`, { cookie });
  assert.equal(first.status, 200);
  const second = await call('POST', `/api/seller/leads/${leads[1].id}/unlock`, { cookie });
  assert.equal(second.status, 402);
});

test('scheduled drugs (H/H1/X) cannot be listed in Phase 1', async () => {
  const seller = db.prepare("SELECT u.id FROM users u WHERE email='seller01@example.com'").get();
  const cookie = (await call('POST', '/api/auth/login', { body: { email: 'seller01@example.com', password: 'correct-horse-battery' } })).cookie;
  assert.ok(seller && cookie);
  const res = await call('POST', '/api/seller/listings', {
    cookie,
    body: { title: 'Some Drug', category_id: categoryId('Pharmaceuticals (Non-Rx)'), schedule: 'H1' },
  });
  assert.equal(res.status, 422);
});

test('sellers cannot reach admin endpoints and anonymous users cannot reach seller endpoints', async () => {
  const sellerCookie = (await call('POST', '/api/auth/login', { body: { email: 'seller01@example.com', password: 'correct-horse-battery' } })).cookie;
  const asSeller = await call('GET', '/api/admin/companies', { cookie: sellerCookie });
  assert.equal(asSeller.status, 403);
  const anon = await call('GET', '/api/seller/leads');
  assert.equal(anon.status, 401);
});

test('enquiry rate limiting applies per IP', async () => {
  const strict = createServer(createApp({ db, enquiryMax: 2 }));
  await new Promise((r) => strict.listen(0, r));
  const url = `http://127.0.0.1:${strict.address().port}/api/enquiries`;
  const post = () =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: false }) });
  await post();
  await post();
  const third = await post();
  assert.equal(third.status, 429);
  await new Promise((r) => strict.close(r));
});

function enquiryBody(overrides = {}) {
  return {
    buyer_name: 'Test Buyer',
    buyer_phone: '9000011111',
    buyer_email: 'buyer@example.com',
    buyer_city: 'Delhi',
    category_id: categoryId('Diagnostic Kits'),
    product_query: 'HbA1c test kit for clinic',
    quantity: 50,
    message: 'Monthly requirement',
    consent: true,
    ...overrides,
  };
}
