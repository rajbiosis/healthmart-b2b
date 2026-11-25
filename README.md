# HealthMart B2B

A B2B discovery and lead-generation marketplace for diagnostics, lab and healthcare products.
Buyers post requirements for free. Verified sellers receive matching leads and pay a plan to unlock contacts.

- Lead generation spec: [`docs/LEAD-GENERATION-SPEC.md`](docs/LEAD-GENERATION-SPEC.md)
- Phased plan and feature checklist: [`docs/PHASED-PLAN.md`](docs/PHASED-PLAN.md)

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite` module)
- No npm dependencies in Phase 1

## Run locally

```bash
npm test                                   # API tests (in-memory DB)
PORT=3000 npm start                        # http://localhost:3000
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at-least-10-chars' npm run create-admin
```

`DB_PATH` sets the SQLite file (default `./data/healthmart.db`). `NODE_ENV=production` turns on Secure cookies.

## API overview

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | public | Register buyer or seller (seller also sends company details) |
| POST | `/api/auth/login` | public | Login, sets session cookie |
| POST | `/api/auth/logout` | any | Logout |
| GET | `/api/categories`, `/api/plans` | public | Reference data |
| GET | `/api/search?q=&city=&category_id=` | public | Live product cards |
| POST | `/api/enquiries` | public | Buyer requirement (requires `consent: true`) |
| GET | `/api/seller/company` | seller | Company profile and status |
| POST / GET | `/api/seller/listings` | seller | Create and list products |
| GET | `/api/seller/leads` | seller | Lead inbox (masked until unlocked) |
| POST | `/api/seller/leads/:id/unlock` | seller | Reveal contact, consume one quota |
| PATCH | `/api/seller/leads/:id` | seller | Set `contacted`, `converted` or `lost` |
| GET | `/api/seller/subscription` | seller | Active plan and quota usage |
| POST | `/api/seller/orders` | seller | Create a plan order |
| GET | `/api/admin/companies?status=pending` | admin | Verification queue |
| POST | `/api/admin/companies/:id/status` | admin | `verified`, `rejected` or `suspended` |
| GET | `/api/admin/listings?status=pending` | admin | Listing approval queue |
| POST | `/api/admin/listings/:id/status` | admin | `live`, `rejected` or `paused` |
| POST | `/api/admin/orders/:id/confirm` | admin | Confirm payment and activate plan |

Mutating requests must send `Content-Type: application/json`.

## Security notes

- Passwords use scrypt with a random salt. Session tokens are random and stored only as SHA-256 hashes.
- Cookies are HttpOnly and SameSite=Lax. Login and enquiry endpoints are rate-limited.
- Buyer contact data never appears in public responses. Sellers see it only after unlock.
- Run behind a reverse proxy with HTTPS in production. Rate limits are in memory, so use a shared store when running more than one instance.

## Layout

```
src/
  app.js        HTTP routing, auth guards, JSON handling
  server.js     entry point
  db.js         schema, seeding, transactions, audit and outbox helpers
  auth.js       password hashing, sessions
  catalog.js    categories, listings, search
  leads.js      enquiry intake, seller matching, masked leads, unlock
  billing.js    plans, orders, subscription activation
  admin.js      verification and listing moderation
  util.js       validation, body parsing, rate limiter
public/         minimal buyer-facing search and requirement form
test/           API tests (node:test)
scripts/        admin bootstrap
docs/           specs and phased plan
```
