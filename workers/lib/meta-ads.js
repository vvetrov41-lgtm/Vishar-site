// Consent-gated Meta Ads measurement and durable Conversions API drain.
//
// OpenAI Ads remains a separate integration with separate consent and secrets.
// This module never receives tattoo content, files, notes or message bodies.

import { createSupabaseClient } from './supabase.js';

const META_KIND = 'meta_conversion';
const SUPPORTED_GRAPH_API_VERSION = 'v26.0';
const META_GRAPH_ORIGIN = 'https://graph.facebook.com';
const DEFAULT_LIMIT = 10;
const DEFAULT_LEASE_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[a-z][a-z0-9_-]{2,127}$/;
const DATASET_ID = /^[0-9]{5,30}$/;
const INTEGRATION_KEY = /^meta_ads_[a-z][a-z0-9_]{1,63}$/;
const FB_COOKIE = /^fb\.[0-9]+\.[0-9]{10,13}\.[^\s]{1,220}$/;
const MEASUREMENT_ORIGINS = new Set([
  'https://vishartattoo.com',
  'https://www.vishartattoo.com',
  'https://booking.vishartattoo.com',
]);

export class MetaAdsError extends Error {
  constructor(code, { retryable = false, status = null } = {}) {
    super(code);
    this.name = 'MetaAdsError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function stringField(form, name) {
  const value = form?.get?.(name);
  return typeof value === 'string' ? value : '';
}

function sanitizeCookieValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= 255 && FB_COOKIE.test(trimmed) ? trimmed : '';
}

