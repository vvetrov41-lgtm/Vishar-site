import { createSupabaseClient } from './supabase.js';
import {
  CalendarConnectorError,
  createGoogleCalendarProvider,
  loadArtistTokenRecord,
  refreshGoogleAccessToken,
  validateCalendarRoute,
} from './google-calendar.js';

const CALENDAR_KINDS = new Set(['calendar_create', 'calendar_update', 'calendar_cancel']);
const MAX_DRAIN_LIMIT = 20;
const DEFAULT_DRAIN_LIMIT = 10;
const DEFAULT_LEASE_SECONDS = 120;

function randomWorkerId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `calendar-worker-${suffix}`;
}

function safeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_DRAIN_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_DRAIN_LIMIT);
}

function safeErrorCode(error) {
  const code = error instanceof CalendarConnectorError ? error.code : error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'calendar_connector_error';
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function validateClaimedJob(job) {
  const jobVersion = Number(job?.calendar_version);
  const currentVersion = Number(job?.current_calendar_version);
  if (
    !job?.outbox_id
    || !job?.artist_id
    || !job?.session_id
    || !CALENDAR_KINDS.has(job.kind)
    || !Number.isInteger(jobVersion)
    || jobVersion < 0
    || !Number.isInteger(currentVersion)
    || currentVersion < 0
    || job?.job_valid !== true
  ) {
    throw new CalendarConnectorError('calendar_job_invalid');
  }
  return {
    ...job,
    calendar_version: jobVersion,
    current_calendar_version: currentVersion,
    obsolete: jobVersion < currentVersion,
  };
}

async function recordResult(supabase, job, workerId, result) {
  return supabase.rpc('record_calendar_outbox_result', {
    p_outbox_id: job.outbox_id,
    p_worker_id: workerId,
    p_calendar_version: job.calendar_version,
    p_succeeded: result.succeeded,
    p_event_id: result.eventId || null,
    p_error_code: result.succeeded ? null : result.errorCode,
  });
}

async function processJob(job, env, supabase, workerId, fetchImpl) {
  const claimed = validateClaimedJob(job);

  if (claimed.obsolete) {
    await recordResult(supabase, claimed, workerId, { succeeded: true });
    return { outboxId: claimed.outbox_id, outcome: 'obsolete' };
  }

  if (claimed.calendar_version > claimed.current_calendar_version) {
    throw new CalendarConnectorError('calendar_version_invalid');
  }

  const resolved = await supabase.rpc('resolve_outbox_route', {
    p_outbox_id: claimed.outbox_id,
  });
  const route = firstRow(resolved);
  const {
    calendarId,
    eventVisibility,
    eventDisplayName,
    eventColorId,
  } = validateCalendarRoute(route, claimed, env);
  const tokenRecord = await loadArtistTokenRecord(env, claimed, route);
  const accessToken = await refreshGoogleAccessToken(env, tokenRecord.refreshToken, fetchImpl);
  const provider = createGoogleCalendarProvider({
    accessToken,
    calendarId,
    crmReturnUrl: env.CRM_APPOINTMENTS_URL,
    eventVisibility,
    artistDisplayName: eventDisplayName,
    eventColorId,
    eventLabelId: tokenRecord.eventLabelId,
    fetchImpl,
  });

  let result;
  if (claimed.kind === 'calendar_create') {
    result = await provider.createEvent(claimed);
  } else if (claimed.kind === 'calendar_update') {
    result = await provider.updateEvent(claimed);
  } else {
    await provider.cancelEvent(claimed);
    result = { providerEventId: null };
  }

  await recordResult(supabase, claimed, workerId, {
    succeeded: true,
    eventId: result.providerEventId,
  });
  return { outboxId: claimed.outbox_id, outcome: 'succeeded' };
}

export async function drainCalendarOutbox(env, {
  fetchImpl = fetch,
  limit = DEFAULT_DRAIN_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  workerId = randomWorkerId(),
} = {}) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('claim_calendar_outbox', {
    p_worker_id: workerId,
    p_limit: safeLimit(limit),
    p_lease_seconds: leaseSeconds,
  });
  const jobs = Array.isArray(claimed) ? claimed : [];
  const results = [];

  for (const rawJob of jobs) {
    let job = rawJob;
    try {
      job = validateClaimedJob(rawJob);
      results.push(await processJob(job, env, supabase, workerId, fetchImpl));
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (job?.outbox_id) {
        try {
          const parsedVersion = Number(job?.calendar_version);
          await recordResult(supabase, {
            ...job,
            calendar_version: Number.isInteger(parsedVersion) ? parsedVersion : null,
          }, workerId, {
            succeeded: false,
            errorCode,
          });
          results.push({ outboxId: job.outbox_id, outcome: 'failed', errorCode });
          continue;
        } catch {
          results.push({ outboxId: job.outbox_id, outcome: 'unrecorded', errorCode });
          continue;
        }
      }
      results.push({ outboxId: null, outcome: 'invalid', errorCode });
    }
  }

  return {
    claimed: jobs.length,
    succeeded: results.filter((item) => item.outcome === 'succeeded').length,
    obsolete: results.filter((item) => item.outcome === 'obsolete').length,
    failed: results.filter((item) => item.outcome === 'failed').length,
    unrecorded: results.filter((item) => item.outcome === 'unrecorded').length,
    results,
  };
}

export const __testing = {
  CALENDAR_KINDS,
  safeLimit,
  safeErrorCode,
  validateClaimedJob,
};
