const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_ENVELOPE_VERSION = 1;
const EVENT_ID_PREFIX = 'vishar';
const CALENDAR_KEY_PREFIX = 'google_calendar_';
const ARTIST_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const GOOGLE_EVENT_VISIBILITIES = new Set(['default', 'public', 'private']);
const GOOGLE_EVENT_COLOR_IDS = new Set(Array.from({ length: 11 }, (_, index) => String(index + 1)));
const GOOGLE_EVENT_LABEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOOGLE_EVENT_LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const TRANSIENT_PROVIDER_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

export class CalendarConnectorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CalendarConnectorError';
    this.code = code;
  }
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlBytes(value) {
  if (typeof value !== 'string' || !value) {
    throw new CalendarConnectorError('calendar_token_invalid');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    throw new CalendarConnectorError('calendar_token_invalid');
  }
}

function decodeEncryptionKey(value) {
  const bytes = base64UrlBytes(value);
  if (bytes.length !== 32) {
    throw new CalendarConnectorError('calendar_encryption_key_invalid');
  }
  return bytes;
}

async function encryptionKey(value, usages) {
  return crypto.subtle.importKey(
    'raw',
    decodeEncryptionKey(value),
    'AES-GCM',
    false,
    usages,
  );
}

export async function encryptTokenRecord(value, encryptionSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(encryptionSecret, ['encrypt']),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    v: TOKEN_ENVELOPE_VERSION,
    iv: base64Url(iv),
    data: base64Url(new Uint8Array(encrypted)),
  });
}

export async function decryptTokenRecord(rawEnvelope, encryptionSecret) {
  let envelope;
  try {
    envelope = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
  } catch {
    throw new CalendarConnectorError('calendar_token_invalid');
  }
  if (
    envelope?.v !== TOKEN_ENVELOPE_VERSION
    || typeof envelope.iv !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    throw new CalendarConnectorError('calendar_token_invalid');
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlBytes(envelope.iv) },
      await encryptionKey(encryptionSecret, ['decrypt']),
      base64UrlBytes(envelope.data),
    );
    const record = JSON.parse(new TextDecoder().decode(decrypted));
    if (
      typeof record?.refreshToken !== 'string'
      || !record.refreshToken
      || typeof record?.accountEmail !== 'string'
      || !record.accountEmail
    ) {
      throw new CalendarConnectorError('calendar_token_invalid');
    }
    return record;
  } catch (error) {
    if (error instanceof CalendarConnectorError) throw error;
    throw new CalendarConnectorError('calendar_token_invalid');
  }
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeEventVisibility(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CalendarConnectorError('calendar_visibility_invalid');
  }
  const normalized = value.trim().toLowerCase();
  if (!GOOGLE_EVENT_VISIBILITIES.has(normalized)) {
    throw new CalendarConnectorError('calendar_visibility_invalid');
  }
  return normalized;
}

function normalizeEventColorId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !GOOGLE_EVENT_COLOR_IDS.has(value.trim())) {
    throw new CalendarConnectorError('calendar_event_color_invalid');
  }
  return value.trim();
}

function normalizeEventLabelId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !GOOGLE_EVENT_LABEL_ID_PATTERN.test(value.trim())) {
    throw new CalendarConnectorError('calendar_event_label_invalid');
  }
  return value.trim().toLowerCase();
}

function normalizeStoredEventLabelId(value) {
  if (typeof value !== 'string' || !GOOGLE_EVENT_LABEL_ID_PATTERN.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

function normalizeArtistDisplayName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CalendarConnectorError('calendar_artist_display_name_invalid');
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 80) {
    throw new CalendarConnectorError('calendar_artist_display_name_invalid');
  }
  return cleaned;
}

function normalizeEventLabelName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CalendarConnectorError('calendar_event_label_target_invalid');
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 50) {
    throw new CalendarConnectorError('calendar_event_label_target_invalid');
  }
  return cleaned;
}

function normalizeEventLabelColor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !GOOGLE_EVENT_LABEL_COLOR_PATTERN.test(value.trim())) {
    throw new CalendarConnectorError('calendar_event_label_target_invalid');
  }
  return value.trim().toLowerCase();
}

