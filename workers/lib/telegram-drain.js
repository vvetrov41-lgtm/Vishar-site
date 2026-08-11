import { ProviderRouteError } from './provider-routing.js';
import { createSupabaseClient } from './supabase.js';
import { buildEnquiryNotification, sendNotification } from './telegram.js';

const TELEGRAM_KIND = 'telegram_notification';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[a-z][a-z0-9_-]{2,127}$/;
const REFERENCE = /^ENQ-[0-9]{4}-[0-9]{4,}$/;
const DEFAULT_LEASE_SECONDS = 120;

export class TelegramDrainError extends Error {
  constructor(code) {
    super('Telegram outbox job is unavailable');
    this.name = 'TelegramDrainError';
    this.code = code;
  }
}

function randomWorkerId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `telegram-worker-${suffix}`;
}

function validateExplicitInputs(outboxId, workerId, leaseSeconds) {
  if (!UUID.test(outboxId ?? '')) throw new TelegramDrainError('telegram_outbox_id_invalid');
  if (!WORKER_ID.test(workerId ?? '')) throw new TelegramDrainError('telegram_worker_id_invalid');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new TelegramDrainError('telegram_lease_invalid');
  }
}

function validateClaimedJob(job, expectedOutboxId) {
  const attemptCount = Number(job?.attempt_count);
  const maxAttempts = Number(job?.max_attempts);
  const fileCount = Number(job?.file_count);
  if (
    job?.outbox_id !== expectedOutboxId
    || !UUID.test(job?.artist_id ?? '')
    || !UUID.test(job?.enquiry_id ?? '')
    || job?.kind !== TELEGRAM_KIND
    || !Number.isInteger(attemptCount)
    || attemptCount < 0
    || !Number.isInteger(maxAttempts)
    || maxAttempts < 1
    || !REFERENCE.test(job?.reference_number ?? '')
    || !Number.isInteger(fileCount)
    || fileCount < 1
    || typeof job?.client_conflict !== 'boolean'
    || job?.job_valid !== true
  ) {
    throw new TelegramDrainError('telegram_job_invalid');
  }
  return {
    ...job,
    attempt_count: attemptCount,
    max_attempts: maxAttempts,
    file_count: fileCount,
  };
}

function validateTelegramRoute(route, job) {
  if (
    route?.outbox_id !== job.outbox_id
    || route?.artist_id !== job.artist_id
    || route?.kind !== TELEGRAM_KIND
    || route?.integration_type !== 'telegram'
    || route?.provider !== 'telegram'
  ) {
    throw new ProviderRouteError('provider_route_invalid');
  }
  return route;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function safeErrorCode(error) {
  const code = error instanceof TelegramDrainError || error instanceof ProviderRouteError
    ? error.code
    : error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'telegram_connector_error';
}

async function recordResult(supabase, outboxId, workerId, succeeded, errorCode = null) {
  return supabase.rpc('record_telegram_outbox_result', {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_succeeded: succeeded,
    p_error_code: succeeded ? null : errorCode,
  });
}

export async function drainTelegramOutboxById(env, {
  outboxId,
  workerId = randomWorkerId(),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateExplicitInputs(outboxId, workerId, leaseSeconds);
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimedRows = await supabase.rpc('claim_telegram_outbox_by_id', {
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
    throw new TelegramDrainError('telegram_claim_invalid');
  }

  let job;
  try {
    job = validateClaimedJob(rows[0], outboxId);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    try {
      await recordResult(supabase, outboxId, workerId, false, errorCode);
      return { claimed: true, outboxId, outcome: 'failed', errorCode };
    } catch {
      return { claimed: true, outboxId, outcome: 'unrecorded', errorCode };
    }
  }

  try {
    const resolved = await supabase.rpc('resolve_outbox_route', {
      p_outbox_id: outboxId,
    });
    const route = validateTelegramRoute(firstRow(resolved), job);
    const notification = await sendNotification(env, route, buildEnquiryNotification({
      referenceNumber: job.reference_number,
      fileCount: job.file_count,
      clientConflict: job.client_conflict,
    }), fetchImpl);

    if (!notification.delivered) {
      const errorCode = safeErrorCode({ code: notification.errorCode });
      await recordResult(supabase, outboxId, workerId, false, errorCode);
      return { claimed: true, outboxId, outcome: 'failed', errorCode };
    }

    await recordResult(supabase, outboxId, workerId, true);
    return { claimed: true, outboxId, outcome: 'succeeded' };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    try {
      await recordResult(supabase, outboxId, workerId, false, errorCode);
      return { claimed: true, outboxId, outcome: 'failed', errorCode };
    } catch {
      return { claimed: true, outboxId, outcome: 'unrecorded', errorCode };
    }
  }
}

export const __testing = {
  TELEGRAM_KIND,
  safeErrorCode,
  validateClaimedJob,
  validateExplicitInputs,
  validateTelegramRoute,
};
