import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTx } from './db.js';
import {
  createSession,
  deleteSession,
  getSessionUser,
  hashPassword,
  revokeOtherSessions,
  verifyPassword,
} from './auth.js';
import {
  confirmPayment,
  createPaymentOrder,
  freePeriodEndsAt,
  getSubscriptionSummary,
  isFreePeriod,
  listPlans,
} from './billing.js';
import {
  addListingImage,
  createListing,
  listCategories,
  listSellerListings,
  removeListingImage,
  searchListings,
  setListingPaused,
  updateListing,
} from './catalog.js';
import { createEnquiry, getLead, listSellerLeads, listUserEnquiries, unlockLead, updateLeadStatus } from './leads.js';
import { listCompanies, listListings, setCompanyStatus, setListingStatus } from './admin.js';
import { PERMISSIONS, resolveCompany } from './permissions.js';
import { addMember, listTeam, removeMember, updateMemberPermissions } from './team.js';
import {
  companyForApiKey,
  createApiKey,
  createWebhook,
  deleteWebhook,
  listApiKeys,
  listWebhooks,
  revokeApiKey,
} from './integrations.js';
import { readImage } from './media.js';
import {
  DATE_RE,
  GST_RE,
  HttpError,
  PINCODE_RE,
  createRateLimiter,
  isEmail,
  isIndianPhone,
  oneOf,
  parseBody,
  str,
} from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'hm_session';
const LICENCE_TYPES = ['drug_licence', 'md_licence', 'lab_registration', 'other'];
const SELF_REGISTER_ROLES = ['buyer', 'distributor', 'seller'];
const SESSION_HOURS = 12;

function parseEmail(v) {
  const email = str(v, 'email', { max: 254 }).toLowerCase();
  if (!isEmail(email)) throw new HttpError(422, 'email invalid है');
  return email;
}

function parsePhone(v) {
  const phone = str(v, 'phone', { min: 10, max: 10 });
  if (!isIndianPhone(phone)) throw new HttpError(422, 'phone valid 10-digit Indian number होना चाहिए');
  return phone;
}

function parseId(v) {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Not found');
  return id;
}