// Every value the projection needs comes from the backend-only outbox route:
// the owning artist slug is baked into the selector by a database trigger, the
// Google account is the one Supabase pinned at connect time, and event
// presentation is the server-owned `configuration.presentation` blob. Nothing
// here enumerates artists, so onboarding one is a database row, not a deploy.
export function artistCalendarConfig(route, artistId) {
  const configuration = route?.configuration && typeof route.configuration === 'object'
    ? route.configuration
    : {};
  const integrationKey = typeof route?.integration_key === 'string' ? route.integration_key : '';
  const alias = integrationKey.startsWith(CALENDAR_KEY_PREFIX)
    ? integrationKey.slice(CALENDAR_KEY_PREFIX.length)
    : '';
  const expectedEmail = normalizeEmail(route?.external_account_label);

  if (
    !artistId
    || route?.artist_id !== artistId
    || !ARTIST_SLUG_PATTERN.test(alias)
    || !expectedEmail
    || (typeof configuration.artist_slug === 'string' && configuration.artist_slug !== alias)
  ) {
    throw new CalendarConnectorError('artist_route_unconfigured');
  }

  const presentation = configuration.presentation && typeof configuration.presentation === 'object'
    ? configuration.presentation
    : {};
  const eventLabelName = normalizeEventLabelName(presentation.event_label_name);
  const eventLabelColor = normalizeEventLabelColor(presentation.event_label_color);
  if (Boolean(eventLabelName) !== Boolean(eventLabelColor)) {
    throw new CalendarConnectorError('calendar_event_label_target_invalid');
  }

  return {
    alias,
    artistId,
    integrationKey,
    expectedEmail,
    eventVisibility: normalizeEventVisibility(presentation.event_visibility),
    eventDisplayName: normalizeArtistDisplayName(presentation.event_display_name),
    eventColorId: normalizeEventColorId(presentation.event_color_id),
    eventLabelName,
    eventLabelColor,
  };
}

export function validateCalendarRoute(route, job) {
  if (
    !route
    || route.outbox_id !== job.outbox_id
    || route.artist_id !== job.artist_id
    || route.kind !== job.kind
    || route.integration_type !== 'calendar'
    || route.provider !== 'google'
  ) {
    throw new CalendarConnectorError('provider_route_invalid');
  }

  const artist = artistCalendarConfig(route, job.artist_id);
  const configuration = route.configuration;

  if (
    configuration.calendar_id !== 'primary'
    || configuration.connection_mode !== 'worker_oauth'
    || configuration.oauth_scope !== 'calendar.events'
  ) {
    throw new CalendarConnectorError('provider_route_invalid');
  }

  return {
    artist,
    calendarId: 'primary',
    eventVisibility: artist.eventVisibility,
    eventDisplayName: artist.eventDisplayName,
    eventColorId: artist.eventColorId,
  };
}

export async function loadArtistTokenRecord(env, job, route) {
  if (!env?.CALENDAR_OAUTH_TOKENS || !env?.CALENDAR_TOKEN_ENCRYPTION_KEY) {
    throw new CalendarConnectorError('calendar_not_configured');
  }

  const { artist } = validateCalendarRoute(route, job);
  const rawEnvelope = await env.CALENDAR_OAUTH_TOKENS.get(`artist:${job.artist_id}`);
  if (!rawEnvelope) {
    throw new CalendarConnectorError('calendar_not_configured');
  }

  const record = await decryptTokenRecord(rawEnvelope, env.CALENDAR_TOKEN_ENCRYPTION_KEY);
  if (normalizeEmail(record.accountEmail) !== artist.expectedEmail) {
    throw new CalendarConnectorError('google_account_mismatch');
  }
  if (typeof record.scope === 'string' && !record.scope.split(/\s+/).includes(GOOGLE_SCOPE)) {
    throw new CalendarConnectorError('calendar_scope_missing');
  }

  return {
    ...record,
    eventLabelId: normalizeStoredEventLabelId(record.eventLabelId),
  };
}

export async function loadArtistRefreshToken(env, job, route) {
  return (await loadArtistTokenRecord(env, job, route)).refreshToken;
}