function sanitizeSourceUrl(value, observedOrigin) {
  if (!MEASUREMENT_ORIGINS.has(observedOrigin)) return '';
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (parsed.origin !== observedOrigin) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/** Read browser Meta measurement handoff only after explicit Meta consent. */
export function readMetaAdsMeasurementContext(form, observedOrigin) {
  if (stringField(form, 'metaAdsMeasurementConsent') !== 'granted') return null;
  const sourceUrl = sanitizeSourceUrl(stringField(form, 'metaAdsSourceUrl'), observedOrigin);
  if (!sourceUrl) return null;
  return {
    sourceUrl,
    fbp: sanitizeCookieValue(stringField(form, 'metaAdsFbp')) || null,
    fbc: sanitizeCookieValue(stringField(form, 'metaAdsFbc')) || null,
  };
}

/** Persist first-touch attribution without ever making booking success depend on Meta. */
export async function recordMetaAdsAttribution({
  supabase,
  enquiryId,
  eventId,
  context,
  logger,
}) {
  if (!context) return { attempted: false, recorded: false };
  try {
    const result = await supabase.rpc('service_record_meta_attribution', {
      p_enquiry_id: enquiryId,
      p_lead_event_id: eventId,
      p_consent_granted: true,
      p_fbp: context.fbp,
      p_fbc: context.fbc,
      p_event_source_url: context.sourceUrl,
    });
    const row = Array.isArray(result) ? result[0] : result;
    return { attempted: true, recorded: row?.recorded === true || row?.first_touch_preserved === true };
  } catch (error) {
    logger?.warn?.('meta_ads.attribution_failed', {
      route: 'enquiries',
      errorCode: 'meta_attribution_persist_failed',
    });
    return { attempted: true, recorded: false, error };
  }
}

function randomWorkerId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `meta-worker-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function validateDrainInputs(workerId, limit, leaseSeconds) {
  if (!WORKER_ID.test(workerId ?? '')) throw new MetaAdsError('meta_worker_id_invalid');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new MetaAdsError('meta_limit_invalid');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
    throw new MetaAdsError('meta_lease_invalid');
  }
}

function validateClaimedJob(row) {
  const attemptCount = Number(row?.attempt_count);
  const maxAttempts = Number(row?.max_attempts);
  const eventTime = Number(row?.event_time);
  if (
    !UUID.test(row?.outbox_id ?? '')
    || !UUID.test(row?.artist_id ?? '')
    || !UUID.test(row?.enquiry_id ?? '')
    || !Number.isInteger(attemptCount)
    || attemptCount < 0
    || !Number.isInteger(maxAttempts)
    || maxAttempts < 1
    || !['Lead', 'QualifiedLead', 'BookedClient'].includes(row?.event_name)
    || typeof row?.event_id !== 'string'
    || row.event_id.length < 8
    || row.event_id.length > 160
    || !Number.isInteger(eventTime)
    || eventTime < 1_500_000_000
    || !INTEGRATION_KEY.test(row?.integration_key ?? '')
    || !DATASET_ID.test(row?.dataset_id ?? '')
    || row?.graph_api_version !== SUPPORTED_GRAPH_API_VERSION
    || typeof row?.event_source_url !== 'string'
    || !row.event_source_url.startsWith('https://')
    || row?.job_valid !== true
  ) {
    throw new MetaAdsError('meta_job_invalid');
  }
  return {
    ...row,
    attempt_count: attemptCount,
    max_attempts: maxAttempts,
    event_time: eventTime,
  };
}

function secretBindingName(integrationKey, suffix) {
  if (!INTEGRATION_KEY.test(integrationKey ?? '')) throw new MetaAdsError('meta_integration_key_invalid');
  const artist = integrationKey.slice('meta_ads_'.length).toUpperCase();
  return `META_ADS_${artist}_${suffix}`;
}

function readAccessToken(env, integrationKey) {
  const value = env?.[secretBindingName(integrationKey, 'ACCESS_TOKEN')];
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new MetaAdsError('meta_access_token_missing', { retryable: true });
  }
  return token;
}

function readTestEventCode(env, integrationKey) {
  if (env?.VISHAR_ENVIRONMENT === 'production') return null;
  const value = env?.[secretBindingName(integrationKey, 'TEST_EVENT_CODE')];
  const code = typeof value === 'string' ? value.trim() : '';
  return code && code.length <= 128 && !/[\u0000-\u001f\u007f]/.test(code) ? code : null;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('00') && digits.length >= 10 && digits.length <= 17) {
    return digits.slice(2);
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return `44${digits.slice(1)}`;
  }
  return digits.length >= 10 && digits.length <= 15 && !digits.startsWith('0') ? digits : null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function buildUserData(job) {
  const userData = {};
  const email = normalizeEmail(job.email);
  const phone = normalizePhone(job.phone);
  if (email) userData.em = [await sha256Hex(email)];
  if (phone) userData.ph = [await sha256Hex(phone)];
  if (sanitizeCookieValue(job.fbp)) userData.fbp = job.fbp;
  if (sanitizeCookieValue(job.fbc)) userData.fbc = job.fbc;

  if (!userData.em && !userData.ph && !userData.fbp && !userData.fbc) {
    throw new MetaAdsError('meta_match_data_missing');
  }
  return userData;
}

async function buildMetaEvent(job) {
  return {
    event_name: job.event_name,
    event_time: job.event_time,
    event_id: job.event_id,
    action_source: 'website',
    event_source_url: job.event_source_url,
    user_data: await buildUserData(job),
  };
}

function classifyHttpFailure(status) {
  if (status === 429) return new MetaAdsError('meta_rate_limited', { retryable: true, status });
  if (status >= 500) return new MetaAdsError('meta_provider_unavailable', { retryable: true, status });
  if (status === 401 || status === 403) return new MetaAdsError('meta_auth_rejected', { retryable: false, status });
  return new MetaAdsError('meta_request_rejected', { retryable: false, status });
}

async function sendMetaEvent(env, job, fetchImpl = fetch) {
  const accessToken = readAccessToken(env, job.integration_key);
  const event = await buildMetaEvent(job);
  const payload = { data: [event] };
  const testEventCode = readTestEventCode(env, job.integration_key);
  if (testEventCode) payload.test_event_code = testEventCode;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(
        `${META_GRAPH_ORIGIN}/${SUPPORTED_GRAPH_API_VERSION}/${job.dataset_id}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw new MetaAdsError('meta_timeout', { retryable: true });
      throw new MetaAdsError('meta_network_error', { retryable: true });
    }

    if (!response.ok) throw classifyHttpFailure(response.status);

    let body;
    try { body = await response.json(); }
    catch { throw new MetaAdsError('meta_response_invalid', { retryable: true, status: response.status }); }

    if (!Number.isInteger(body?.events_received) || body.events_received < 1) {
      throw new MetaAdsError('meta_response_invalid', { retryable: true, status: response.status });
    }
    return { delivered: true };
  } finally {
    clearTimeout(timeout);
  }
}

