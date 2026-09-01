// Privacy-safe external operational observability boundary.
//
// This module is intentionally provider-neutral. A later Sentry adapter may use
// it as the only input boundary, but callers cannot pass raw Error objects,
// customer/entity identifiers, message content, provider payloads or secrets.
// Observability must never be able to break the CRM request path.

const SAFE_FIELDS = new Set([
  'event',
  'stage',
  'requestId',
  'component',
  'operation',
  'environment',
  'durationMs',
  'statusClass',
  'errorCode',
  'outcome',
  'attempt',
]);

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_CLASS_RE = /^(?:[1-5]xx|unknown)$/;
const MAX_TOKEN_LENGTH = 120;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPT = 1000;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeToken(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(value)) return null;
  return value;
}

function safeNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function sanitizeField(key, value) {
  if (key === 'requestId') return typeof value === 'string' && UUID_RE.test(value) ? value : null;
  if (key === 'statusClass') return typeof value === 'string' && STATUS_CLASS_RE.test(value) ? value : null;
  if (key === 'durationMs') return safeNumber(value, 0, MAX_DURATION_MS);
  if (key === 'attempt') return Number.isInteger(value) ? safeNumber(value, 0, MAX_ATTEMPT) : null;
  return safeToken(value);
}

/**
 * Produces the only payload shape that an external observability transport may
 * receive. Unknown, nested, malformed or unsafe values are dropped rather than
 * coerced, so arbitrary client text cannot be smuggled through a safe key.
 */
export function sanitizeOperationalEvent(fields = {}) {
  if (!plainObject(fields)) return {};
  const safe = {};

  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    const sanitized = sanitizeField(key, value);
    if (sanitized !== null) safe[key] = sanitized;
  }

  return safe;
}

/**
 * Creates a fail-open reporter. `emit` is an injected transport and is never
 * called while disabled. Transport failures are swallowed and reduced to a
 * bounded status result; they cannot fail the CRM request that reported them.
 */
export function createOperationalReporter({ enabled = false, emit = null } = {}) {
  const active = enabled === true;
  const transport = typeof emit === 'function' ? emit : null;

  return Object.freeze({
    async capture(event, fields = {}) {
      const payload = sanitizeOperationalEvent({ ...fields, event });
      if (!payload.event) return { sent: false, reason: 'invalid_event' };
      if (!active) return { sent: false, reason: 'disabled' };
      if (!transport) return { sent: false, reason: 'transport_unavailable' };

      try {
        await transport(Object.freeze(payload));
        return { sent: true };
      } catch {
        return { sent: false, reason: 'transport_failed' };
      }
    },
  });
}

export const __testing = Object.freeze({
  SAFE_FIELDS,
  MAX_TOKEN_LENGTH,
  MAX_DURATION_MS,
  MAX_ATTEMPT,
});
