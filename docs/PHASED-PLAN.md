# Phased Plan

Status: `[x]` done in this repo, `[ ]` pending, `[~]` partly done.

## Launch policy (decided)

- **Revenue model:** lead generation. Sellers pay plans to unlock buyer contacts.
- **Free launch period: 6 months.** Every lead is free to receive and unlock. Sign-up is open to everyone.
  The period is stored in the database when the app first starts, so restarts do not change it.
- **Automatic switch:** when the period ends, plans apply with no manual step. Sellers without an active plan stop receiving new leads.

## Roles and permissions (decided)

| Role | Who | Can do |
|---|---|---|
| `buyer` | Customer | Post requirements, track own enquiries |
| `distributor` | Distributor | Same as buyer; separate role for future wholesale features |
| `seller` | Company owner | Everything for the company: listings, leads, plans, team, API, webhooks |
| `company_member` | Staff added by owner | Only permissions the owner grants |
| `admin` | Platform team | Verification, listing approval, payment confirmation |

Member permissions: `listings:manage`, `leads:view`, `leads:unlock`, `leads:update`, `billing:manage`, `team:manage`, `integrations:manage`.

---

## Phase 1: Lead generation, accounts and CRM access (current)

**Accounts and access**
- [x] Self sign-up for buyer, distributor and seller; login, logout
- [x] Password change with other sessions revoked
- [x] Session auth with hashed passwords, HttpOnly cookies, 12h expiry, login rate limit
- [x] Distributor role separate from buyer
- [x] Company team: owner adds members with chosen permissions; members have their own login
- [x] Permission checks on every seller route; members cannot see or change what they were not granted
- [x] Buyer and distributor dashboard: own enquiries and number of suppliers reached
- [ ] Forgot password (email reset link)
- [ ] Email verification at sign-up
- [ ] Invite flow for team members (currently owner creates the login directly)
- [ ] Separate team roles beyond the seven permissions (e.g. "sales", "billing")

**Seller and listings**
- [x] Seller registration with GST, licence type and expiry, city and pincode
- [x] Admin verify, reject, suspend companies (suspension pauses live listings)
- [x] Listings: title, composition, pack size, batch, expiry, MOQ, price, category
- [x] Edit listing; changing a live listing's content sends it back to review
- [x] Pause and resume listing without review
- [x] Admin approve or reject listings
- [x] Schedule H/H1/X blocked
- [x] Expired listings are hidden from search and from lead matching
- [x] Photos: up to 6 per listing, JPEG/PNG/WebP only, 2 MB max, file content checked (not just the declared type)
- [x] Photos shown in search results
- [ ] Listing rejection reason shown to seller
- [ ] Category management by admin (categories are seeded, 7 flat ones)
- [ ] Multi-level categories with product attributes per category
- [ ] Bulk listing upload (CSV/Excel) — Phase 2

**Leads**
- [x] Buyer enquiry with consent; rate limit; up to 5 matched sellers
- [x] Matching by verified status, licence validity, category, and city preference
- [x] Masked leads until unlock; unlock reveals contact
- [x] Free period: no charge, no plan needed
- [x] After free period: quota per unlock, idempotent repeat unlocks
- [x] Lead pipeline: contacted, converted, lost
- [x] Audit log for unlocks and admin actions
- [ ] Lead assignment to a team member
- [ ] Duplicate enquiry detection
- [ ] Re-routing when a seller does not respond in time — Phase 2
- [ ] Buyer RFQ board (public list of requirements) — Phase 2

**Billing**
- [x] Plans: Starter ₹999 (20 leads), Growth ₹2,499 (100 leads), Pro ₹5,999 (500 leads), 30 days
- [x] Order creation; admin confirms payment; idempotent activation
- [x] Automatic activation of plan rules when the free period ends
- [ ] Payment gateway checkout (Razorpay or Cashfree) with webhook-driven activation
- [ ] Plan renewal reminders and expiry handling
- [ ] Upgrade and downgrade
- [ ] GST invoices, refunds

