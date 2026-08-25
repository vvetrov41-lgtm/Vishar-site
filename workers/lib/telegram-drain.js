import { ProviderRouteError } from './provider-routing.js';
import { createSupabaseClient } from './supabase.js';
import {
  buildEnquiryNotification,
  buildPersonalNotification,
  sendNotification,
  sendSharedTelegramNotification,
  sharedTelegramBotToken,
} from './telegram.js';

const TELEGRAM_KIND = 'telegram_notification';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHAT_ID = /^-?[0-9]{1,20}$/;
const WORKER_ID = /^[a-z][a-z0-9_-]{2,127}$/;
const REFERENCE = /^ENQ-[0-9]{4}-[0-9]{4,}$/;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_LIMIT = 10;
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';

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

function validateWorkerInputs(workerId, leaseSeconds) {
  if (!WORKER_ID.test(workerId ?? '')) throw new TelegramDrainError('telegram_worker_id_invalid');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new TelegramDrainError('telegram_lease_invalid');
  }
}

function validateExplicitInputs(outboxId, workerId, leaseSeconds) {
  if (!UUID.test(outboxId ?? '')) throw new TelegramDrainError('telegram_outbox_id_invalid');
  validateWorkerInputs(workerId, leaseSeconds);
}

function validateAutomaticInputs(workerId, limit, leaseSeconds) {
  validateWorkerInputs(workerId, leaseSeconds);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new TelegramDrainError('telegram_limit_invalid');
  }
}

