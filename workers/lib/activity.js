// Contextual audit writes from the Worker.
//
// The Worker never inserts into `activity_log` directly. The intake RPCs write
// the events that matter — creation, completion, failure — inside the same
// transaction as the change they describe, so an audit row and the thing it
// records can never disagree.
//
// This module builds the safe metadata those RPCs are given, and is the single
// place that decides what an audit row is allowed to contain. It mirrors the
// database-side guard in migration 0005: if a forbidden key ever reaches the
// database, the insert is rejected outright.

const FORBIDDEN_METADATA_KEYS = new Set([
  'email', 'email_address', 'phone', 'phone_number', 'whatsapp', 'instagram',
  'full_name', 'name', 'idea', 'message', 'body', 'notes', 'note',
  'original_filename', 'filename', 'file_content', 'content', 'data',
  'signed_url', 'url', 'token', 'access_token', 'refresh_token',
  'authorization', 'api_key', 'key', 'secret', 'password', 'ip', 'ip_address',
]);

/**
 * Strips anything that would turn the audit trail into a second copy of the
 * client's personal data. Returns a plain object safe to send to the database.
 */
export function safeMetadata(fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    safe[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return safe;
}

export function intakeMetadata({ referenceNumber, fileCount }) {
  return safeMetadata({
    reference_number: referenceNumber,
    file_count: fileCount,
  });
}

export const __testing = { FORBIDDEN_METADATA_KEYS };
