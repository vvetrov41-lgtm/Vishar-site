import { CalendarConnectorError } from './google-calendar.js';

const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const EVENT_ID_PREFIX = 'vishar';
const TRANSIENT_PROVIDER_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function stableGoogleAvailabilityEventId(artistId, blockId) {
  if (!artistId || !blockId) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${artistId}:availability:${blockId}`),
  );
  return `${EVENT_ID_PREFIX}${bytesToHex(new Uint8Array(digest))}`;
}

function availabilityLabel(value) {
  switch (value) {
    case 'day_off': return 'Day off';
    case 'holiday': return 'Holiday';
    case 'personal': return 'Personal';
    case 'other': return 'Unavailable';
    default: throw new CalendarConnectorError('calendar_job_invalid');
  }
}

function zonedDate(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  const part = (type) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new CalendarConnectorError('calendar_job_invalid');
  return `${year}-${month}-${day}`;
}

export function buildGoogleAvailabilityEvent(job, { eventId = null, includeId = false } = {}) {
  if (
    !job?.availability_block_id
    || !job?.artist_id
    || !Number.isInteger(Number(job.calendar_version))
    || !job?.block_kind
    || !job?.start_at
    || !job?.end_at
    || typeof job?.is_all_day !== 'boolean'
    || !job?.artist_timezone
  ) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  const start = new Date(job.start_at);
  const end = new Date(job.end_at);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end <= start) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }

  const event = {
    status: 'confirmed',
    summary: `Time off · ${availabilityLabel(job.block_kind)}`,
    description: [
      'Vishar CRM time off',
      `Availability block ID: ${job.availability_block_id}`,
    ].join('\n'),
    start: job.is_all_day
      ? { date: zonedDate(job.start_at, job.artist_timezone) }
      : { dateTime: start.toISOString(), timeZone: job.artist_timezone },
    end: job.is_all_day
      ? { date: zonedDate(job.end_at, job.artist_timezone) }
      : { dateTime: end.toISOString(), timeZone: job.artist_timezone },
    transparency: 'opaque',
    visibility: 'private',
    extendedProperties: {
      private: {
        visharAvailabilityBlockId: job.availability_block_id,
        visharArtistId: job.artist_id,
        visharCalendarVersion: String(job.calendar_version),
      },
    },
  };

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

export function createGoogleAvailabilityProvider({
  accessToken,
  calendarId = 'primary',
  fetchImpl = fetch,
}) {
  if (!accessToken || calendarId !== 'primary') {
    throw new CalendarConnectorError('calendar_not_configured');
  }

  const calendarPath = `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  async function patchEvent(eventId, job) {
    const response = await fetchImpl(
      `${calendarPath}/${encodeURIComponent(eventId)}?sendUpdates=none`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(buildGoogleAvailabilityEvent(job)),
      },
    );
    const body = await readProviderJson(response);
    if (!response.ok) throw providerError(response.status, body);
    return providerEventResult(body, eventId);
  }

  async function insertEvent(job) {
    const eventId = await stableGoogleAvailabilityEventId(job.artist_id, job.availability_block_id);
    const response = await fetchImpl(`${calendarPath}?sendUpdates=none`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildGoogleAvailabilityEvent(job, {
        eventId,
        includeId: true,
      })),
    });
    if (response.status === 409) return patchEvent(eventId, job);
    const body = await readProviderJson(response);
    if (!response.ok) throw providerError(response.status, body);
    return providerEventResult(body, eventId);
  }

  return {
    async createEvent(job) {
      return insertEvent(job);
    },

    async updateEvent(job) {
      const eventId = job.calendar_event_id
        || await stableGoogleAvailabilityEventId(job.artist_id, job.availability_block_id);
      try {
        return await patchEvent(eventId, job);
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
      const eventId = job.calendar_event_id
        || await stableGoogleAvailabilityEventId(job.artist_id, job.availability_block_id);
      const response = await fetchImpl(
        `${calendarPath}/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (response.ok || response.status === 404 || response.status === 410) {
        return { cancelled: true, providerEventId: eventId };
      }
      throw providerError(response.status, await readProviderJson(response));
    },
  };
}

export const __testing = {
  TRANSIENT_PROVIDER_REASONS,
  availabilityLabel,
  zonedDate,
  providerReasons,
  providerEventResult,
};