function validateClaimedJob(job, expectedOutboxId = null) {
  const attemptCount = Number(job?.attempt_count);
  const maxAttempts = Number(job?.max_attempts);
  const fileCount = Number(job?.file_count);
  if (
    !UUID.test(job?.outbox_id ?? '')
    || (expectedOutboxId !== null && job.outbox_id !== expectedOutboxId)
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

function validateRegistryDestination(value, expectedKind) {
  if (value == null) return null;
  const row = firstRow(value);
  if (!row) return null;
  if (
    !UUID.test(row.destination_id ?? '')
    || row.destination_kind !== expectedKind
    || !CHAT_ID.test(String(row.chat_id ?? ''))
  ) {
    throw new TelegramDrainError('telegram_destination_invalid');
  }
  return { ...row, chat_id: String(row.chat_id) };
}

function trustedCrmOrigin(env) {
  const raw = typeof env?.CRM_ORIGIN === 'string' ? env.CRM_ORIGIN.trim() : '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) return null;
    if (env?.VISHAR_ENVIRONMENT === 'production' && parsed.origin !== PRODUCTION_CRM_ORIGIN) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function personalNotificationActionUrl(env, entityType, entityId) {
  if (entityType !== 'session') return null;
  if (!UUID.test(entityId ?? '')) throw new TelegramDrainError('telegram_notification_invalid');
  const origin = trustedCrmOrigin(env);
  if (!origin) return null;
  return `${origin}/#/appointments/${entityId}`;
}

function validatePersonalDelivery(env, row) {
  const entityType = row?.entity_type ?? null;
  const entityId = row?.entity_id ?? null;
  if (
    !UUID.test(row?.delivery_id ?? '')
    || !UUID.test(row?.notification_id ?? '')
    || !UUID.test(row?.profile_id ?? '')
    || !CHAT_ID.test(String(row?.chat_id ?? ''))
    || typeof row?.title !== 'string'
    || row.title.trim() === ''
    || row.title.length > 200
    || (row?.body != null && (typeof row.body !== 'string' || row.body.length > 2000))
    || ((entityType === null) !== (entityId === null))
    || (entityType !== null && typeof entityType !== 'string')
    || (entityId !== null && !UUID.test(entityId))
  ) {
    throw new TelegramDrainError('telegram_notification_invalid');
  }
  const actionUrl = personalNotificationActionUrl(env, entityType, entityId);
  const text = buildPersonalNotification({ title: row.title, body: row.body, actionUrl });
  if (!text) throw new TelegramDrainError('telegram_notification_invalid');
  return { ...row, chat_id: String(row.chat_id), text };
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

async function recordFailure(supabase, outboxId, workerId, errorCode) {
  try {
    await recordResult(supabase, outboxId, workerId, false, errorCode);
    return { outcome: 'failed', errorCode };
  } catch {
    return { outcome: 'unrecorded', errorCode };
  }
}

async function recordArtistRegistryResult(
  supabase,
  destinationId,
  workerId,
  succeeded,
  errorCode = null,
) {
  try {
    await supabase.rpc('service_record_telegram_notification_result', {
      p_delivery_id: destinationId,
      p_worker_id: workerId,
      p_succeeded: succeeded,
      p_error_code: succeeded ? null : errorCode,
    });
    return true;
  } catch {
    // Provider delivery is the durable outcome. Observability must never turn a
    // successful external send into a retry and duplicate the Telegram message.
    return false;
  }
}

async function preferredArtistDelivery(env, supabase, route, job, text, fetchImpl) {
  const production = env?.VISHAR_ENVIRONMENT === 'production';
  const sharedConfigured = Boolean(sharedTelegramBotToken(env));

  if (!sharedConfigured) {
    if (production) {
      // Production must never regain the legacy path merely because its shared
      // credential is absent or malformed.
      throw new TelegramDrainError('telegram_shared_bot_not_configured');
    }
    return {
      notification: await sendNotification(env, route, text, fetchImpl),
      registryDestinationId: null,
    };
  }

  let destination;
  try {
    const resolved = await supabase.rpc('service_resolve_telegram_destination', {
      p_artist_id: job.artist_id,
      p_profile_id: null,
    });
    destination = validateRegistryDestination(resolved, 'artist');
  } catch {
    if (production) {
      throw new TelegramDrainError('telegram_destination_unavailable');
    }
  }

  if (destination) {
    return {
      notification: await sendSharedTelegramNotification(env, destination.chat_id, text, fetchImpl),
      registryDestinationId: destination.destination_id,
    };
  }

  if (production) {
    throw new TelegramDrainError('telegram_destination_unavailable');
  }

  // Retained staging keeps the historical fallback so it can exercise both the
  // progressive registry path and the old artist binding without weakening the
  // production invariant above.
  return {
    notification: await sendNotification(env, route, text, fetchImpl),
    registryDestinationId: null,
  };
}

export async function processClaimedTelegramJob(env, {
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
    const route = validateTelegramRoute(firstRow(resolved), job);
    const text = buildEnquiryNotification({
      referenceNumber: job.reference_number,
      fileCount: job.file_count,
      clientConflict: job.client_conflict,
    });
    delivery = await preferredArtistDelivery(env, supabase, route, job, text, fetchImpl);
  } catch (error) {
    return recordFailure(
      supabase,
      job.outbox_id,
      workerId,
      safeErrorCode(error),
    );
  }

  const { notification, registryDestinationId } = delivery;
  if (!notification.delivered) {
    const errorCode = safeErrorCode({ code: notification.errorCode });
    if (registryDestinationId) {
      await recordArtistRegistryResult(
        supabase,
        registryDestinationId,
        workerId,
        false,
        errorCode,
      );
    }
    return recordFailure(
      supabase,
      job.outbox_id,
      workerId,
      errorCode,
    );
  }

  if (registryDestinationId) {
    await recordArtistRegistryResult(
      supabase,
      registryDestinationId,
      workerId,
      true,
    );
  }

  try {
    await recordResult(supabase, job.outbox_id, workerId, true);
    return { outcome: 'succeeded' };
  } catch {
    // Telegram may already have accepted the message. Leaving the lease to
    // expire preserves at-least-once delivery, so a later retry may duplicate
    // the provider message rather than silently losing it.
    return { outcome: 'unrecorded', errorCode: 'telegram_acknowledgement_failed' };
  }
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

  const processed = await processClaimedTelegramJob(env, {
    supabase,
    claimedJob: rows[0],
    workerId,
    expectedOutboxId: outboxId,
    fetchImpl,
  });
  return { claimed: true, outboxId, ...processed };
}

export async function drainTelegramOutbox(env, {
  workerId = randomWorkerId(),
  limit = DEFAULT_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateAutomaticInputs(workerId, limit, leaseSeconds);
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('claim_telegram_outbox', {
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
    throw new TelegramDrainError('telegram_claim_invalid');
  }

  const aggregate = { claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0 };
  for (const claimedJob of rows) {
    const processed = await processClaimedTelegramJob(env, {
      supabase,
      claimedJob,
      workerId,
      fetchImpl,
    });
    aggregate[processed.outcome] += 1;
  }
  return aggregate;
}

async function recordPersonalResult(supabase, deliveryId, workerId, succeeded, errorCode = null) {
  return supabase.rpc('service_record_telegram_notification_result', {
    p_delivery_id: deliveryId,
    p_worker_id: workerId,
    p_succeeded: succeeded,
    p_error_code: succeeded ? null : errorCode,
  });
}

export async function drainPersonalTelegramNotifications(env, {
  workerId = randomWorkerId(),
  limit = DEFAULT_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateAutomaticInputs(workerId, limit, leaseSeconds);
  if (!sharedTelegramBotToken(env)) {
    return { claimed: 0, succeeded: 0, failed: 0, unrecorded: 0, skipped: true };
  }

  const supabase = createSupabaseClient(env, fetchImpl);
  // 0101 enriches the existing claim in place. Old database versions simply
  // omit entity_type/entity_id, which validatePersonalDelivery treats as a
  // legacy notification and sends without a CRM link. No second RPC or rollout
  // switch is required.
  const claimed = await supabase.rpc('service_claim_telegram_notifications', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  const rows = Array.isArray(claimed) ? claimed : claimed == null ? [] : [claimed];
  if (rows.length > limit) throw new TelegramDrainError('telegram_claim_invalid');

  const aggregate = { claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0, skipped: false };
  for (const row of rows) {
    let delivery;
    try {
      delivery = validatePersonalDelivery(env, row);
    } catch (error) {
      const code = safeErrorCode(error);
      if (!UUID.test(row?.delivery_id ?? '')) {
        aggregate.unrecorded += 1;
        continue;
      }
      try {
        await recordPersonalResult(supabase, row.delivery_id, workerId, false, code);
        aggregate.failed += 1;
      } catch {
        aggregate.unrecorded += 1;
      }
      continue;
    }

    const sent = await sendSharedTelegramNotification(env, delivery.chat_id, delivery.text, fetchImpl);
    const succeeded = sent.delivered === true;
    const code = succeeded ? null : safeErrorCode({ code: sent.errorCode });
    try {
      await recordPersonalResult(supabase, delivery.delivery_id, workerId, succeeded, code);
      aggregate[succeeded ? 'succeeded' : 'failed'] += 1;
    } catch {
      aggregate.unrecorded += 1;
    }
  }
  return aggregate;
}

export const __testing = {
  PRODUCTION_CRM_ORIGIN,
  TELEGRAM_KIND,
  personalNotificationActionUrl,
  safeErrorCode,
  trustedCrmOrigin,
  validateAutomaticInputs,
  validateClaimedJob,
  validateExplicitInputs,
  validatePersonalDelivery,
  validateRegistryDestination,
  validateTelegramRoute,
};
