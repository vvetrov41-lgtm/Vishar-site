// WhatsApp outbox drain.
//
// Structure follows the Telegram drain: bounded claim, strict validation of
// the claimed job, artist route resolution, one provider call, then a
// lease-owned acknowledgement. Delivery is at least once. If Meta accepts a
// message and the acknowledgement then fails, the lease is left to expire and
// a later attempt may resend rather than silently losing the message; that
// outcome is reported as `unrecorded` instead of being claimed as a rollback.

import { ProviderRouteError } from './provider-routing.js';
import { createSupabaseClient } from './supabase.js';
import { sendWhatsappMessage } from './whatsapp.js';

const WHATSAPP_KIND = 'whatsapp_message';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[a-z][a-z0-9_-]{2,127}$/;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const WA_ID = /^[0-9]{6,20}$/;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_LIMIT = 10;

export class WhatsappDrainError extends Error {
  constructor(code) {
    super('WhatsApp outbox job is unavailable');
    this.name = 'WhatsappDrainError';
    this.code = code;
  }
}

function randomWorkerId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `whatsapp-worker-${suffix}`;
}

function validateWorkerInputs(workerId, leaseSeconds) {
  if (!WORKER_ID.test(workerId ?? '')) throw new WhatsappDrainError('whatsapp_worker_id_invalid');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new WhatsappDrainError('whatsapp_lease_invalid');
  }
}

function validateExplicitInputs(outboxId, workerId, leaseSeconds) {
  if (!UUID.test(outboxId ?? '')) throw new WhatsappDrainError('whatsapp_outbox_id_invalid');
  validateWorkerInputs(workerId, leaseSeconds);
}

function validateAutomaticInputs(workerId, limit, leaseSeconds) {
  validateWorkerInputs(workerId, leaseSeconds);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new WhatsappDrainError('whatsapp_limit_invalid');
  }
}

function validateClaimedJob(job, expectedOutboxId = null) {
  const attemptCount = Number(job?.attempt_count);
  const maxAttempts = Number(job?.max_attempts);
  const body = job?.body;
  if (
    !UUID.test(job?.outbox_id ?? '')
    || (expectedOutboxId !== null && job.outbox_id !== expectedOutboxId)
    || !UUID.test(job?.artist_id ?? '')
    || !UUID.test(job?.whatsapp_message_id ?? '')
    || !UUID.test(job?.conversation_id ?? '')
    || job?.kind !== WHATSAPP_KIND
    || !INTEGRATION_KEY.test(job?.integration_key ?? '')
    || !WA_ID.test(job?.contact_wa_id ?? '')
    || typeof body !== 'string'
    || !body.trim()
    || !Number.isInteger(attemptCount)
    || attemptCount < 0
    || !Number.isInteger(maxAttempts)
    || maxAttempts < 1
    || job?.job_valid !== true
  ) {
    throw new WhatsappDrainError('whatsapp_job_invalid');
  }
  return { ...job, attempt_count: attemptCount, max_attempts: maxAttempts };
}

/**
 * The route the database returns must agree with the job in every field that
 * decides where the message goes. A disagreement means the outbox row and the
 * integration disagree about the artist, which must never be resolved by
 * guessing.
 */
