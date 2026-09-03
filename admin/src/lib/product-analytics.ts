// Privacy-safe product analytics for the Vishar CRM.
//
// This module deliberately does not use `posthog-js`. That SDK's value is
// autocapture, session replay, person profiles and persistent identity, all of
// which are forbidden here. Instead it sends a small, explicit event to the
// PostHog capture endpoint with a fixed property allow-list.
//
// Hard boundaries, enforced by the registry below rather than by convention:
//   * only the four registered events may be sent;
//   * every property is a bounded enum or small integer, never free text;
//   * no CRM record ID, client name, email, phone, message body or raw URL;
//   * no operator or customer identity, and no reusable distinct ID;
//   * `$process_person_profile: false`, so PostHog creates no person;
//   * only approved PostHog ingestion hosts are accepted;
//   * transport failure is swallowed so analytics cannot break the CRM.

const APPROVED_HOSTS = Object.freeze([
  'eu.i.posthog.com',
  'us.i.posthog.com',
]);
const CAPTURE_TIMEOUT_MS = 2000;
const PROJECT_KEY_RE = /^phc_[A-Za-z0-9]{16,64}$/;

/**
 * Normalized CRM screens. A screen name is looked up from this list, never
 * derived from `location.pathname`, so no record ID or query string can leak
 * through a route.
 */
export const SCREENS = Object.freeze([
  'dashboard', 'enquiries', 'enquiry_detail', 'clients', 'client_detail',
  'projects', 'project_detail', 'appointments', 'appointment_detail',
  'calendar', 'availability', 'inbox', 'conversation_detail', 'payments',
  'booking_sources', 'integrations', 'team', 'account', 'settings', 'other',
] as const);

const ENQUIRY_OUTCOMES = Object.freeze(['converted', 'declined', 'archived'] as const);
const APPOINTMENT_KINDS = Object.freeze(['consultation', 'session', 'touch_up', 'other'] as const);
const APPOINTMENT_ORIGINS = Object.freeze(['crm', 'client_action', 'automation'] as const);
const REPLY_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'email', 'telegram'] as const);
const REPLY_OUTCOMES = Object.freeze(['queued', 'failed'] as const);

type Enumerated = readonly string[];

/**
 * The complete set of events the CRM may emit, with the exact property schema
 * for each. Anything not described here is dropped before the network call.
 */
const EVENT_REGISTRY: Readonly<Record<string, Readonly<Record<string, Enumerated | 'small_int'>>>> = Object.freeze({
  crm_screen_viewed: Object.freeze({ screen: SCREENS }),
  crm_enquiry_converted: Object.freeze({ outcome: ENQUIRY_OUTCOMES }),
  crm_appointment_booked: Object.freeze({
    appointment_kind: APPOINTMENT_KINDS,
    origin: APPOINTMENT_ORIGINS,
    lead_time_days_bucket: 'small_int',
  }),
  crm_conversation_reply_outcome: Object.freeze({
    channel: REPLY_CHANNELS,
    outcome: REPLY_OUTCOMES,
  }),
});

export type AnalyticsEvent = keyof typeof EVENT_REGISTRY;

export interface AnalyticsConfig {
  key: string;
  host: string;
}

/**
 * Reads the build-time PostHog configuration. Returns null — meaning analytics
 * stays off — when the key is absent or the host is not an approved PostHog
 * ingestion host. A wrong host is never "corrected": it disables analytics.
 */
export function readAnalyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig | null {
  const key = (env.VITE_POSTHOG_KEY ?? '').trim();
  const host = (env.VITE_POSTHOG_HOST ?? '').trim().toLowerCase();
  if (!PROJECT_KEY_RE.test(key)) return null;
  if (!APPROVED_HOSTS.includes(host)) return null;
  return { key, host };
}

/**
 * A fresh random ID for every single event. PostHog therefore cannot join two
 * events into a session, a person, or an operator's behaviour over time.
 */
function ephemeralDistinctId(): string {
  return `anon-${crypto.randomUUID()}`;
}

function sanitizeProperties(
  event: string,
  raw: Record<string, unknown> | undefined,
): Record<string, string | number> | null {
  const schema = EVENT_REGISTRY[event];
  if (!schema) return null;

  const safe: Record<string, string | number> = {};
  for (const [name, rule] of Object.entries(schema)) {
    const value = raw?.[name];
    if (rule === 'small_int') {
      // Bucketed counts only: never a timestamp, and never precise enough to
      // single out one appointment.
      if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 365) {
        safe[name] = value as number;
      }
      continue;
    }
    if (typeof value === 'string' && rule.includes(value)) safe[name] = value;
  }
  // A required property that failed validation drops the whole event rather
  // than sending a partial one that would be misread as real data.
  if (Object.keys(safe).length !== Object.keys(schema).length) return null;
  return safe;
}

