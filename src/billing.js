import { HttpError, oneOf, str } from './util.js';
import { audit, withTx } from './db.js';

export function freePeriodEndsAt(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'free_period_ends_at'").get();
  return row ? new Date(row.value) : null;
}

/**
 * During the launch period every lead is free: no plan, no quota, no listing limit beyond an abuse guard.
 * After it ends, the paid model applies automatically with no manual switch.
 */
export function isFreePeriod(db, now = Date.now()) {
  const until = freePeriodEndsAt(db);
  return Boolean(until && now < until.getTime());
}

export const FREE_PERIOD_LISTING_CAP = 100;

export function listPlans(db) {
  return db
    .prepare('SELECT code, name, price_paise, lead_quota, listing_limit, duration_days FROM plans ORDER BY price_paise')
    .all();
}

/** Latest subscription that has not expired yet (used for listing limits). */
export function getActiveSubscription(db, companyId, now = Date.now()) {
  return (
    db
      .prepare('SELECT * FROM subscriptions WHERE company_id = ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1')
      .get(companyId, now) ?? null
  );
}

/** Subscription that can pay for one more lead unlock. */
export function getUsableSubscription(db, companyId, now = Date.now()) {
  return (
    db
      .prepare(
        `SELECT * FROM subscriptions
          WHERE company_id = ? AND ends_at > ? AND leads_used < lead_quota
          ORDER BY ends_at ASC LIMIT 1`,
      )
      .get(companyId, now) ?? null
  );
}

export function createPaymentOrder(db, company, input) {
  const planCode = oneOf(str(input.plan_code, 'plan_code', { max: 30 }), 'plan_code', listPlans(db).map((p) => p.code));
  const plan = db.prepare('SELECT * FROM plans WHERE code = ?').get(planCode);
  const result = db
    .prepare('INSERT INTO payment_orders(company_id,plan_code,amount_paise) VALUES (?,?,?)')
    .run(company.id, plan.code, plan.price_paise);
  return {
    id: Number(result.lastInsertRowid),
    plan_code: plan.code,
    amount_paise: plan.price_paise,
    // Gateway checkout (Razorpay/Cashfree) plugs in here in Phase 2; until then an admin confirms payment.
    status: 'created',
  };
}

/**
 * Marks an order as paid and activates the subscription. A payment-gateway webhook
 * will call this same function; in Phase 1 an admin calls it after verifying payment.
 */
export function confirmPayment(db, orderId, providerRef, actorUserId, now = Date.now()) {
  const order = db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(orderId);
  if (!order) throw new HttpError(404, 'Order नहीं मिला');
  if (order.status === 'paid') return { order_id: order.id, already_paid: true };

  const plan = db.prepare('SELECT * FROM plans WHERE code = ?').get(order.plan_code);
  return withTx(db, () => {
    const upd = db
      .prepare("UPDATE payment_orders SET status = 'paid', provider_ref = ? WHERE id = ? AND status = 'created'")
      .run(providerRef ?? null, orderId);
    if (upd.changes !== 1) throw new HttpError(409, 'Order की status बदल चुकी है');

    const endsAt = now + plan.duration_days * 24 * 60 * 60 * 1000;
    const sub = db
      .prepare(
        'INSERT INTO subscriptions(company_id,plan_code,lead_quota,listing_limit,starts_at,ends_at) VALUES (?,?,?,?,?,?)',
      )
      .run(order.company_id, plan.code, plan.lead_quota, plan.listing_limit, now, endsAt);
    audit(db, actorUserId, 'payment.confirmed', 'payment_order', orderId);
    return { order_id: orderId, subscription_id: Number(sub.lastInsertRowid), already_paid: false };
  });
}

export function getSubscriptionSummary(db, companyId, now = Date.now()) {
  const sub = getActiveSubscription(db, companyId, now);
  if (!sub) return null;
  return {
    plan_code: sub.plan_code,
    lead_quota: sub.lead_quota,
    leads_used: sub.leads_used,
    listing_limit: sub.listing_limit,
    ends_at: new Date(sub.ends_at).toISOString(),
  };
}