function safeError(error) {
  if (error instanceof MetaAdsError) return error;
  return new MetaAdsError('meta_connector_error', { retryable: true });
}

async function recordResult(supabase, job, workerId, succeeded, error = null) {
  const safe = error ? safeError(error) : null;
  return supabase.rpc('record_meta_conversion_outbox_result', {
    p_outbox_id: job.outbox_id,
    p_worker_id: workerId,
    p_succeeded: succeeded,
    p_retryable: succeeded ? false : safe.retryable,
    p_error_code: succeeded ? null : safe.code,
  });
}

export async function processClaimedMetaJob(env, {
  supabase,
  claimedJob,
  workerId,
  fetchImpl = fetch,
}) {
  let job;
  try {
    job = validateClaimedJob(claimedJob);
  } catch (error) {
    if (!UUID.test(claimedJob?.outbox_id ?? '')) {
      return { outcome: 'unrecorded', errorCode: 'meta_job_invalid' };
    }
    try {
      await recordResult(supabase, claimedJob, workerId, false, safeError(error));
      return { outcome: 'failed', errorCode: safeError(error).code };
    } catch {
      return { outcome: 'unrecorded', errorCode: safeError(error).code };
    }
  }

  try {
    await sendMetaEvent(env, job, fetchImpl);
  } catch (error) {
    const safe = safeError(error);
    try {
      await recordResult(supabase, job, workerId, false, safe);
      return { outcome: 'failed', errorCode: safe.code, retryable: safe.retryable };
    } catch {
      return { outcome: 'unrecorded', errorCode: safe.code, retryable: safe.retryable };
    }
  }

  try {
    await recordResult(supabase, job, workerId, true);
    return { outcome: 'succeeded' };
  } catch {
    // Meta may already have accepted the deterministic event_id. Leaving the
    // lease to expire is safe because a retry uses the same event id.
    return { outcome: 'unrecorded', errorCode: 'meta_acknowledgement_failed' };
  }
}

export async function drainMetaConversionOutbox(env, {
  workerId = randomWorkerId(),
  limit = DEFAULT_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  fetchImpl = fetch,
} = {}) {
  validateDrainInputs(workerId, limit, leaseSeconds);
  const supabase = createSupabaseClient(env, fetchImpl);
  const claimed = await supabase.rpc('claim_meta_conversion_outbox', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  const rows = Array.isArray(claimed) ? claimed : claimed == null ? [] : [claimed];
  if (rows.length > limit) throw new MetaAdsError('meta_claim_invalid');

  const summary = { claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0 };
  for (const row of rows) {
    const result = await processClaimedMetaJob(env, {
      supabase,
      claimedJob: row,
      workerId,
      fetchImpl,
    });
    summary[result.outcome] += 1;
  }
  return summary;
}

export const META_ADS_CONFIG = Object.freeze({
  graphApiVersion: SUPPORTED_GRAPH_API_VERSION,
  kind: META_KIND,
});

export const __testing = {
  buildMetaEvent,
  classifyHttpFailure,
  normalizeEmail,
  normalizePhone,
  readAccessToken,
  readTestEventCode,
  sanitizeCookieValue,
  sanitizeSourceUrl,
  secretBindingName,
  sha256Hex,
  validateClaimedJob,
  validateDrainInputs,
};
