import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 6;
const FILE_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

// The declared type is never trusted: the file's leading bytes must match.
const TYPES = [
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/** Accepts a data URL (data:image/jpeg;base64,...) and returns the verified bytes. */
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(422, 'image data URL होना चाहिए');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(422, 'सिर्फ़ JPEG, PNG या WebP images allowed हैं');
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0) throw new HttpError(422, 'Image खाली है');
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image 2 MB से बड़ी है');
  const type = TYPES.find((t) => t.matches(buffer));
  if (!type || type.mime !== m[1]) throw new HttpError(422, 'File की content image type से मेल नहीं खाती');
  return { buffer, mime: type.mime, ext: type.ext };
}

export function storeImage(uploadDir, { buffer, ext }) {
  mkdirSync(uploadDir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(path.join(uploadDir, file), buffer);
  return file;
}

export function removeImageFile(uploadDir, file) {
  try {
    unlinkSync(path.join(uploadDir, file));
  } catch {
    // Already gone is fine.
  }
}

/** Serves only names in the generated format, so no path traversal is possible. */
export function readImage(uploadDir, name) {
  if (!FILE_RE.test(name)) return null;
  try {
    const body = readFileSync(path.join(uploadDir, name));
    const ext = name.split('.').pop();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { body, mime };
  } catch {
    return null;
  }
}
