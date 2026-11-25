import { DATE_RE, HttpError, int, oneOf, str } from './util.js';
import { FREE_PERIOD_LISTING_CAP, getActiveSubscription, isFreePeriod } from './billing.js';
import { audit, withTx } from './db.js';
import { MAX_IMAGES_PER_LISTING, parseImageDataUrl, removeImageFile, storeImage } from './media.js';

export const FREE_LISTING_LIMIT = 3;
const SCHEDULES = ['none', 'H', 'H1', 'X'];
const EDITABLE = ['category_id', 'title', 'description', 'composition', 'pack_size', 'batch_number', 'expiry_date', 'schedule', 'price_paise', 'moq'];

export function listCategories(db) {
  return db.prepare('SELECT id, name FROM categories ORDER BY name').all();
}

/** Validates the full set of listing fields. Used for both create and (merged) edit. */
function parseListing(db, f, now) {
  const categoryId = int(f.category_id, 'category_id', { min: 1 });
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
    throw new HttpError(422, 'category_id invalid है');
  }
  const schedule = oneOf(f.schedule ?? 'none', 'schedule', SCHEDULES);
  if (schedule !== 'none') {
    // Scheduled drugs need prescription controls that Phase 1 does not implement.
    throw new HttpError(422, 'Schedule H/H1/X वाले products Phase 1 में list नहीं किए जा सकते');
  }
  const expiry = f.expiry_date ? str(f.expiry_date, 'expiry_date', { max: 10 }) : null;
  if (expiry && (!DATE_RE.test(expiry) || Date.parse(expiry) <= now)) {
    throw new HttpError(422, 'expiry_date YYYY-MM-DD में और आज से आगे होनी चाहिए');
  }
  return {
    category_id: categoryId,
    title: str(f.title, 'title', { max: 150 }),
    description: str(f.description, 'description', { max: 3000, optional: true }),
    composition: str(f.composition, 'composition', { max: 500, optional: true }),
    pack_size: str(f.pack_size, 'pack_size', { max: 100, optional: true }),
    batch_number: str(f.batch_number, 'batch_number', { max: 100, optional: true }),
    expiry_date: expiry,
    schedule,
    price_paise: int(f.price_paise, 'price_paise', { min: 0, optional: true }),
    moq: int(f.moq ?? 1, 'moq', { min: 1, max: 10_000_000 }),
  };
}

export function createListing(db, company, input, now = Date.now()) {
  if (company.status !== 'verified') {
    throw new HttpError(403, 'Company verify होने के बाद ही listing हो सकती है');
  }
  const fields = parseListing(db, input, now);
  const sub = getActiveSubscription(db, company.id, now);
  let limit = sub ? sub.listing_limit : FREE_LISTING_LIMIT;
  if (isFreePeriod(db, now)) limit = FREE_PERIOD_LISTING_CAP;
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
      fields.category_id,
      fields.title,
      fields.description,
      fields.composition,
      fields.pack_size,
      fields.batch_number,
      fields.expiry_date,
      fields.schedule,
      fields.price_paise,
      fields.moq,
    );
  return { id: Number(result.lastInsertRowid), status: 'pending' };
}

function getOwnListing(db, company, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ? AND company_id = ?').get(listingId, company.id);
  if (!row) throw new HttpError(404, 'Listing नहीं मिली');
  return row;
}

/**
 * Edits a listing. Changing content of a live listing sends it back to admin review,
 * because batch, expiry and composition are what buyers rely on. Rejected listings
 * return to pending once corrected.
 */
export function updateListing(db, company, listingId, input, actorUserId, now = Date.now()) {
  const current = getOwnListing(db, company, listingId);
  const merged = { ...current };
  for (const k of EDITABLE) if (input[k] !== undefined) merged[k] = input[k];
  const fields = parseListing(db, merged, now);

  const changed = EDITABLE.some((k) => String(fields[k] ?? '') !== String(current[k] ?? ''));
  let status = current.status;
  if (changed && (current.status === 'live' || current.status === 'rejected')) status = 'pending';

  db.prepare(
    `UPDATE listings SET category_id=?, title=?, description=?, composition=?, pack_size=?, batch_number=?,
            expiry_date=?, schedule=?, price_paise=?, moq=?, status=? WHERE id = ?`,
  ).run(
    fields.category_id,
    fields.title,
    fields.description,
    fields.composition,
    fields.pack_size,
    fields.batch_number,
    fields.expiry_date,
    fields.schedule,
    fields.price_paise,
    fields.moq,
    status,
    listingId,
  );
  audit(db, actorUserId, 'listing.edited', 'listing', listingId);
  return { id: listingId, status, needs_review: status === 'pending' && current.status !== 'pending' };
}

