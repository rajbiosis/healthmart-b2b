import { audit, queueMessage, withTx } from './db.js';
import { getUsableSubscription } from './billing.js';
import { HttpError, int, isEmail, isIndianPhone, oneOf, str } from './util.js';

/** A buyer enquiry goes to at most this many sellers. */
export const MAX_DELIVERIES_PER_ENQUIRY = 5;
const STATUS_AFTER_UNLOCK = ['contacted', 'converted', 'lost'];

const todayIso = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * Picks sellers for an enquiry. A seller qualifies when the company is verified, its licence
 * is still valid, it has a live listing in the category, and it has an active plan with quota.
 * Sellers in the buyer's city come first, then sellers with the most remaining quota.
 */
export function findMatchingSellers(db, { categoryId, city, limit = MAX_DELIVERIES_PER_ENQUIRY }, now = Date.now()) {
  return db
    .prepare(
      `SELECT c.id FROM companies c
        WHERE c.status = 'verified'
          AND c.licence_expiry >= ?
          AND EXISTS (SELECT 1 FROM listings l
                       WHERE l.company_id = c.id AND l.status = 'live' AND l.category_id = ?)
          AND EXISTS (SELECT 1 FROM subscriptions s
                       WHERE s.company_id = c.id AND s.ends_at > ? AND s.leads_used < s.lead_quota)
        ORDER BY (lower(c.city) = lower(?)) DESC,
                 (SELECT COALESCE(SUM(s.lead_quota - s.leads_used), 0) FROM subscriptions s
                   WHERE s.company_id = c.id AND s.ends_at > ?) DESC,
                 c.id ASC
        LIMIT ?`,
    )
    .all(todayIso(now), categoryId, now, city, now, limit)
    .map((r) => r.id);
}

