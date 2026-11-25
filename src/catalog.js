import { HttpError, DATE_RE, int, oneOf, str } from './util.js';
import { getActiveSubscription } from './billing.js';

export const FREE_LISTING_LIMIT = 3;
const SCHEDULES = ['none', 'H', 'H1', 'X'];

export function getCompanyByOwner(db, userId) {
  return db.prepare('SELECT * FROM companies WHERE owner_user_id = ?').get(userId) ?? null;
}

export function listCategories(db) {
  return db.prepare('SELECT id, name FROM categories ORDER BY name').all();
}

export function createListing(db, company, input, now = Date.now()) {
  if (company.status !== 'verified') {
    throw new HttpError(403, 'Company verify होने के बाद ही listing हो सकती है');
  }

  const title = str(input.title, 'title', { max: 150 });
  const categoryId = int(input.category_id, 'category_id', { min: 1 });
  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!category) throw new HttpError(422, 'category_id invalid है');

  const schedule = oneOf(input.schedule ?? 'none', 'schedule', SCHEDULES);
  if (schedule !== 'none') {
    // Scheduled drugs need prescription controls that Phase 1 does not implement.
    throw new HttpError(422, 'Schedule H/H1/X वाले products Phase 1 में list नहीं किए जा सकते');
  }

  const expiry = input.expiry_date ? str(input.expiry_date, 'expiry_date', { max: 10 }) : null;
  if (expiry && (!DATE_RE.test(expiry) || Date.parse(expiry) <= now)) {
    throw new HttpError(422, 'expiry_date YYYY-MM-DD में और आज से आगे होनी चाहिए');
  }

  const price = int(input.price_paise, 'price_paise', { min: 0, optional: true });
  const moq = int(input.moq ?? 1, 'moq', { min: 1, max: 10_000_000 });

  const sub = getActiveSubscription(db, company.id, now);
  const limit = sub ? sub.listing_limit : FREE_LISTING_LIMIT;
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM listings WHERE company_id = ? AND status != 'rejected'")
    .get(company.id);
  if (count >= limit) throw new HttpError(402, `Listing limit (${limit}) पूरी हो चुकी है, plan upgrade करें`);

  const result = db
    .prepare(
      `INSERT INTO listings(company_id,category_id,title,description,composition,pack_size,batch_number,
                            expiry_date,schedule,price_paise,moq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      company.id,
      categoryId,
      title,
      str(input.description, 'description', { max: 3000, optional: true }),
      str(input.composition, 'composition', { max: 500, optional: true }),
      str(input.pack_size, 'pack_size', { max: 100, optional: true }),
      str(input.batch_number, 'batch_number', { max: 100, optional: true }),
      expiry,
      schedule,
      price,
      moq,
    );
  return { id: Number(result.lastInsertRowid), status: 'pending' };
}

export function listSellerListings(db, companyId) {
  return db
    .prepare(
      `SELECT l.id, l.title, l.composition, l.pack_size, l.moq, l.price_paise, l.expiry_date, l.status,
              cat.name AS category
         FROM listings l JOIN categories cat ON cat.id = l.category_id
        WHERE l.company_id = ? ORDER BY l.id DESC`,
    )
    .all(companyId);
}

/** Public search. Returns product cards only; seller contact details are never exposed here. */
export function searchListings(db, { q = '', categoryId = null, city = '' } = {}) {
  const term = q.replace(/[%_]/g, '').trim();
  const like = term ? `%${term}%` : null;
  return db
    .prepare(
      `SELECT l.id, l.title, l.composition, l.pack_size, l.moq, l.price_paise,
              cat.name AS category, c.name AS company_name, c.city AS company_city
         FROM listings l
         JOIN companies c ON c.id = l.company_id
         JOIN categories cat ON cat.id = l.category_id
        WHERE l.status = 'live' AND c.status = 'verified'
          AND (? IS NULL OR l.category_id = ?)
          AND (? = '' OR lower(c.city) = lower(?))
          AND (? IS NULL OR l.title LIKE ? OR l.composition LIKE ? OR l.description LIKE ?)
        ORDER BY l.id DESC LIMIT 50`,
    )
    .all(categoryId, categoryId, city, city, like, like, like, like);
}