function parseCompany(b) {
  const gst = str(b.gst_number, 'gst_number', { min: 15, max: 15 }).toUpperCase();
  if (!GST_RE.test(gst)) throw new HttpError(422, 'gst_number invalid है');
  const expiry = str(b.licence_expiry, 'licence_expiry', { max: 10 });
  if (!DATE_RE.test(expiry) || Date.parse(expiry) <= Date.now()) {
    throw new HttpError(422, 'licence_expiry YYYY-MM-DD में और आज से आगे होनी चाहिए');
  }
  const pincode = str(b.pincode, 'pincode', { min: 6, max: 6 });
  if (!PINCODE_RE.test(pincode)) throw new HttpError(422, 'pincode invalid है');
  return {
    name: str(b.company_name, 'company_name', { max: 150 }),
    gst_number: gst,
    licence_type: oneOf(b.licence_type, 'licence_type', LICENCE_TYPES),
    licence_number: str(b.licence_number, 'licence_number', { max: 50 }),
    licence_expiry: expiry,
    city: str(b.city, 'city', { max: 100 }),
    state: str(b.state, 'state', { max: 100 }),
    pincode,
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${source}$`), keys };
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export function createApp({
  db,
  secureCookies = false,
  uploadDir = './data/uploads',
  enquiryMax = 5,
  loginMax = 10,
} = {}) {
  const enquiryLimit = createRateLimiter({ windowMs: 10 * 60_000, max: enquiryMax });
  const loginLimit = createRateLimiter({ windowMs: 15 * 60_000, max: loginMax });
  const publicDir = path.join(here, '..', 'public');
  const indexHtml = readFileSync(path.join(publicDir, 'index.html'));
  const STATIC = {
    '/assets/app.js': { type: 'application/javascript; charset=utf-8', body: readFileSync(path.join(publicDir, 'app.js')) },
    '/assets/app.css': { type: 'text/css; charset=utf-8', body: readFileSync(path.join(publicDir, 'app.css')) },
  };

  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; ${cookieFlags}; Max-Age=${maxAge}`;

  // ---- Account -----------------------------------------------------------
  async function register(ctx) {
    const b = ctx.body;
    const role = oneOf(b.role ?? 'buyer', 'role', SELF_REGISTER_ROLES);
    const name = str(b.name, 'name', { max: 100 });
    const email = parseEmail(b.email);
    const phone = parsePhone(b.phone);
    const password = str(b.password, 'password', { min: 10, max: 200 });
    const company = role === 'seller' ? parseCompany(b) : null;

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'Email पहले से registered है');
    }
    const userId = withTx(db, () => {
      const id = Number(
        db
          .prepare('INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?,?)')
          .run(name, email, phone, hashPassword(password), role).lastInsertRowid,
      );
      if (company) {
        db.prepare(
          `INSERT INTO companies(owner_user_id,name,gst_number,licence_type,licence_number,licence_expiry,city,state,pincode)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          company.name,
          company.gst_number,
          company.licence_type,
          company.licence_number,
          company.licence_expiry,
          company.city,
          company.state,
          company.pincode,
        );
      }
      return id;
    });
    const session = createSession(db, userId);
    return {
      status: 201,
      body: { user: { id: userId, name, email, role } },
      headers: { 'set-cookie': sessionCookie(session.token, SESSION_HOURS * 3600) },
    };
  }

  async function login(ctx) {
    const b = ctx.body;
    const email = parseEmail(b.email);
    if (!loginLimit(`${email}|${ctx.ip}`)) {
      throw new HttpError(429, 'बहुत सारी login attempts, 15 मिनट बाद प्रयास करें');
    }
    const password = str(b.password, 'password', { max: 200 });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Email या password गलत है');
    }
    const session = createSession(db, user.id);
    return {
      body: { user: { id: user.id, name: user.name, email: user.email, role: user.role } },
      headers: { 'set-cookie': sessionCookie(session.token, SESSION_HOURS * 3600) },
    };
  }

  async function logout(ctx) {
    deleteSession(db, ctx.cookies[COOKIE]);
    return { body: { ok: true }, headers: { 'set-cookie': sessionCookie('', 0) } };
  }

  async function changePassword(ctx) {
    const current = str(ctx.body.current_password, 'current_password', { max: 200 });
    const next = str(ctx.body.new_password, 'new_password', { min: 10, max: 200 });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(401, 'पुराना password गलत है');
    withTx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), ctx.user.id);
      // Sign out every other session; the current one stays signed in.
      revokeOtherSessions(db, ctx.user.id, ctx.cookies[COOKIE]);
    });
    return { body: { ok: true } };
  }

  async function me(ctx) {
    return { body: { user: ctx.user } };
  }

  async function buyerEnquiries(ctx) {
    return { body: { enquiries: listUserEnquiries(db, ctx.user.id) } };
  }

  // ---- Public ------------------------------------------------------------
  async function program() {
    const until = freePeriodEndsAt(db);
    return {
      body: {
        free_until: until ? until.toISOString() : null,
        is_free: isFreePeriod(db),
        note: 'इस अवधि में सभी leads बिना charge के मिलती हैं। अवधि खत्म होने पर plan अपने आप लागू हो जाएगा।',
      },
    };
  }

  async function search(ctx) {
    const categoryId = ctx.query.get('category_id');
    return {
      body: {
        results: searchListings(db, {
          q: ctx.query.get('q') ?? '',
          categoryId: categoryId ? parseId(categoryId) : null,
          city: (ctx.query.get('city') ?? '').trim(),
        }),
      },
    };
  }

  async function enquiry(ctx) {
    if (!enquiryLimit(ctx.ip)) throw new HttpError(429, 'बहुत सारे requests, थोड़ी देर बाद प्रयास करें');
    const userId = ctx.user && ['buyer', 'distributor'].includes(ctx.user.role) ? ctx.user.id : null;
    return { status: 201, body: createEnquiry(db, ctx.body, { userId }) };
  }

  // ---- Seller and company team (permission-checked) ----------------------
  const access = (ctx, perm = null) => resolveCompany(db, ctx.user, perm);

  async function companyGet(ctx) {
    const { company, permissions, isOwner } = access(ctx);
    return {
      body: {
        company: {
          id: company.id,
          name: company.name,
          gst_number: company.gst_number,
          licence_type: company.licence_type,
          licence_expiry: company.licence_expiry,
          city: company.city,
          state: company.state,
          status: company.status,
        },
        role: isOwner ? 'owner' : 'member',
        permissions,
      },
    };
  }

  async function listingCreate(ctx) {
    return { status: 201, body: createListing(db, access(ctx, 'listings:manage').company, ctx.body) };
  }

  async function listingsGet(ctx) {
    return { body: { listings: listSellerListings(db, access(ctx, 'listings:manage').company.id) } };
  }

  async function listingUpdate(ctx) {
    const { company } = access(ctx, 'listings:manage');
    return { body: updateListing(db, company, parseId(ctx.params.id), ctx.body, ctx.user.id) };
  }

  async function listingPause(ctx) {
    const { company } = access(ctx, 'listings:manage');
    return { body: setListingPaused(db, company, parseId(ctx.params.id), true, ctx.user.id) };
  }

  async function listingResume(ctx) {
    const { company } = access(ctx, 'listings:manage');
    return { body: setListingPaused(db, company, parseId(ctx.params.id), false, ctx.user.id) };
  }

  async function imageAdd(ctx) {
    const { company } = access(ctx, 'listings:manage');
    return { status: 201, body: addListingImage(db, company, parseId(ctx.params.id), ctx.body.image, uploadDir, ctx.user.id) };
  }

  async function imageRemove(ctx) {
    const { company } = access(ctx, 'listings:manage');
    return {
      body: removeListingImage(db, company, parseId(ctx.params.id), parseId(ctx.params.imageId), uploadDir, ctx.user.id),
    };
  }

  async function leadsGet(ctx) {
    const { company } = access(ctx, 'leads:view');
    const status = ctx.query.get('status');
    return { body: { leads: listSellerLeads(db, company.id, { status: status || null, limit: ctx.query.get('limit') }) } };
  }

  async function leadUnlock(ctx) {
    const { company } = access(ctx, 'leads:unlock');
    return { body: { lead: unlockLead(db, company.id, parseId(ctx.params.id), ctx.user.id) } };
  }

  async function leadStatus(ctx) {
    const { company } = access(ctx, 'leads:update');
    return { body: { lead: updateLeadStatus(db, company.id, parseId(ctx.params.id), ctx.body.status) } };
  }

  async function subscriptionGet(ctx) {
    const { company } = access(ctx, 'leads:view');
    const until = freePeriodEndsAt(db);
    return {
      body: {
        free_period: { is_free: isFreePeriod(db), free_until: until ? until.toISOString() : null },
        subscription: getSubscriptionSummary(db, company.id),
      },
    };
  }

  async function orderCreate(ctx) {
    const { company } = access(ctx, 'billing:manage');
    return { status: 201, body: createPaymentOrder(db, company, ctx.body) };
  }

  async function teamGet(ctx) {
    const { company } = access(ctx, 'team:manage');
    return { body: { team: listTeam(db, company.id), available_permissions: PERMISSIONS } };
  }

  async function teamAdd(ctx) {
    const { company } = access(ctx, 'team:manage');
    return { status: 201, body: addMember(db, ctx.user.id, company.id, ctx.body) };
  }

  async function teamUpdate(ctx) {
    const { company } = access(ctx, 'team:manage');
    return { body: updateMemberPermissions(db, ctx.user.id, company.id, parseId(ctx.params.userId), ctx.body) };
  }

  async function teamRemove(ctx) {
    const { company } = access(ctx, 'team:manage');
    return { body: removeMember(db, ctx.user.id, company.id, parseId(ctx.params.userId)) };
  }

  async function apiKeysGet(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { body: { keys: listApiKeys(db, company.id) } };
  }

  async function apiKeyCreate(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { status: 201, body: createApiKey(db, company, ctx.user.id, ctx.body.label) };
  }

  async function apiKeyRevoke(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { body: revokeApiKey(db, company.id, ctx.user.id, parseId(ctx.params.id)) };
  }

  async function webhooksGet(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { body: { webhooks: listWebhooks(db, company.id) } };
  }

  async function webhookCreate(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { status: 201, body: createWebhook(db, company, ctx.user.id, ctx.body) };
  }

  async function webhookDelete(ctx) {
    const { company } = access(ctx, 'integrations:manage');
    return { body: deleteWebhook(db, company.id, ctx.user.id, parseId(ctx.params.id)) };
  }

  // ---- CRM API (Bearer API key) ------------------------------------------
  const apiCompany = (ctx) => {
    const company = companyForApiKey(db, ctx.headers.authorization);
    if (!company) throw new HttpError(401, 'Valid API key चाहिए (Authorization: Bearer hm_live_...)');
    return company;
  };

  async function v1LeadsGet(ctx) {
    const company = apiCompany(ctx);
    return {
      body: {
        leads: listSellerLeads(db, company.id, {
          status: ctx.query.get('status') || null,
          limit: ctx.query.get('limit'),
        }),
      },
    };
  }

  async function v1LeadGet(ctx) {
    return { body: { lead: getLead(db, apiCompany(ctx).id, parseId(ctx.params.id)) } };
  }

  async function v1LeadUnlock(ctx) {
    return { body: { lead: unlockLead(db, apiCompany(ctx).id, parseId(ctx.params.id), null) } };
  }

  async function v1LeadStatus(ctx) {
    return { body: { lead: updateLeadStatus(db, apiCompany(ctx).id, parseId(ctx.params.id), ctx.body.status) } };
  }

  // ---- Admin --------------------------------------------------------------
  async function adminCompanies(ctx) {
    return { body: { companies: listCompanies(db, ctx.query.get('status')) } };
  }

  async function adminCompanyStatus(ctx) {
    return { body: setCompanyStatus(db, ctx.user.id, parseId(ctx.params.id), ctx.body.status) };
  }

  async function adminListings(ctx) {
    return { body: { listings: listListings(db, ctx.query.get('status') ?? 'pending') } };
  }

  async function adminListingStatus(ctx) {
    return { body: setListingStatus(db, ctx.user.id, parseId(ctx.params.id), ctx.body.status) };
  }

  async function adminConfirmOrder(ctx) {
    const provider_ref = str(ctx.body.provider_ref, 'provider_ref', { max: 100, optional: true }) || null;
    return { body: confirmPayment(db, parseId(ctx.params.id), provider_ref, ctx.user.id) };
  }

  async function categories() {
    return { body: { categories: listCategories(db) } };
  }

  async function plansGet() {
    return { body: { plans: listPlans(db) } };
  }

  // ---- Routing ------------------------------------------------------------
  // auth: 'public' | 'user' | 'apikey'. roles limits which logged-in roles may call.
  const USER = 'user';
  const PUBLIC = 'public';
  const APIKEY = 'apikey';
  const BUYERS = ['buyer', 'distributor'];
  const COMPANY = ['seller', 'company_member'];
  const ADMIN = ['admin'];

  const ROUTES = [
    ['POST', '/api/auth/register', register, PUBLIC],
    ['POST', '/api/auth/login', login, PUBLIC],
    ['POST', '/api/auth/logout', logout, PUBLIC],
    ['POST', '/api/auth/change-password', changePassword, USER],
    ['GET', '/api/me', me, USER],
    ['GET', '/api/me/enquiries', buyerEnquiries, USER, BUYERS],
    ['GET', '/api/program', program, PUBLIC],
    ['GET', '/api/categories', categories, PUBLIC],
    ['GET', '/api/plans', plansGet, PUBLIC],
    ['GET', '/api/search', search, PUBLIC],
    ['POST', '/api/enquiries', enquiry, PUBLIC],

    ['GET', '/api/seller/company', companyGet, USER, COMPANY],
    ['GET', '/api/seller/listings', listingsGet, USER, COMPANY],
    ['POST', '/api/seller/listings', listingCreate, USER, COMPANY],
    ['PATCH', '/api/seller/listings/:id', listingUpdate, USER, COMPANY],
    ['POST', '/api/seller/listings/:id/pause', listingPause, USER, COMPANY],
    ['POST', '/api/seller/listings/:id/resume', listingResume, USER, COMPANY],
    ['POST', '/api/seller/listings/:id/images', imageAdd, USER, COMPANY],
    ['DELETE', '/api/seller/listings/:id/images/:imageId', imageRemove, USER, COMPANY],
    ['GET', '/api/seller/leads', leadsGet, USER, COMPANY],
    ['POST', '/api/seller/leads/:id/unlock', leadUnlock, USER, COMPANY],
    ['PATCH', '/api/seller/leads/:id', leadStatus, USER, COMPANY],
    ['GET', '/api/seller/subscription', subscriptionGet, USER, COMPANY],
    ['POST', '/api/seller/orders', orderCreate, USER, COMPANY],
    ['GET', '/api/seller/team', teamGet, USER, COMPANY],
    ['POST', '/api/seller/team', teamAdd, USER, COMPANY],
    ['PATCH', '/api/seller/team/:userId', teamUpdate, USER, COMPANY],
    ['DELETE', '/api/seller/team/:userId', teamRemove, USER, COMPANY],
    ['GET', '/api/seller/api-keys', apiKeysGet, USER, COMPANY],
    ['POST', '/api/seller/api-keys', apiKeyCreate, USER, COMPANY],
    ['DELETE', '/api/seller/api-keys/:id', apiKeyRevoke, USER, COMPANY],
    ['GET', '/api/seller/webhooks', webhooksGet, USER, COMPANY],
    ['POST', '/api/seller/webhooks', webhookCreate, USER, COMPANY],
    ['DELETE', '/api/seller/webhooks/:id', webhookDelete, USER, COMPANY],

    ['GET', '/api/v1/leads', v1LeadsGet, APIKEY],
    ['GET', '/api/v1/leads/:id', v1LeadGet, APIKEY],
    ['POST', '/api/v1/leads/:id/unlock', v1LeadUnlock, APIKEY],
    ['PATCH', '/api/v1/leads/:id', v1LeadStatus, APIKEY],

    ['GET', '/api/admin/companies', adminCompanies, USER, ADMIN],
    ['POST', '/api/admin/companies/:id/status', adminCompanyStatus, USER, ADMIN],
    ['GET', '/api/admin/listings', adminListings, USER, ADMIN],
    ['POST', '/api/admin/listings/:id/status', adminListingStatus, USER, ADMIN],
    ['POST', '/api/admin/orders/:id/confirm', adminConfirmOrder, USER, ADMIN],
  ].map(([method, pattern, fn, auth, roles]) => ({ method, fn, auth, roles, ...compile(pattern) }));

  function findRoute(method, pathname) {
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
        });
        return res.end(indexHtml);
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const asset = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=300' });
        return res.end(asset.body);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const img = readImage(uploadDir, url.pathname.slice('/uploads/'.length));
        if (!img) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'public, max-age=86400' });
        return res.end(img.body);
      }

      const match = findRoute(req.method, url.pathname);
      if (!match) return json(res, 404, { error: 'Not found' });
      const { route, params } = match;

      const ctx = {
        params,
        query: url.searchParams,
        headers: req.headers,
        ip: req.socket.remoteAddress ?? 'unknown',
        cookies: parseCookies(req.headers.cookie),
        user: null,
        body: {},
      };

      if (route.auth === APIKEY) {
        // CRM routes authenticate by key, not by cookie.
      } else {
        ctx.user = getSessionUser(db, ctx.cookies[COOKIE]);
        if (route.auth === USER && !ctx.user) throw new HttpError(401, 'Login आवश्यक है');
        if (route.roles && !route.roles.includes(ctx.user?.role)) {
          throw new HttpError(ctx.user ? 403 : 401, ctx.user ? 'Access नहीं है' : 'Login आवश्यक है');
        }
      }

      if (req.method !== 'GET') {
        // Requiring JSON makes cross-site form posts fail without a CORS preflight.
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          throw new HttpError(415, 'Content-Type application/json होना चाहिए');
        }
        ctx.body = await parseBody(req);
      }

      const result = (await route.fn(ctx)) ?? {};
      return json(res, result.status ?? 200, result.body ?? {}, result.headers ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Internal error' });
    }
  };
}