/** Pause hides a live listing from search and lead matching without a review. Resume puts it back live. */
export function setListingPaused(db, company, listingId, paused, actorUserId) {
  const current = getOwnListing(db, company, listingId);
  if (paused) {
    if (current.status === 'paused') return { id: listingId, status: 'paused' };
    if (current.status !== 'live') throw new HttpError(409, 'सिर्फ़ live listing pause हो सकती है');
    db.prepare("UPDATE listings SET status = 'paused' WHERE id = ?").run(listingId);
    audit(db, actorUserId, 'listing.paused', 'listing', listingId);
    return { id: listingId, status: 'paused' };
  }
  if (current.status !== 'paused') throw new HttpError(409, 'सिर्फ़ paused listing resume हो सकती है');
  if (company.status !== 'verified') throw new HttpError(409, 'Company verified नहीं है, listing resume नहीं हो सकती');
  db.prepare("UPDATE listings SET status = 'live' WHERE id = ?").run(listingId);
  audit(db, actorUserId, 'listing.resumed', 'listing', listingId);
  return { id: listingId, status: 'live' };
}

export function listImages(db, listingId) {
  return db
    .prepare('SELECT id, file, mime, bytes FROM listing_images WHERE listing_id = ? ORDER BY position, id')
    .all(listingId)
    .map((r) => ({ id: r.id, url: `/uploads/${r.file}`, bytes: r.bytes }));
}

export function addListingImage(db, company, listingId, dataUrl, uploadDir, actorUserId) {
  const listing = getOwnListing(db, company, listingId);
  const image = parseImageDataUrl(dataUrl);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM listing_images WHERE listing_id = ?').get(listingId);
  if (count >= MAX_IMAGES_PER_LISTING) {
    throw new HttpError(422, `एक listing में अधिकतम ${MAX_IMAGES_PER_LISTING} photos हो सकती हैं`);
  }
  const file = storeImage(uploadDir, image);
  return withTx(db, () => {
    db.prepare('INSERT INTO listing_images(listing_id,file,mime,bytes,position) VALUES (?,?,?,?,?)').run(
      listing.id,
      file,
      image.mime,
      image.buffer.length,
      count,
    );
    audit(db, actorUserId, 'listing.image_added', 'listing', listing.id);
    return { images: listImages(db, listing.id) };
  });
}

export function removeListingImage(db, company, listingId, imageId, uploadDir, actorUserId) {
  getOwnListing(db, company, listingId);
  const img = db.prepare('SELECT file FROM listing_images WHERE id = ? AND listing_id = ?').get(imageId, listingId);
  if (!img) throw new HttpError(404, 'Photo नहीं मिली');
  db.prepare('DELETE FROM listing_images WHERE id = ?').run(imageId);
  removeImageFile(uploadDir, img.file);
  audit(db, actorUserId, 'listing.image_removed', 'listing', listingId);
  return { images: listImages(db, listingId) };
}

export function listSellerListings(db, companyId) {
  const rows = db
    .prepare(
      `SELECT l.id, l.category_id, l.title, l.description, l.composition, l.pack_size, l.batch_number,
              l.expiry_date, l.schedule, l.moq, l.price_paise, l.status, cat.name AS category
         FROM listings l JOIN categories cat ON cat.id = l.category_id
        WHERE l.company_id = ? ORDER BY l.id DESC`,
    )
    .all(companyId);
  return rows.map((r) => ({ ...r, images: listImages(db, r.id) }));
}

/** Public search: live, non-expired listings from verified companies. No contact details. */
export function searchListings(db, { q = '', categoryId = null, city = '' } = {}) {
  const term = q.replace(/[%_]/g, '').trim();
  const like = term ? `%${term}%` : null;
  return db
    .prepare(
      `SELECT l.id, l.title, l.composition, l.pack_size, l.moq, l.price_paise,
              cat.name AS category, c.name AS company_name, c.city AS company_city,
              (SELECT li.file FROM listing_images li WHERE li.listing_id = l.id ORDER BY li.position, li.id LIMIT 1) AS image_file
         FROM listings l
         JOIN companies c ON c.id = l.company_id
         JOIN categories cat ON cat.id = l.category_id
        WHERE l.status = 'live' AND c.status = 'verified'
          AND (l.expiry_date IS NULL OR l.expiry_date >= date('now'))
          AND (? IS NULL OR l.category_id = ?)
          AND (? = '' OR lower(c.city) = lower(?))
          AND (? IS NULL OR l.title LIKE ? OR l.composition LIKE ? OR l.description LIKE ?)
        ORDER BY l.id DESC LIMIT 50`,
    )
    .all(categoryId, categoryId, city, city, like, like, like, like)
    .map(({ image_file, ...r }) => ({ ...r, image_url: image_file ? `/uploads/${image_file}` : null }));
}
