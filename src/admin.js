import { audit, queueMessage, withTx } from './db.js';
import { HttpError, oneOf } from './util.js';

const COMPANY_STATUSES = ['pending', 'verified', 'rejected', 'suspended'];
const LISTING_STATUSES = ['pending', 'live', 'rejected', 'paused'];

export function listCompanies(db, status = null) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.gst_number, c.licence_type, c.licence_number, c.licence_expiry,
              c.city, c.state, c.pincode, c.status, u.email AS owner_email
         FROM companies c JOIN users u ON u.id = c.owner_user_id
        WHERE (? IS NULL OR c.status = ?)
        ORDER BY c.id DESC LIMIT 200`,
    )
    .all(status, status);
}

export function setCompanyStatus(db, actorUserId, companyId, status) {
  const next = oneOf(status, 'status', COMPANY_STATUSES);
  const company = db
    .prepare('SELECT c.id, c.name, u.email FROM companies c JOIN users u ON u.id = c.owner_user_id WHERE c.id = ?')
    .get(companyId);
  if (!company) throw new HttpError(404, 'Company नहीं मिली');

  withTx(db, () => {
    db.prepare('UPDATE companies SET status = ? WHERE id = ?').run(next, companyId);
    if (next !== 'verified') {
      // Hiding listings from search and from lead matching for any non-verified company.
      db.prepare("UPDATE listings SET status = 'paused' WHERE company_id = ? AND status = 'live'").run(companyId);
    }
    audit(db, actorUserId, `company.${next}`, 'company', companyId);
    queueMessage(db, 'email', company.email, `आपकी company "${company.name}" की status अब: ${next}`);
  });
  return { id: companyId, status: next };
}

export function listListings(db, status = 'pending') {
  return db
    .prepare(
      `SELECT l.id, l.title, l.composition, l.pack_size, l.batch_number, l.expiry_date, l.price_paise,
              l.moq, l.status, cat.name AS category, c.name AS company_name, c.status AS company_status
         FROM listings l
         JOIN companies c ON c.id = l.company_id
         JOIN categories cat ON cat.id = l.category_id
        WHERE l.status = ?
        ORDER BY l.id ASC LIMIT 200`,
    )
    .all(status);
}

export function setListingStatus(db, actorUserId, listingId, status) {
  const next = oneOf(status, 'status', LISTING_STATUSES);
  const listing = db
    .prepare(
      `SELECT l.id, c.status AS company_status FROM listings l JOIN companies c ON c.id = l.company_id WHERE l.id = ?`,
    )
    .get(listingId);
  if (!listing) throw new HttpError(404, 'Listing नहीं मिली');
  if (next === 'live' && listing.company_status !== 'verified') {
    throw new HttpError(409, 'Company verified नहीं है, listing live नहीं हो सकती');
  }
  db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(next, listingId);
  audit(db, actorUserId, `listing.${next}`, 'listing', listingId);
  return { id: listingId, status: next };
}
