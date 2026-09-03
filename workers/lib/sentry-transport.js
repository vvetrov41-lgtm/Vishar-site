// Sentry transport for the privacy-safe operational observability boundary.
//
// This module is the ONLY place that talks to Sentry, and it can only ever see
// a payload that `sanitizeOperationalEvent` already produced. It deliberately
// does not use the Sentry Cloudflare SDK: `withSentry` auto-captures request
// URLs, headers, cookies and raw exceptions, which would bypass the sanitizer
// this project requires. A direct envelope POST keeps the allow-list the single
// source of truth for what leaves the CRM.
//
// Hard boundaries:
//   * no customer/entity IDs, names, email, phone or message content;
//   * no URLs, query strings, request bodies or provider payloads;
//   * no credentials and no raw Error/stack serialization;
//   * DSN comes from runtime config only, never from the repository;
//   * every failure is swallowed so Sentry can never break a CRM request.

const MAX_DSN_LENGTH = 255;
const SEND_TIMEOUT_MS = 2000;
const SENTRY_CLIENT = 'vishar-crm-observability/1.0.0';

// Only these sanitized keys are promoted to Sentry tags. `requestId` is a
// server-generated correlation UUID, never a CRM record identifier.
const TAG_FIELDS = Object.freeze([
  'stage',
  'component',
  'operation',
  'environment',
  'statusClass',
  'errorCode',
  'outcome',
]);
const MEASUREMENT_FIELDS = Object.freeze(['durationMs', 'attempt']);

/**
 * Parses a Sentry DSN into the ingest endpoint and public key.
 * Returns null for anything that is not a well-formed https DSN, so a
 * misconfigured value disables the transport instead of leaking a request.
 */
export function parseSentryDsn(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_DSN_LENGTH) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (!url.username || url.password) return null;
  if (url.search || url.hash) return null;

  const projectId = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!/^\d{1,20}$/.test(projectId)) return null;
  if (!/^[A-Za-z0-9]{16,64}$/.test(url.username)) return null;

  return Object.freeze({
    publicKey: url.username,
    projectId,
    envelopeUrl: `${url.origin}/api/${projectId}/envelope/`,
  });
}

function level(payload) {
  if (payload.outcome === 'failed' || payload.statusClass === '5xx') return 'error';
  if (payload.statusClass === '4xx') return 'warning';
  return 'info';
}

/**
 * Builds a Sentry envelope from an already-sanitized payload. The message is
 * assembled only from allow-listed tokens, so no free text can reach Sentry.
 */
export function buildSentryEnvelope(payload, dsn, { release = null, sentAt = new Date() } = {}) {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const timestamp = sentAt.toISOString();

  const tags = {};
  for (const field of TAG_FIELDS) {
    if (typeof payload[field] === 'string') tags[field] = payload[field];
  }

  const extra = {};
  for (const field of MEASUREMENT_FIELDS) {
    if (typeof payload[field] === 'number') extra[field] = payload[field];
  }
  // The correlation id is kept as a tag so events can be grouped without any
  // CRM record being resolvable from Sentry.
  if (typeof payload.requestId === 'string') tags.requestId = payload.requestId;

  const event = {
    event_id: eventId,
    timestamp: sentAt.getTime() / 1000,
    platform: 'javascript',
    logger: 'vishar-crm-observability',
    level: level(payload),
    environment: typeof payload.environment === 'string' ? payload.environment : 'unknown',
    message: { formatted: payload.event },
    tags,
    extra,
    // Explicitly deny every automatic Sentry enrichment surface.
    request: undefined,
    user: undefined,
    breadcrumbs: [],
    server_name: undefined,
    sdk: { name: 'vishar.crm.observability', version: '1.0.0' },
  };
  if (typeof release === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(release)) {
    event.release = release;
  }

  const header = JSON.stringify({ event_id: eventId, sent_at: timestamp, dsn: null });
  const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json' });
  const body = JSON.stringify(event);
  return { eventId, envelope: `${header}\n${itemHeader}\n${body}\n` };
}

/**
 * Creates the `emit` transport for `createOperationalReporter`. Returns null
 * when Sentry is disabled or misconfigured, which keeps the reporter dormant
 * rather than half-configured.
 */
export function createSentryTransport({
  enabled = false,
  dsn = null,
  release = null,
  fetchImpl = fetch,
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) {
  if (enabled !== true) return null;
  const parsed = parseSentryDsn(dsn);
  if (!parsed) return null;

  return async function emit(payload) {
    const { envelope } = buildSentryEnvelope(payload, parsed, { release });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetchImpl(parsed.envelopeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=${SENTRY_CLIENT}, sentry_key=${parsed.publicKey}`,
        },
        body: envelope,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export const __testing = Object.freeze({
  TAG_FIELDS,
  MEASUREMENT_FIELDS,
  MAX_DSN_LENGTH,
  SEND_TIMEOUT_MS,
  level,
});
