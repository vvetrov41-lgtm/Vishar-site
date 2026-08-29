// Request-field and file validation for the durable enquiry intake.
//
// Everything here is server-side and independent of what the browser claims.
// The browser's declared MIME type, its filename and its extension are all
// treated as hints that must agree with the actual bytes.

import { RequestError } from './http.js';

export const MAX_FILES = 3;
export const MIN_FILES = 1;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const PRIVACY_NOTICE_VERSION = '2026-07-29';

export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const EXTENSION_FOR_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const EXTENSIONS_FOR_MIME = {
  'image/jpeg': new Set(['jpg', 'jpeg']),
  'image/png': new Set(['png']),
  'image/webp': new Set(['webp']),
};

const ALLOWED_REPLY_METHODS = new Set(['Email', 'WhatsApp', 'Instagram']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field length caps, applied server-side whatever the form says. */
export const FIELD_LIMITS = {
  name: 120,
  email: 320,
  phone: 80,
  instagram: 80,
  preferredReply: 40,
  travellingFrom: 160,
  projectType: 100,
  placement: 160,
  size: 120,
  coverUp: 40,
  timing: 160,
  idea: 3500,
  source: 200,
  landingPage: 500,
  referrer: 500,
  utmSource: 120,
  utmMedium: 120,
  utmCampaign: 160,
  utmContent: 160,
  utmTerm: 160,
  privacyNoticeVersion: 40,
};

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    // Strip control characters, which have no place in a form field and can be
    // used to forge line breaks in downstream notifications.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

/**
 * Canonicalise only phone formats whose country can be established safely.
 * The public booking form is UK-facing, so an 11-digit UK mobile beginning 07
 * can be converted to E.164. Ambiguous local numbers are preserved verbatim.
 */
export function normalizePhoneForStorage(value) {
  let phone = cleanText(value, FIELD_LIMITS.phone);
  if (!phone) return '';
  if (!/^\+?[-0-9 ()./]+$/.test(phone)) return phone;

  phone = phone.replace('(0)', '');
  if (/[()]/.test(phone)) return phone;

  let digits = phone.replace(/[^0-9]/g, '');
  if (phone.startsWith('+')) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (/^07[0-9]{9}$/.test(digits)) {
    digits = `44${digits.slice(1)}`;
  } else {
    return phone;
  }

  return /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : phone;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function field(form, name) {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Validates the text half of the submission and returns the shape the intake
 * RPC expects. Throws a RequestError with a safe code and message on failure.
 */
export function parseEnquiryFields(form) {
  const idempotencyKey = field(form, 'idempotencyKey').trim();
  if (!isUuid(idempotencyKey)) {
    throw new RequestError('invalid_idempotency_key', 'Please refresh the page and try again.');
  }

  // Honeypot. A real visitor never sees this field.
  if (cleanText(field(form, 'website'), 200)) {
    return { honeypot: true, idempotencyKey };
  }

  const enquiry = {
    name: cleanText(field(form, 'name'), FIELD_LIMITS.name),
    email: cleanText(field(form, 'email'), FIELD_LIMITS.email),
    phone: normalizePhoneForStorage(field(form, 'phone')),
    instagram: cleanText(field(form, 'instagram'), FIELD_LIMITS.instagram),
    preferredReply: cleanText(field(form, 'preferredReply'), FIELD_LIMITS.preferredReply),
    travellingFrom: cleanText(field(form, 'travellingFrom'), FIELD_LIMITS.travellingFrom),
    projectType: cleanText(field(form, 'projectType'), FIELD_LIMITS.projectType),
    placement: cleanText(field(form, 'placement'), FIELD_LIMITS.placement),
    size: cleanText(field(form, 'size'), FIELD_LIMITS.size),
    coverUp: cleanText(field(form, 'coverUp'), FIELD_LIMITS.coverUp),
    timing: cleanText(field(form, 'timing'), FIELD_LIMITS.timing),
    idea: cleanText(field(form, 'idea'), FIELD_LIMITS.idea),
    source: cleanText(field(form, 'source'), FIELD_LIMITS.source) || '/booking/',
    landingPage: cleanText(field(form, 'landingPage'), FIELD_LIMITS.landingPage),
    referrer: cleanText(field(form, 'referrer'), FIELD_LIMITS.referrer),
    utmSource: cleanText(field(form, 'utmSource'), FIELD_LIMITS.utmSource),
    utmMedium: cleanText(field(form, 'utmMedium'), FIELD_LIMITS.utmMedium),
    utmCampaign: cleanText(field(form, 'utmCampaign'), FIELD_LIMITS.utmCampaign),
    utmContent: cleanText(field(form, 'utmContent'), FIELD_LIMITS.utmContent),
    utmTerm: cleanText(field(form, 'utmTerm'), FIELD_LIMITS.utmTerm),
    privacyNoticeVersion: cleanText(
      field(form, 'privacyNoticeVersion'),
      FIELD_LIMITS.privacyNoticeVersion
    ),
  };

  const privacyAcknowledged = field(form, 'privacyAcknowledged') === 'true';

  const required = ['name', 'email', 'preferredReply', 'projectType', 'placement', 'size', 'coverUp', 'idea'];
  if (required.some((key) => !enquiry[key])) {
    throw new RequestError('missing_required_field', 'Please complete all required fields.');
  }

  if (!EMAIL_PATTERN.test(enquiry.email)) {
    throw new RequestError('invalid_email', 'A valid email is required.');
  }

  if (!ALLOWED_REPLY_METHODS.has(enquiry.preferredReply)) {
    throw new RequestError(
      'invalid_preferred_reply',
      'Please choose Email, WhatsApp or Instagram as the preferred reply.'
    );
  }

  if (!privacyAcknowledged || enquiry.privacyNoticeVersion !== PRIVACY_NOTICE_VERSION) {
    throw new RequestError(
      'privacy_notice_not_acknowledged',
      'Please read and acknowledge the current privacy notice.'
    );
  }

  if (enquiry.preferredReply === 'WhatsApp' && !enquiry.phone) {
    throw new RequestError(
      'missing_whatsapp_number',
      'A WhatsApp number is required when WhatsApp is selected.'
    );
  }

  if (enquiry.preferredReply === 'Instagram' && !enquiry.instagram) {
    throw new RequestError(
      'missing_instagram_username',
      'An Instagram username is required when Instagram is selected.'
    );
  }

  return {
    honeypot: false,
    idempotencyKey,
    enquiry: { ...enquiry, privacyAcknowledged },
  };
}

export function extensionFromFilename(filename) {
  if (typeof filename !== 'string') return '';
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Magic-byte check. A file is only accepted when its first bytes match the type
 * it claims to be, so renaming `payload.exe` to `photo.jpg` and declaring
 * `image/jpeg` is not enough.
 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (isRiff && isWebp) return 'image/webp';

  return null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates the uploaded files and returns descriptors for the intake RPC.
 *
 * The returned `safeExtension` is derived from the *sniffed* type, never from
 * the client's filename, and the storage path is built by the database from
 * server-generated UUIDs. The original filename is carried through for the CRM
 * to display but never influences where anything is stored.
 */
export async function parseEnquiryFiles(form) {
  const entries = form.getAll('references').filter((entry) => entry && typeof entry === 'object' && 'arrayBuffer' in entry);

  if (entries.length < MIN_FILES || entries.length > MAX_FILES) {
    throw new RequestError('invalid_file_count', 'Please attach 1–3 reference images.');
  }

  const descriptors = [];

  for (const entry of entries) {
    if (typeof entry.size === 'number' && entry.size > MAX_FILE_BYTES) {
      throw new RequestError('file_too_large', 'Each reference image must be 4 MB or smaller.');
    }

    const declaredType = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (!ALLOWED_MIME_TYPES.has(declaredType)) {
      throw new RequestError('invalid_file_type', 'Reference images must be JPG, PNG or WebP.');
    }

    const declaredExtension = extensionFromFilename(entry.name);
    if (!declaredExtension || !ALLOWED_EXTENSIONS.has(declaredExtension)) {
      throw new RequestError('invalid_file_extension', 'Reference images must be JPG, PNG or WebP.');
    }

    const buffer = new Uint8Array(await entry.arrayBuffer());

    // Checked again on the decoded bytes: `size` is metadata and a stream can
    // disagree with it.
    if (buffer.byteLength === 0) {
      throw new RequestError('empty_file', 'One of the reference images was empty.');
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new RequestError('file_too_large', 'Each reference image must be 4 MB or smaller.');
    }

    const sniffed = sniffImageType(buffer);
    if (!sniffed) {
      throw new RequestError('unrecognised_file_content', 'One of the reference images could not be read as an image.');
    }
    if (sniffed !== declaredType) {
      throw new RequestError('file_content_mismatch', 'One of the reference images did not match its file type.');
    }
    if (!EXTENSIONS_FOR_MIME[sniffed]?.has(declaredExtension)) {
      throw new RequestError(
        'file_extension_mismatch',
        'One of the reference images did not match its filename extension.'
      );
    }

    descriptors.push({
      bytes: buffer,
      mime_type: sniffed,
      safe_extension: EXTENSION_FOR_MIME[sniffed],
      byte_size: buffer.byteLength,
      checksum: await sha256Hex(buffer),
      original_filename: cleanText(entry.name, 255) || null,
    });
  }

  return descriptors;
}