export function createEnquiry(db, input, now = Date.now()) {
  if (input.consent !== true) {
    throw new HttpError(422, 'Contact share करने के लिए buyer की consent (consent: true) ज़रूरी है');
  }
  const buyerName = str(input.buyer_name, 'buyer_name', { max: 100 });
  const buyerPhone = str(input.buyer_phone, 'buyer_phone', { min: 10, max: 10 });
  if (!isIndianPhone(buyerPhone)) throw new HttpError(422, 'buyer_phone valid 10-digit Indian number होना चाहिए');
  const buyerEmail = input.buyer_email ? str(input.buyer_email, 'buyer_email', { max: 254 }).toLowerCase() : null;
  if (buyerEmail && !isEmail(buyerEmail)) throw new HttpError(422, 'buyer_email invalid है');
  const buyerCity = str(input.buyer_city, 'buyer_city', { max: 100 });
  const categoryId = int(input.category_id, 'category_id', { min: 1 });
  const productQuery = str(input.product_query, 'product_query', { min: 3, max: 200 });
  const quantity = int(input.quantity, 'quantity', { min: 1, max: 1_000_000_000, optional: true });
  const message = str(input.message, 'message', { max: 1000, optional: true });

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!category) throw new HttpError(422, 'category_id invalid है');

  return withTx(db, () => {
    const result = db
      .prepare(
        `INSERT INTO enquiries(buyer_name,buyer_phone,buyer_email,buyer_city,category_id,product_query,quantity,message)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(buyerName, buyerPhone, buyerEmail, buyerCity, categoryId, productQuery, quantity, message);
    const enquiryId = Number(result.lastInsertRowid);

    const sellers = findMatchingSellers(db, { categoryId, city: buyerCity }, now);
    const insDelivery = db.prepare("INSERT INTO lead_deliveries(enquiry_id,company_id,status) VALUES (?,?,'delivered')");
    const ownerEmail = db.prepare(
      'SELECT u.email FROM companies c JOIN users u ON u.id = c.owner_user_id WHERE c.id = ?',
    );
    for (const companyId of sellers) {
      insDelivery.run(enquiryId, companyId);
      const owner = ownerEmail.get(companyId);
      if (owner) {
        queueMessage(
          db,
          'email',
          owner.email,
          `नया lead आया है: "${productQuery}" (${buyerCity}, qty ${quantity ?? 'N/A'}). Dashboard में जाकर unlock करें।`,
        );
      }
    }
    return { id: enquiryId, status: 'received' };
  });
}

function maskName(name) {
  return `${name.charAt(0)}***`;
}

function shapeLead(row) {
  const locked = row.status === 'delivered';
  return {
    id: row.id,
    status: row.status,
    locked,
    category: row.category,
    product_query: row.product_query,
    quantity: row.quantity,
    message: row.message,
    buyer_city: row.buyer_city,
    buyer_name: locked ? maskName(row.buyer_name) : row.buyer_name,
    buyer_phone: locked ? null : row.buyer_phone,
    buyer_email: locked ? null : row.buyer_email,
    delivered_at: row.delivered_at,
    unlocked_at: row.unlocked_at,
  };
}

const LEAD_SELECT = `
  SELECT d.id, d.status, d.delivered_at, d.unlocked_at,
         e.buyer_name, e.buyer_phone, e.buyer_email, e.buyer_city,
         e.product_query, e.quantity, e.message, cat.name AS category
    FROM lead_deliveries d
    JOIN enquiries e ON e.id = d.enquiry_id
    JOIN categories cat ON cat.id = e.category_id`;

export function listSellerLeads(db, companyId) {
  return db
    .prepare(`${LEAD_SELECT} WHERE d.company_id = ? ORDER BY d.id DESC LIMIT 200`)
    .all(companyId)
    .map(shapeLead);
}

function getLead(db, companyId, deliveryId) {
  const row = db.prepare(`${LEAD_SELECT} WHERE d.id = ? AND d.company_id = ?`).get(deliveryId, companyId);
  if (!row) throw new HttpError(404, 'Lead नहीं मिली');
  return shapeLead(row);
}

/** Unlocking reveals buyer contact and consumes one unit of the seller's lead quota. */
export function unlockLead(db, companyId, deliveryId, actorUserId, now = Date.now()) {
  const delivery = db
    .prepare('SELECT id, status FROM lead_deliveries WHERE id = ? AND company_id = ?')
    .get(deliveryId, companyId);
  if (!delivery) throw new HttpError(404, 'Lead नहीं मिली');
  if (delivery.status !== 'delivered') return getLead(db, companyId, deliveryId);

  const sub = getUsableSubscription(db, companyId, now);
  if (!sub) throw new HttpError(402, 'Active plan या lead quota उपलब्ध नहीं है');

  withTx(db, () => {
    const quota = db
      .prepare('UPDATE subscriptions SET leads_used = leads_used + 1 WHERE id = ? AND leads_used < lead_quota')
      .run(sub.id);
    if (quota.changes !== 1) throw new HttpError(402, 'Lead quota खत्म हो गया');
    db.prepare("UPDATE lead_deliveries SET status = 'unlocked', unlocked_at = datetime('now') WHERE id = ?").run(
      deliveryId,
    );
    audit(db, actorUserId, 'lead.unlocked', 'lead_delivery', deliveryId);
  });
  return getLead(db, companyId, deliveryId);
}

export function updateLeadStatus(db, companyId, deliveryId, status) {
  const next = oneOf(status, 'status', STATUS_AFTER_UNLOCK);
  const delivery = db
    .prepare('SELECT id, status FROM lead_deliveries WHERE id = ? AND company_id = ?')
    .get(deliveryId, companyId);
  if (!delivery) throw new HttpError(404, 'Lead नहीं मिली');
  if (delivery.status === 'delivered') throw new HttpError(409, 'पहले lead unlock करें');
  db.prepare('UPDATE lead_deliveries SET status = ? WHERE id = ?').run(next, deliveryId);
  return getLead(db, companyId, deliveryId);
}
