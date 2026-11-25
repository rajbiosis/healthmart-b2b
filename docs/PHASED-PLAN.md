# Phased Plan

Scope is taken from the IndiaMART-style feature list, plus healthcare-specific requirements.
Status: `[x]` done in this repo, `[ ]` pending.

## Phase 1: Lead generation and core marketplace (in progress)

Goal: a verified seller can list products, a buyer can post a requirement, and the seller can unlock and manage the lead.

- [x] Roles: buyer, seller, admin. Session auth with hashed passwords, HttpOnly cookies, 12h expiry, login rate limiting
- [x] Seller registration with company, GST, licence type and expiry, city and pincode
- [x] Admin verification of companies (verified, rejected, suspended), with email notice to owner
- [x] Multi-level categories (seeded, admin-extendable in Phase 2)
- [x] Listings with batch number, expiry date, composition, pack size, MOQ and price. Admin approval before going live
- [x] Schedule H/H1/X products blocked
- [x] Public search with city and category filters. No contact data exposed
- [x] Buyer enquiry with consent, rate limiting, and matching to up to 5 eligible sellers
- [x] Seller lead inbox with masked buyers and quota-based unlock
- [x] Lead pipeline status (contacted, converted, lost)
- [x] Plans (Starter, Growth, Pro) and order flow with admin-confirmed payment
- [x] Outbox queue for email alerts and audit log
- [x] Basic web UI for search and requirement form
- [ ] Seller dashboard UI (login, listings form, lead inbox, plan purchase)
- [ ] Admin UI (verification queue, listing approval)
- [ ] Photo upload with compression and CDN (S3 or Cloudinary)
- [ ] Payment gateway checkout (Razorpay or Cashfree) with webhook-driven activation
- [ ] Email sender worker (SMTP or Resend). SMS and WhatsApp in Phase 2
- [ ] Production hosting, HTTPS, backups, and error monitoring

## Phase 2: Scale the lead engine and seller tools

- [ ] Lead push and fetch API for sellers: API keys, HMAC-signed webhooks, retries, idempotency keys, rate limits, sandbox
- [ ] Notifications over SMS (TRAI DLT templates) and WhatsApp Business
- [ ] Buyer RFQ board and re-routing when a seller does not respond in time
- [ ] Lead assignment to team members, follow-up reminders and duplicate detection
- [ ] In-app chat between buyer and seller (after unlock)
- [ ] Ratings, reviews, complaints and dispute flow
- [ ] Trust score and verified badge
- [ ] Seller storefront page with its own slug
- [ ] Bulk catalog upload (CSV and Excel)
- [ ] Featured and boosted listings (paid visibility)
- [ ] Seller analytics: views, enquiries, conversion
- [ ] Moderation queue for fake or counterfeit reports
- [ ] Admin reports, user bans and audit log viewer
- [ ] Support ticketing and grievance officer details (Consumer Protection (E-Commerce) Rules, 2020)
- [ ] SEO: server-side rendering, sitemap, schema.org markup, meta tags
- [ ] Multi-language UI (Hindi first, then regional)

## Phase 3: Transactions, compliance depth and mobile

- [ ] Checkout marketplace (only if chosen): cart, orders, settlement, commission, refunds, GST e-invoicing, TDS, seller payouts
- [ ] Logistics integration (for example Shiprocket) and returns
- [ ] Inventory sync and stock levels
- [ ] Batch and expiry enforcement across stock
- [ ] Storage and cold-chain fields for reagents and kits
- [ ] Licence expiry automation: auto-pause expired sellers and send renewal reminders
- [ ] Prescription (Schedule H/H1/X) verification flow, only after legal review
- [ ] Medical device classification check under Medical Devices Rules, 2017
- [ ] Data protection: consent records, data export and deletion under DPDP Act, 2023
- [ ] Android and iOS apps
- [ ] Encryption at rest, field-level encryption for contact data, penetration test

## Decisions still needed

1. Revenue model: lead-gen (current build) versus checkout marketplace.
2. Payment gateway provider and whether a payment aggregator licence is needed.
3. Whether Schedule H products (prescription-only) will ever be supported.
4. Hosting target (Render is already in use for other projects).