function validateWhatsappRoute(route, job) {
  if (
    route?.outbox_id !== job.outbox_id
    || route?.artist_id !== job.artist_id
    || route?.kind !== WHATSAPP_KIND
    || route?.integration_type !== 'whatsapp'
    || route?.provider !== 'meta_cloud_api'
    || route?.integration_key !== job.integration_key
  ) {
    throw new ProviderRouteError('provider_route_invalid');
  }
  return route;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeErrorCode(error) {
  const code = error instanceof WhatsappDrainError || error instanceof ProviderRouteError
    ? error.code
    : error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'whatsapp_connector_error';
}

async function recordResult(supabase, outboxId, workerId, succeeded, {
  providerMessageId = null,
  errorCode = null,
} = {}) {
  return supabase.rpc('record_whatsapp_outbox_result', {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_succeeded: succeeded,
    p_provider_message_id: succeeded ? providerMessageId : null,
    p_error_code: succeeded ? null : errorCode,
  });
}

async function recordFailure(supabase, outboxId, workerId, errorCode) {
  try {
    await recordResult(supabase, outboxId, workerId, false, { errorCode });
    return { outcome: 'failed', errorCode };
  } catch {
    return { outcome: 'unrecorded', errorCode };
  }
}

export async function processClaimedWhatsappJob(env, {
  supabase,
  claimedJob,
  workerId,
  expectedOutboxId = null,
  fetchImpl = fetch,
}) {
  let job;
  try {
    job = validateClaimedJob(claimedJob, expectedOutboxId);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    if (!UUID.test(claimedJob?.outbox_id ?? '')) {
      return { outcome: 'unrecorded', errorCode };
    }
    return recordFailure(supabase, claimedJob.outbox_id, workerId, errorCode);
  }

  let delivery;
  try {
    const resolved = await supabase.rpc('resolve_outbox_route', {
      p_outbox_id: job.outbox_id,
    });
    const route = validateWhatsappRoute(firstRow(resolved), job);
    delivery = await sendWhatsappMessage(
      env,
      route,
      { to: job.contact_wa_id, body: job.body },
      fetchImpl
    );
  } catch (error) {
    return recordFailure(supabase, job.outbox_id, workerId, safeErrorCode(error));
  }

  if (!delivery.delivered) {
    return recordFailure(
      supabase,
      job.outbox_id,
      workerId,
      safeErrorCode({ code: delivery.errorCode })
    );
  }

  try {
    await recordResult(supabase, job.outbox_id, workerId, true, {
      providerMessageId: delivery.providerMessageId,
    });
    return { outcome: 'succeeded' };
  } catch {
    // Meta has already accepted the message. Letting the lease expire keeps
    // delivery at least once, so a later attempt may duplicate the WhatsApp
    // message rather than silently dropping it.
    return { outcome: 'unrecorded', errorCode: 'whatsapp_acknowledgement_failed' };
  }
}

export async function drainWhatsappOutboxById(env, {
  outboxId,
  workerId = randomWorkerId(),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateExplicitInputs(outboxId, workerId, leaseSeconds);
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimedRows = await supabase.rpc('claim_whatsapp_outbox_by_id', {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });

  const rows = Array.isArray(claimedRows)
    ? claimedRows
    : claimedRows == null
      ? []
      : [claimedRows];
  if (rows.length === 0) {
    return { claimed: false, outboxId, outcome: 'not_claimed' };
  }
  if (rows.length !== 1) {
    throw new WhatsappDrainError('whatsapp_claim_invalid');
  }

  const processed = await processClaimedWhatsappJob(env, {
    supabase,
    claimedJob: rows[0],
    workerId,
    expectedOutboxId: outboxId,
    fetchImpl,
  });
  return { claimed: true, outboxId, ...processed };
}

export async function drainWhatsappOutbox(env, {
  workerId = randomWorkerId(),
  limit = DEFAULT_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateAutomaticInputs(workerId, limit, leaseSeconds);
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('claim_whatsapp_outbox', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  const rows = Array.isArray(claimed)
    ? claimed
    : claimed == null
      ? []
      : [claimed];
  if (rows.length > limit) {
    throw new WhatsappDrainError('whatsapp_claim_invalid');
  }

  const aggregate = { claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0 };
  for (const claimedJob of rows) {
    const processed = await processClaimedWhatsappJob(env, {
      supabase,
      claimedJob,
      workerId,
      fetchImpl,
    });
    aggregate[processed.outcome] += 1;
  }
  return aggregate;
}

export const __testing = {
  WHATSAPP_KIND,
  safeErrorCode,
  validateAutomaticInputs,
  validateClaimedJob,
  validateExplicitInputs,
  validateWhatsappRoute,
};
