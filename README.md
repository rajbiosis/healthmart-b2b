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
| POST | `/api/auth/register` | public | Sign up as `buyer`, `distributor` or `seller` |
| POST | `/api/auth/login`, `/logout` | any | Session cookie |
| POST | `/api/auth/change-password` | logged in | Changes password, signs out other sessions |
| GET | `/api/me` | logged in | Current user |
| GET | `/api/me/enquiries` | buyer, distributor | Own requirements and supplier reach |
| GET | `/api/program` | public | Free period status and end date |
| GET | `/api/search` | public | Live product cards with photo URL |
| POST | `/api/enquiries` | public (or logged-in buyer) | Requirement; needs `consent: true` |
| GET | `/api/seller/company` | seller, member | Company and the caller's permissions |
| GET, POST | `/api/seller/listings` | member with `listings:manage` | List and create products |
| PATCH | `/api/seller/listings/:id` | `listings:manage` | Edit; live listings go back to review |
| POST | `/api/seller/listings/:id/pause`, `/resume` | `listings:manage` | Pause or resume without review |
| POST | `/api/seller/listings/:id/images` | `listings:manage` | Add photo (`image` data URL) |
| DELETE | `/api/seller/listings/:id/images/:imageId` | `listings:manage` | Remove photo |
| GET | `/api/seller/leads?status=` | `leads:view` | Lead inbox (masked until unlocked) |
| POST | `/api/seller/leads/:id/unlock` | `leads:unlock` | Reveal contact (free in launch period) |
| PATCH | `/api/seller/leads/:id` | `leads:update` | `contacted`, `converted`, `lost` |
| GET | `/api/seller/subscription` | `leads:view` | Free period status and plan usage |
| POST | `/api/seller/orders` | `billing:manage` | Buy a plan |
| GET, POST | `/api/seller/team` | `team:manage` | List and add team members |
| PATCH, DELETE | `/api/seller/team/:userId` | `team:manage` | Change permissions or remove |
| GET, POST | `/api/seller/api-keys` | `integrations:manage` | CRM API keys (full key shown once) |
| DELETE | `/api/seller/api-keys/:id` | `integrations:manage` | Revoke key |
| GET, POST | `/api/seller/webhooks` | `integrations:manage` | Register webhook (secret shown once) |
| DELETE | `/api/seller/webhooks/:id` | `integrations:manage` | Remove webhook |
| GET | `/api/v1/leads`, `/api/v1/leads/:id` | API key | CRM: fetch leads |
| POST | `/api/v1/leads/:id/unlock` | API key | CRM: unlock a lead |
| PATCH | `/api/v1/leads/:id` | API key | CRM: update lead status |
| GET | `/api/admin/companies`, `/api/admin/listings` | admin | Review queues |
| POST | `/api/admin/companies/:id/status` | admin | `verified`, `rejected`, `suspended` |
| POST | `/api/admin/listings/:id/status` | admin | `live`, `rejected`, `paused` |
| POST | `/api/admin/orders/:id/confirm` | admin | Confirm payment and activate plan |

CRM calls send `Authorization: Bearer hm_live_...`. Webhooks are signed with
`X-HealthMart-Signature: sha256=<hmac of "timestamp.body">` using the secret from registration.

Mutating requests must send `Content-Type: application/json`.

## Security notes

- Passwords use scrypt with a random salt. Session tokens are random and stored only as SHA-256 hashes.
- Cookies are HttpOnly and SameSite=Lax. Login and enquiry endpoints are rate-limited.
- Buyer contact data never appears in public responses. Sellers see it only after unlock.
- Team members get only the permissions the owner grants. Every seller route checks them.
- Photos are checked by file signature; SVG and other types are refused.
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