**CRM and integrations**
- [x] API keys per company (shown once, stored as hash, revocable)
- [x] CRM API: list leads, get a lead, unlock, update status
- [x] Webhooks: `lead.delivered`, `lead.unlocked` with HMAC-SHA256 signature and timestamp
- [x] Webhook retries with backoff; failed after 6 attempts
- [x] Webhook delivery worker runs in the server process
- [ ] Webhook test/ping endpoint and delivery log view
- [ ] Sandbox environment for CRM developers
- [ ] Rate limits per API key
- [ ] Webhook URL safety (block private IP ranges) — needed before public launch

**Notifications**
- [~] Email alerts are queued in the outbox; a sender is not connected yet
- [ ] Email sender (SMTP or Resend)
- [ ] SMS (TRAI DLT templates)
- [ ] WhatsApp Business

**Web and operations**
- [x] Minimal public page: product search and requirement form
- [ ] Seller dashboard UI (login, listings, photos, lead inbox, team, API keys, webhooks)
- [ ] Buyer and distributor dashboard UI
- [ ] Admin UI (verification queue, listing approval, payment confirmation)
- [ ] Production hosting, HTTPS, backups, monitoring
- [ ] Persistent rate limits (currently in memory; single instance only)

---

## Phase 2: Scale, seller tools and growth

- [ ] Photos: server-side compression and resizing, EXIF removal, CDN delivery (S3 or Cloudinary)
- [ ] Photo customisation: watermark, cropping, reordering
- [ ] Bulk listing upload (CSV/Excel) with error report
- [ ] Lead push to more CRMs (native connectors) and lead fetch with pagination and date filters
- [ ] Seller API for creating and updating listings
- [ ] Notifications over SMS and WhatsApp, with the sender worker
- [ ] Buyer RFQ board and re-routing when a seller does not respond
- [ ] Duplicate lead detection and lead assignment to team members
- [ ] In-app chat between buyer and seller after unlock
- [ ] Ratings, reviews, complaints and dispute flow
- [ ] Trust score and verified badge
- [ ] Seller storefront page with its own slug
- [ ] Featured and boosted listings (paid visibility)
- [ ] Seller analytics: views, enquiries, conversion
- [ ] Moderation queue for fake or counterfeit reports
- [ ] Admin reports, user bans, audit log viewer
- [ ] Support ticketing and grievance officer details (Consumer Protection (E-Commerce) Rules, 2020)
- [ ] SEO: server-side rendering, sitemap, schema.org markup
- [ ] Multi-language UI (Hindi first, then regional)
- [ ] Email verification and forgot-password flows, if not already in Phase 1
- [ ] Team invite flow and more granular team roles

## Phase 3: Compliance depth, transactions and mobile

- [ ] Checkout marketplace (only if chosen): cart, orders, settlement, commission, refunds, GST e-invoicing, TDS, seller payouts
- [ ] Logistics integration (for example Shiprocket) and returns
- [ ] Inventory sync and stock levels
- [ ] Batch and expiry enforcement across stock
- [ ] Storage and cold-chain fields for reagents and kits
- [ ] Licence expiry automation: auto-pause expired sellers and send renewal reminders
- [ ] Prescription (Schedule H/H1/X) verification flow, only after legal review
- [ ] Medical device classification check under Medical Devices Rules, 2017
- [ ] Data protection: consent records stored, data export and deletion under DPDP Act, 2023
- [ ] Android and iOS apps
- [ ] Encryption at rest, field-level encryption for contact data, penetration test

## Open decisions

1. Payment gateway: Razorpay or Cashfree (needed before the free period ends).
2. Free period length: 6 months is built in; confirm the exact end date for the launch communication.
3. Whether Schedule H products will ever be supported.
4. Hosting: Render is already used for other projects.