export interface Analytics {
  capture(event: AnalyticsEvent | string, properties?: Record<string, unknown>): Promise<void>;
}

export function createAnalytics(
  config: AnalyticsConfig | null,
  {
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    timeoutMs = CAPTURE_TIMEOUT_MS,
    now = () => new Date(),
  }: {
    fetchImpl?: typeof fetch | null;
    timeoutMs?: number;
    now?: () => Date;
  } = {},
): Analytics {
  const active = config !== null && fetchImpl !== null;

  return Object.freeze({
    async capture(event: AnalyticsEvent | string, properties?: Record<string, unknown>): Promise<void> {
      const safe = sanitizeProperties(event, properties);
      if (!safe || !active || !config || !fetchImpl) return;

      const body = JSON.stringify({
        api_key: config.key,
        event,
        distinct_id: ephemeralDistinctId(),
        timestamp: now().toISOString(),
        properties: {
          ...safe,
          // No person profile, so no person is created or updated in PostHog.
          $process_person_profile: false,
          // PostHog would otherwise infer these from the request. Blanking them
          // keeps the raw URL, referrer and IP-derived geography out of the event.
          $current_url: null,
          $referrer: null,
          $referring_domain: null,
          $ip: null,
          $lib: 'vishar-crm-explicit',
          $lib_version: '1.0.0',
        },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await fetchImpl(`https://${config.host}/i/v0/e/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        // Fail open: a blocked, offline or failing analytics endpoint must never
        // surface to a CRM operator or interrupt a workflow.
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export const __testing = Object.freeze({
  APPROVED_HOSTS,
  EVENT_REGISTRY,
  PROJECT_KEY_RE,
  sanitizeProperties,
  ephemeralDistinctId,
});

/**
 * Maps a CRM route to a normalized screen name. Every dynamic segment is
 * discarded here, which is why no record ID can reach PostHog through a
 * screen view. An unrecognized route reports `other` rather than its path.
 */
export function screenForPath(path: string): Screen {
  const clean = (path || '/').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  const segments = clean.split('/').filter(Boolean);
  const [head] = segments;

  if (!head) return 'dashboard';
  const detail = segments.length > 1;

  switch (head) {
    case 'enquiries': return detail ? 'enquiry_detail' : 'enquiries';
    case 'clients': return detail ? 'client_detail' : 'clients';
    case 'projects': return detail ? 'project_detail' : 'projects';
    case 'appointments': return detail ? 'appointment_detail' : 'appointments';
    // /inbox/:id and /inbox/email/:key are both a single conversation view.
    case 'inbox': return detail ? 'conversation_detail' : 'inbox';
    case 'calendar': return 'calendar';
    case 'availability': return 'availability';
    case 'payments': return 'payments';
    case 'booking-sources': return 'booking_sources';
    case 'integrations': return 'integrations';
    case 'users':
    case 'team': return 'team';
    case 'account': return 'account';
    case 'settings': return 'settings';
    default: return 'other';
  }
}

export type Screen = (typeof SCREENS)[number];

// A single process-wide instance. Analytics is ambient and fail-open, so call
// sites capture without threading a dependency through the component tree.
let instance: Analytics | null = null;

export function initAnalytics(config: AnalyticsConfig | null): void {
  instance = createAnalytics(config);
}

/**
 * Fire-and-forget capture. Never awaited by a CRM workflow and never throws,
 * so an analytics problem cannot change what an operator sees.
 */
export function captureEvent(event: AnalyticsEvent | string, properties?: Record<string, unknown>): void {
  void instance?.capture(event, properties).catch(() => {});
}

export function __resetAnalyticsForTest(next: Analytics | null): void {
  instance = next;
}

/**
 * Buckets a lead time into whole days, capped at a year. A bucket says how far
 * ahead the CRM books; it is not precise enough to identify one appointment,
 * and a malformed or past date reports 0 rather than a negative or a timestamp.
 */
export function leadTimeDaysBucket(startAt: string, now: Date = new Date()): number {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) return 0;
  const days = Math.floor((start - now.getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.min(days, 365);
}