export async function refreshGoogleAccessToken(env, refreshToken, fetchImpl = fetch) {
  if (!env?.GOOGLE_OAUTH_CLIENT_ID || !env?.GOOGLE_OAUTH_CLIENT_SECRET || !refreshToken) {
    throw new CalendarConnectorError('calendar_not_configured');
  }

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
    if (body.error === 'invalid_grant' || response.status === 401) {
      throw new CalendarConnectorError('calendar_oauth_expired');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new CalendarConnectorError('calendar_provider_unavailable');
    }
    throw new CalendarConnectorError('calendar_provider_rejected');
  }
  return body.access_token;
}

export async function revokeGoogleRefreshToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) return false;
  const response = await fetchImpl(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
  });
  return response.ok;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function stableGoogleEventId(artistId, sessionId) {
  if (!artistId || !sessionId) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${artistId}:${sessionId}`),
  );
  return `${EVENT_ID_PREFIX}${bytesToHex(new Uint8Array(digest))}`;
}

function appointmentLabel(value) {
  switch (value) {
    case 'tattoo_session': return 'Tattoo session';
    case 'in_person_consultation': return 'In-person consultation';
    case 'video_consultation': return 'Video consultation';
    case 'touch_up': return 'Touch-up';
    default: throw new CalendarConnectorError('calendar_job_invalid');
  }
}

function safeDisplayName(value) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    : '';
  return cleaned ? cleaned.slice(0, 120) : 'Client';
}

export function buildGoogleEvent(job, {
  eventId = null,
  includeId = false,
  crmReturnUrl = '',
  visibility = null,
  artistDisplayName = null,
  colorId = null,
  eventLabelId = null,
} = {}) {
  if (
    !job?.session_id
    || !job?.artist_id
    || !Number.isInteger(Number(job.calendar_version))
    || !job?.start_at
    || !job?.end_at
  ) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  const start = new Date(job.start_at);
  const end = new Date(job.end_at);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end <= start) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  const crmUrl = crmReturnUrl ? new URL(crmReturnUrl) : null;
  if (crmUrl) {
    crmUrl.searchParams.set('appointment', job.session_id);
  }

  const normalizedArtistDisplayName = normalizeArtistDisplayName(artistDisplayName);
  const eventSummary = [
    normalizedArtistDisplayName,
    appointmentLabel(job.appointment_type),
    safeDisplayName(job.client_display_name),
  ].filter(Boolean).join(' · ');

  const event = {
    status: 'confirmed',
    summary: eventSummary,
    description: [
      'Vishar CRM appointment',
      `Appointment ID: ${job.session_id}`,
      crmUrl ? `CRM: ${crmUrl.toString()}` : null,
    ].filter(Boolean).join('\n'),
    start: { dateTime: start.toISOString(), timeZone: 'Europe/London' },
    end: { dateTime: end.toISOString(), timeZone: 'Europe/London' },
    transparency: 'opaque',
    extendedProperties: {
      private: {
        visharSessionId: job.session_id,
        visharArtistId: job.artist_id,
        visharCalendarVersion: String(job.calendar_version),
      },
    },
  };

  const normalizedVisibility = normalizeEventVisibility(visibility);
  const normalizedLabelId = normalizeEventLabelId(eventLabelId);
  const normalizedColorId = normalizeEventColorId(colorId);
  if (normalizedVisibility) event.visibility = normalizedVisibility;
  if (normalizedLabelId) event.eventLabelId = normalizedLabelId;
  else if (normalizedColorId) event.colorId = normalizedColorId;
  if (includeId) event.id = eventId;
  return event;
}

function providerReasons(body) {
  const errors = Array.isArray(body?.error?.errors) ? body.error.errors : [];
  return errors
    .map((item) => typeof item?.reason === 'string' ? item.reason : '')
    .filter(Boolean);
}

function providerError(status, body = {}) {
  if (status === 404 || status === 410) return new CalendarConnectorError('calendar_event_not_found');
  if (status === 401) return new CalendarConnectorError('calendar_oauth_expired');
  if (
    status === 429
    || status >= 500
    || (status === 403 && providerReasons(body).some((reason) => TRANSIENT_PROVIDER_REASONS.has(reason)))
  ) {
    return new CalendarConnectorError('calendar_provider_unavailable');
  }
  return new CalendarConnectorError('calendar_provider_rejected');
}

function providerEventResult(body, fallbackEventId) {
  if (body?.status === 'cancelled') {
    throw new CalendarConnectorError('calendar_provider_rejected');
  }
  return { providerEventId: body?.id || fallbackEventId };
}

async function readProviderJson(response) {
  if (response.status === 204) return {};
  return response.json().catch(() => ({}));
}

export function createGoogleCalendarProvider({
  accessToken,
  calendarId = 'primary',
  crmReturnUrl = '',
  eventVisibility = null,
  artistDisplayName = null,
  eventColorId = null,
  eventLabelId = null,
  fetchImpl = fetch,
}) {
  if (!accessToken || calendarId !== 'primary') {
    throw new CalendarConnectorError('calendar_not_configured');
  }
  const visibility = normalizeEventVisibility(eventVisibility);
  const displayName = normalizeArtistDisplayName(artistDisplayName);
  const colorId = normalizeEventColorId(eventColorId);
  const labelId = normalizeEventLabelId(eventLabelId);

  const calendarPath = `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const mutationQuery = new URLSearchParams({ sendUpdates: 'none' });
  if (labelId) mutationQuery.set('eventLabelVersion', '1');
  const mutationQueryString = mutationQuery.toString();

  const projectionOptions = (extra = {}) => ({
    crmReturnUrl,
    visibility,
    artistDisplayName: displayName,
    colorId,
    eventLabelId: labelId,
    ...extra,
  });

  async function patchEvent(eventId, job) {
    const response = await fetchImpl(
      `${calendarPath}/${encodeURIComponent(eventId)}?${mutationQueryString}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(buildGoogleEvent(job, projectionOptions())),
      },
    );
    const body = await readProviderJson(response);
    if (!response.ok) throw providerError(response.status, body);
    return providerEventResult(body, eventId);
  }

  async function insertEvent(job) {
    const eventId = await stableGoogleEventId(job.artist_id, job.session_id);
    const response = await fetchImpl(`${calendarPath}?${mutationQueryString}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildGoogleEvent(job, projectionOptions({
        eventId,
        includeId: true,
      }))),
    });
    if (response.status === 409) {
      return patchEvent(eventId, job);
    }
    const body = await readProviderJson(response);
    if (!response.ok) throw providerError(response.status, body);
    return providerEventResult(body, eventId);
  }

  return {
    async createEvent(job) {
      return insertEvent(job);
    },

    async updateEvent(job) {
      if (!job.calendar_event_id) {
        throw new CalendarConnectorError('calendar_event_missing');
      }
      try {
        return await patchEvent(job.calendar_event_id, job);
      } catch (error) {
        if (
          error instanceof CalendarConnectorError
          && error.code === 'calendar_event_not_found'
        ) {
          return insertEvent(job);
        }
        throw error;
      }
    },

    async cancelEvent(job) {
      if (!job.calendar_event_id) {
        throw new CalendarConnectorError('calendar_event_missing');
      }
      const response = await fetchImpl(
        `${calendarPath}/${encodeURIComponent(job.calendar_event_id)}?sendUpdates=none`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (response.ok || response.status === 404 || response.status === 410) {
        return { cancelled: true };
      }
      throw providerError(response.status, await readProviderJson(response));
    },
  };
}

export const __testing = {
  GOOGLE_SCOPE,
  TOKEN_ENVELOPE_VERSION,
  GOOGLE_EVENT_VISIBILITIES,
  GOOGLE_EVENT_COLOR_IDS,
  GOOGLE_EVENT_LABEL_ID_PATTERN,
  TRANSIENT_PROVIDER_REASONS,
  normalizeEmail,
  normalizeEventVisibility,
  normalizeEventColorId,
  normalizeEventLabelId,
  normalizeStoredEventLabelId,
  normalizeArtistDisplayName,
  normalizeEventLabelName,
  normalizeEventLabelColor,
  appointmentLabel,
  providerReasons,
  providerEventResult,
};