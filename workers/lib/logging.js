// Redacted structured logging.
//
// The logger accepts only known-safe field names and drops everything else, so
// adding a new field to a request can never silently start logging personal
// data. The allow-list is the contract; there is no "log the whole object"
// escape hatch.
//
// Never logged, by construction: names, email addresses, phone numbers,
// Instagram handles, tattoo idea text, original filenames, file content,
// signed URLs, tokens, and raw provider response bodies.

const SAFE_FIELDS = new Set([
  'event',
  'stage',
  'requestId',
  'enquiryId',
  'clientId',
  'referenceNumber',
  'fileId',
  'fileCount',
  'fileIndex',
  'byteSize',
  'mimeType',
  'safeExtension',
  'durationMs',
  'status',
  'statusClass',
  'errorCode',
  'replayed',
  'intakeState',
  'outcome',
  'attempt',
  'origin',
  'route',
  'clientConflict',
  'uploadedCount',
  'cleanedUpCount',
  // Model routing. Task, capability, provider and model are operational
  // identifiers chosen by this repository, never client content or credentials.
  'task',
  'capability',
  'provider',
  'model',
  'fallbackUsed',
  'providerAttempts',
  'outputChars',
  'imageCount',
  // A bounded binding-failure token (cf_NNNN or an exception class name),
  // never message text. Held to its own pattern below.
  'errorDetail',
]);

// Fields whose value must also match a closed shape to be kept.
const FIELD_PATTERNS = Object.freeze({
  errorDetail: /^(cf_[0-9]{4}(_[a-z]{1,12})?|[A-Za-z][A-Za-z0-9_]{0,39})$/,
});

// Values are bounded too. A safe field name with an unbounded value would still
// be a way to smuggle a paragraph of client text into the logs.
const MAX_VALUE_LENGTH = 200;

function coerce(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, MAX_VALUE_LENGTH);
}

/**
 * Keeps only allow-listed fields. Unknown keys are counted rather than
 * included, so a dropped field is visible in the logs without its value.
 */
export function redact(fields = {}) {
  const safe = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_FIELDS.has(key)
        && (!FIELD_PATTERNS[key] || (typeof value === 'string' && FIELD_PATTERNS[key].test(value)))) {
      safe[key] = coerce(value);
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) safe.droppedFields = dropped;
  return safe;
}

/** HTTP status reduced to its class, so provider responses cannot leak detail. */
export function statusClass(status) {
  if (!Number.isFinite(status)) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

function emit(level, event, fields) {
  const line = JSON.stringify({ level, ...redact({ ...fields, event }) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(requestId) {
  const base = { requestId };
  return {
    info: (event, fields = {}) => emit('info', event, { ...base, ...fields }),
    warn: (event, fields = {}) => emit('warn', event, { ...base, ...fields }),
    error: (event, fields = {}) => emit('error', event, { ...base, ...fields }),
  };
}

/** Correlation id for one request. Not derived from anything about the client. */
export function newRequestId() {
  return crypto.randomUUID();
}

export const __testing = { SAFE_FIELDS, MAX_VALUE_LENGTH };
