# Lead Generation Spec (Phase 1 core)

HealthMart is a lead-generation marketplace. Buyers post a requirement for free. Verified sellers receive
matching leads in their dashboard and pay a plan to unlock buyer contact details.

## Flow

1. **Buyer enquiry** (`POST /api/enquiries`, public, rate-limited per IP)
   - Required: name, Indian mobile (10 digits), city, category, product description (3-200 chars), `consent: true`.
   - Optional: email, quantity, message.
   - `consent` is mandatory because the contact is shared with suppliers (DPDP Act, 2023).
2. **Matching** (`findMatchingSellers`). A seller is eligible when all of these hold:
   - Company `status = verified`.
   - Licence has not expired (`licence_expiry >= today`).
   - It has a `live` listing in the enquiry's category.
   - It has an active subscription with `leads_used < lead_quota`.
   - Ranking: same city first, then the most remaining quota, then the oldest company. At most 5 sellers per enquiry.
3. **Delivery.** One `lead_deliveries` row per seller with status `delivered`. Each seller gets an email alert through the outbox.
4. **Masked view.** Before unlock the seller sees product, quantity, message, buyer city and a masked name (`R***`). Phone and email are `null`.
5. **Unlock** (`POST /api/seller/leads/:id/unlock`). Runs in one transaction. It consumes one unit of quota and
   reveals contact details. Repeat unlocks are idempotent and consume nothing. If there is no quota, the API returns 402.
6. **Pipeline.** After unlock the seller moves the lead to `contacted`, `converted` or `lost` (`PATCH /api/seller/leads/:id`).

## Data model

| Table | Purpose |
|---|---|
| `enquiries` | Buyer requirement, including contact and consent |
| `lead_deliveries` | Seller x enquiry, with status and unlock time. Unique per pair |
| `subscriptions` | Plan purchased, `lead_quota`, `leads_used`, `listing_limit`, validity window |
| `payment_orders` | Plan orders. Activated only after payment is confirmed |
| `outbox` | Queued emails, SMS and WhatsApp messages. The sender worker comes in Phase 2 |
| `audit_log` | Admin actions, payment confirmations and lead unlocks |

## Guarantees and rules

- Buyer contact is never returned by public search, and is returned to sellers only after unlock.
- A lead is delivered only to sellers who are currently verified and licensed.
- Quota is decremented inside a transaction, so two concurrent unlocks cannot overspend it.
- Schedule H, H1 and X products cannot be listed. Phase 1 has no prescription controls.
- A company that is suspended or rejected has its live listings paused, which removes them from search and matching.

## Open items (later phases)

- Payment gateway checkout (Razorpay or Cashfree) with webhook-driven `confirmPayment`.
- Sender worker for email, SMS (TRAI DLT templates required) and WhatsApp Business.
- Seller API for lead push and fetch, with HMAC-signed webhooks.
- Buyer RFQ board and lead re-routing when a seller does not respond.
