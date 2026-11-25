import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTx } from './db.js';
import { createSession, deleteSession, getSessionUser, hashPassword, verifyPassword } from './auth.js';
import { createPaymentOrder, getSubscriptionSummary, listPlans, confirmPayment } from './billing.js';
import { createListing, getCompanyByOwner, listCategories, listSellerListings, searchListings } from './catalog.js';
import { createEnquiry, listSellerLeads, unlockLead, updateLeadStatus } from './leads.js';
import { listCompanies, listListings, setCompanyStatus, setListingStatus } from './admin.js';
import {
  DATE_RE,
  GST_RE,
  HttpError,
  PINCODE_RE,
  createRateLimiter,
  int,
  isEmail,
  isIndianPhone,
  oneOf,
  parseBody,
  str,
} from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'hm_session';
const LICENCE_TYPES = ['drug_licence', 'md_licence', 'lab_registration', 'other'];

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

export function createApp({ db, secureCookies = false, enquiryMax = 5, loginMax = 10 } = {}) {
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

  // ---- Auth -------------------------------------------------------------
  async function register(ctx) {
    const b = ctx.body;
    const role = oneOf(b.role ?? 'buyer', 'role', ['buyer', 'seller']);
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
      headers: { 'set-cookie': sessionCookie(session.token, 12 * 3600) },
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
      headers: { 'set-cookie': sessionCookie(session.token, 12 * 3600) },
    };
  }

  async function logout(ctx) {
    deleteSession(db, ctx.cookies[COOKIE]);
    return { body: { ok: true }, headers: { 'set-cookie': sessionCookie('', 0) } };
  }

  // ---- Public -----------------------------------------------------------
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
    return { status: 201, body: createEnquiry(db, ctx.body) };
  }

  // ---- Seller -----------------------------------------------------------
  const sellerCompany = (ctx) => {
    const company = getCompanyByOwner(db, ctx.user.id);
    if (!company) throw new HttpError(404, 'Company profile नहीं मिली');
    return company;
  };

  async function sellerCompanyGet(ctx) {
    const c = sellerCompany(ctx);
    return {
      body: {
        company: {
          id: c.id,
          name: c.name,
          gst_number: c.gst_number,
          licence_type: c.licence_type,
          licence_expiry: c.licence_expiry,
          city: c.city,
          state: c.state,
          status: c.status,
        },
      },
    };
  }

  async function listingCreate(ctx) {
    return { status: 201, body: createListing(db, sellerCompany(ctx), ctx.body) };
  }

  async function listingsGet(ctx) {
    return { body: { listings: listSellerListings(db, sellerCompany(ctx).id) } };
  }

  async function leadsGet(ctx) {
    return { body: { leads: listSellerLeads(db, sellerCompany(ctx).id) } };
  }

  async function leadUnlock(ctx) {
    const lead = unlockLead(db, sellerCompany(ctx).id, parseId(ctx.params.id), ctx.user.id);
    return { body: { lead } };
  }

  async function leadStatus(ctx) {
    const lead = updateLeadStatus(db, sellerCompany(ctx).id, parseId(ctx.params.id), ctx.body.status);
    return { body: { lead } };
  }

  async function subscriptionGet(ctx) {
    return { body: { subscription: getSubscriptionSummary(db, sellerCompany(ctx).id) } };
  }

  async function orderCreate(ctx) {
    return { status: 201, body: createPaymentOrder(db, sellerCompany(ctx), ctx.body) };
  }

  async function plansGet() {
    return { body: { plans: listPlans(db) } };
  }

  // ---- Admin ------------------------------------------------------------
  async function adminCompanies(ctx) {
    const status = ctx.query.get('status');
    return { body: { companies: listCompanies(db, status) } };
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

  async function me(ctx) {
    return { body: { user: ctx.user } };
  }

  const ANY = undefined;
  const SELLER = ['seller'];
  const ADMIN = ['admin'];
  const LOGGED_IN = ['buyer', 'seller', 'admin'];

  const ROUTES = [
    ['POST', '/api/auth/register', register, ANY],
    ['POST', '/api/auth/login', login, ANY],
    ['POST', '/api/auth/logout', logout, ANY],
    ['GET', '/api/me', me, LOGGED_IN],
    ['GET', '/api/categories', categories, ANY],
    ['GET', '/api/plans', plansGet, ANY],
    ['GET', '/api/search', search, ANY],
    ['POST', '/api/enquiries', enquiry, ANY],
    ['GET', '/api/seller/company', sellerCompanyGet, SELLER],
    ['POST', '/api/seller/listings', listingCreate, SELLER],
    ['GET', '/api/seller/listings', listingsGet, SELLER],
    ['GET', '/api/seller/leads', leadsGet, SELLER],
    ['POST', '/api/seller/leads/:id/unlock', leadUnlock, SELLER],
    ['PATCH', '/api/seller/leads/:id', leadStatus, SELLER],
    ['GET', '/api/seller/subscription', subscriptionGet, SELLER],
    ['POST', '/api/seller/orders', orderCreate, SELLER],
    ['GET', '/api/admin/companies', adminCompanies, ADMIN],
    ['POST', '/api/admin/companies/:id/status', adminCompanyStatus, ADMIN],
    ['GET', '/api/admin/listings', adminListings, ADMIN],
    ['POST', '/api/admin/listings/:id/status', adminListingStatus, ADMIN],
    ['POST', '/api/admin/orders/:id/confirm', adminConfirmOrder, ADMIN],
  ].map(([method, pattern, fn, roles]) => ({ method, fn, roles, ...compile(pattern) }));

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

      const match = findRoute(req.method, url.pathname);
      if (!match) return json(res, 404, { error: 'Not found' });
      const { route, params } = match;

      const ctx = {
        params,
        query: url.searchParams,
        ip: req.socket.remoteAddress ?? 'unknown',
        cookies: parseCookies(req.headers.cookie),
        user: null,
        body: {},
      };
      ctx.user = getSessionUser(db, ctx.cookies[COOKIE]);

      if (route.roles) {
        if (!ctx.user) throw new HttpError(401, 'Login आवश्यक है');
        if (!route.roles.includes(ctx.user.role)) throw new HttpError(403, 'Access नहीं है');
      }

      if (req.method !== 'GET') {
        // Requiring a JSON content type makes cross-site form posts fail without a preflight.
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          throw new HttpError(415, 'Content-Type application/json होना चाहिए');
        }
        ctx.body = await parseBody(req);
      }

      const result = (await route.fn(ctx)) ?? {};
      return json(res, result.status ?? 200, result.body ?? {}, result.headers ?? {});
    } catch (err) {
      if (err instanceof HttpError) {
        return json(res, err.status, { error: err.message });
      }
      console.error(err);
      return json(res, 500, { error: 'Internal error' });
    }
  };
}
