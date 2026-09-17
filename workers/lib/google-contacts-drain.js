import { SupabaseError, createSupabaseClient } from './supabase.js';
import {
  CalendarConnectorError,
  loadArtistTokenRecord,
  refreshGoogleAccessToken,
} from './google-calendar.js';
import {
  createGoogleContactsProvider,
  validateGoogleContactsRoute,
  validateGoogleContactsTokenScope,
} from './google-contacts.js';

const MAX_DRAIN_LIMIT = 20;
const DEFAULT_DRAIN_LIMIT = 10;
const DEFAULT_LEASE_SECONDS = 120;

function randomWorkerId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `google-contacts-${suffix}`;
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
    : 'google_contacts_connector_error';
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function validateClaimedJob(job) {
  if (
    !job?.outbox_id
    || !job?.artist_id
    || !job?.client_id
    || !Number.isInteger(Number(job?.attempt_count))
    || !Number.isInteger(Number(job?.max_attempts))
  ) {
    throw new CalendarConnectorError('google_contact_job_invalid');
  }
  return {
    ...job,
    attempt_count: Number(job.attempt_count),
    max_attempts: Number(job.max_attempts),
  };
}

async function recordResult(supabase, job, workerId, result) {
  return supabase.rpc('record_google_contact_outbox_result', {
    p_outbox_id: job.outbox_id,
    p_worker_id: workerId,
    p_succeeded: result.succeeded,
    p_result_code: result.succeeded ? result.resultCode : null,
    p_error_code: result.succeeded ? null : result.errorCode,
  });
}

async function resolveGoogleContactsRoute(supabase, claimed) {
  try {
    return await supabase.rpc('resolve_outbox_route', {
      p_outbox_id: claimed.outbox_id,
    });
  } catch (error) {
    if (
      error instanceof SupabaseError
      && error.status >= 400
      && error.status < 500
      && error.status !== 401
      && error.status !== 403
      && error.status !== 429
    ) {
      throw new CalendarConnectorError('google_contacts_not_enabled');
    }
    throw error;
  }
}

async function providerForJob(job, route, env, fetchImpl, cache) {
  validateGoogleContactsRoute(route, job);
  const existing = cache.get(job.artist_id);
  if (existing) return existing;

  const promise = (async () => {
    const tokenRecord = validateGoogleContactsTokenScope(
      await loadArtistTokenRecord(env, job, route),
    );
    const accessToken = await refreshGoogleAccessToken(
      env,
      tokenRecord.refreshToken,
      fetchImpl,
    );
    const provider = createGoogleContactsProvider({ accessToken, fetchImpl });
    await provider.warmSearch();
    return {
      provider,
      seenPhones: new Set(),
    };
  })();

  cache.set(job.artist_id, promise);
  return promise;
}

async function processJob(job, env, supabase, workerId, fetchImpl, providerCache) {
  const claimed = validateClaimedJob(job);
  if (claimed.job_valid !== true) {
    await recordResult(supabase, claimed, workerId, {
      succeeded: true,
      resultCode: 'skipped_invalid',
    });
    return { outboxId: claimed.outbox_id, outcome: 'skipped_invalid' };
  }

  const resolved = await resolveGoogleContactsRoute(supabase, claimed);
  const route = firstRow(resolved);
  const state = await providerForJob(claimed, route, env, fetchImpl, providerCache);

  const phone = claimed.phone_normalized;
  if (state.seenPhones.has(phone)) {
    await recordResult(supabase, claimed, workerId, {
      succeeded: true,
      resultCode: 'existing',
    });
    return { outboxId: claimed.outbox_id, outcome: 'existing' };
  }

  if (await state.provider.hasExactPhone(phone)) {
    state.seenPhones.add(phone);
    await recordResult(supabase, claimed, workerId, {
      succeeded: true,
      resultCode: 'existing',
    });
    return { outboxId: claimed.outbox_id, outcome: 'existing' };
  }

  await state.provider.createContact(claimed);
  state.seenPhones.add(phone);
  await recordResult(supabase, claimed, workerId, {
    succeeded: true,
    resultCode: 'created',
  });
  return { outboxId: claimed.outbox_id, outcome: 'created' };
}

export async function drainGoogleContactsOutbox(env, {
  fetchImpl = fetch,
  limit = DEFAULT_DRAIN_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  workerId = randomWorkerId(),
} = {}) {
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('claim_google_contact_outbox', {
    p_worker_id: workerId,
    p_limit: safeLimit(limit),
    p_lease_seconds: leaseSeconds,
  });
  const jobs = Array.isArray(claimed) ? claimed : [];
  const results = [];
  const providerCache = new Map();

  for (const rawJob of jobs) {
    let job = rawJob;
    try {
      job = validateClaimedJob(rawJob);
      results.push(await processJob(
        job,
        env,
        supabase,
        workerId,
        fetchImpl,
        providerCache,
      ));
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (job?.outbox_id) {
        try {
          await recordResult(supabase, job, workerId, {
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
    created: results.filter((item) => item.outcome === 'created').length,
    existing: results.filter((item) => item.outcome === 'existing').length,
    skippedInvalid: results.filter((item) => item.outcome === 'skipped_invalid').length,
    failed: results.filter((item) => item.outcome === 'failed').length,
    unrecorded: results.filter((item) => item.outcome === 'unrecorded').length,
    results,
  };
}

export const __testing = {
  safeLimit,
  safeErrorCode,
  validateClaimedJob,
  resolveGoogleContactsRoute,
};
