// Channel-neutral outbound drain.
//
// The durable half of the engine lives in Postgres: one claim, one lease, one
// acknowledgement and one retry policy serve every channel. This module is the
// thin Worker half — validate the claimed job, resolve the artist route, hand
// exactly one message to a provider adapter, then acknowledge under the lease.
//
// Delivery is at least once. If a provider accepts a message and the
// acknowledgement then fails, the lease is left to expire and a later attempt
// may resend rather than silently losing the message; that outcome is reported
// as `unrecorded` instead of being claimed as a rollback.
//
// The adapter contract is deliberately narrow. An adapter receives the
// artist's safe route metadata and the message, and returns either
// `{ delivered: true, providerMessageId }` or `{ delivered: false, errorCode }`.
// It never sees the outbox, the lease or the database.

import { ProviderRouteError } from './provider-routing.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[a-z][a-z0-9_-]{2,127}$/;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const EXTERNAL_CONTACT_ID = /^[0-9]{5,40}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_LIMIT = 10;

export const CHANNELS = Object.freeze({
  whatsapp: { kind: 'whatsapp_message', integrationType: 'whatsapp' },
  instagram: { kind: 'instagram_message', integrationType: 'instagram' },
});

export class CommunicationsDrainError extends Error {
  constructor(code) {
    super('communication outbox job is unavailable');
    this.name = 'CommunicationsDrainError';
    this.code = code;
  }
}

export function randomWorkerId(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${suffix}`;
}

function validateInputs(channel, workerId, limit, leaseSeconds) {
  if (!CHANNELS[channel]) throw new CommunicationsDrainError('communication_channel_invalid');
  if (!WORKER_ID.test(workerId ?? '')) {
    throw new CommunicationsDrainError('communication_worker_id_invalid');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new CommunicationsDrainError('communication_limit_invalid');
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new CommunicationsDrainError('communication_lease_invalid');
  }
}

/**
 * A claimed job is only usable if every field the database recomputed from the
 * authoritative conversation and message rows is present and coherent. A
 * mutated outbox row must never be able to redirect a message.
 */
export function validateClaimedJob(job, channel) {
  const attemptCount = Number(job?.attempt_count);
  const maxAttempts = Number(job?.max_attempts);
  const body = job?.body;
  if (
    !UUID.test(job?.outbox_id ?? '')
    || !UUID.test(job?.artist_id ?? '')
    || !UUID.test(job?.communication_message_id ?? '')
    || !UUID.test(job?.conversation_id ?? '')
    || job?.channel !== channel
    || job?.kind !== CHANNELS[channel].kind
    || !INTEGRATION_KEY.test(job?.integration_key ?? '')
    || !EXTERNAL_CONTACT_ID.test(job?.external_contact_id ?? '')
    || typeof body !== 'string'
    || !body.trim()
    || !Number.isInteger(attemptCount)
    || attemptCount < 0
    || !Number.isInteger(maxAttempts)
    || maxAttempts < 1
    || job?.job_valid !== true
  ) {
    throw new CommunicationsDrainError('communication_job_invalid');
  }
  return { ...job, attempt_count: attemptCount, max_attempts: maxAttempts };
}

/**
 * The route the database returns must agree with the job in every field that
 * decides where the message goes. A disagreement means the outbox row and the
 * integration disagree about the artist, which must never be resolved by
 * guessing.
 */
export function validateRoute(route, job, channel) {
  const expected = CHANNELS[channel];
  if (
    route?.outbox_id !== job.outbox_id
    || route?.artist_id !== job.artist_id
    || route?.kind !== expected.kind
    || route?.integration_type !== expected.integrationType
    || route?.integration_key !== job.integration_key
  ) {
    throw new ProviderRouteError('provider_route_invalid');
  }
  return route;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function safeErrorCode(error) {
  const code = error instanceof CommunicationsDrainError || error instanceof ProviderRouteError
    ? error.code
    : error?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'communication_connector_error';
}

async function recordResult(supabase, outboxId, workerId, succeeded, {
  providerMessageId = null,
  errorCode = null,
} = {}) {
  return supabase.rpc('record_communication_outbox_result', {
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

export async function processClaimedJob({
  supabase,
  claimedJob,
  channel,
  workerId,
  deliver,
}) {
  let job;
  try {
    job = validateClaimedJob(claimedJob, channel);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    if (!UUID.test(claimedJob?.outbox_id ?? '')) {
      return { outcome: 'unrecorded', errorCode };
    }
    return recordFailure(supabase, claimedJob.outbox_id, workerId, errorCode);
  }

  let delivery;
  try {
    const resolved = await supabase.rpc('resolve_outbox_route', { p_outbox_id: job.outbox_id });
    const route = validateRoute(firstRow(resolved), job, channel);
    delivery = await deliver(route, {
      recipientId: job.external_contact_id,
      body: job.body,
      conversationId: job.conversation_id,
    });
  } catch (error) {
    return recordFailure(supabase, job.outbox_id, workerId, safeErrorCode(error));
  }

  if (!delivery?.delivered) {
    return recordFailure(
      supabase,
      job.outbox_id,
      workerId,
      safeErrorCode({ code: delivery?.errorCode }),
    );
  }

  try {
    await recordResult(supabase, job.outbox_id, workerId, true, {
      providerMessageId: delivery.providerMessageId,
    });
    return { outcome: 'succeeded' };
  } catch {
    // The provider has already accepted the message. Letting the lease expire
    // keeps delivery at least once, so a later attempt may duplicate the
    // message rather than silently dropping it.
    return { outcome: 'unrecorded', errorCode: 'communication_acknowledgement_failed' };
  }
}

export async function drainCommunicationOutbox({
  supabase,
  channel,
  deliver,
  workerId = randomWorkerId(`${channel}-worker`),
  limit = DEFAULT_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
}) {
  validateInputs(channel, workerId, limit, leaseSeconds);

  const claimed = await supabase.rpc('claim_communication_outbox', {
    p_worker_id: workerId,
    p_channel: channel,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  const rows = Array.isArray(claimed) ? claimed : claimed == null ? [] : [claimed];
  if (rows.length > limit) throw new CommunicationsDrainError('communication_claim_invalid');

  const aggregate = { claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0 };
  for (const claimedJob of rows) {
    const processed = await processClaimedJob({
      supabase,
      claimedJob,
      channel,
      workerId,
      deliver,
    });
    aggregate[processed.outcome] += 1;
  }
  return aggregate;
}

export const __testing = Object.freeze({
  validateInputs,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIMIT,
});
