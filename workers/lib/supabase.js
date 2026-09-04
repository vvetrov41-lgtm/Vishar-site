// Narrow Supabase client for the trusted Worker.
//
// This client can call only the RPCs listed below. It has no generic table
// endpoint, no query builder and no way to send arbitrary SQL - the backend key
// it carries is powerful, so the call surface is kept deliberately small.
//
// The key is never logged, never echoed in an error, and never returned to a
// caller.

import { createBackendResponseObserver } from './supabase-diagnostics.js';
import { ConfigurationError, RequestError } from './http.js';
import { statusClass } from './logging.js';

/** Existing durable intake / delivery operations plus the hosted durable intake. */
export const ALLOWED_RPCS = new Set([
  'create_trusted_enquiry_intake',
  'create_hosted_enquiry_intake',
  'mark_enquiry_file_uploaded',
  'finalize_enquiry_intake',
  'fail_enquiry_intake',
  'record_outbox_attempt',
  'resolve_outbox_route',
  'list_incomplete_intakes',
  'claim_telegram_outbox_by_id',
  'claim_telegram_outbox',
  'record_telegram_outbox_result',
  'claim_calendar_outbox',
  'record_calendar_outbox_result',
  'claim_calendar_availability_outbox',
  'record_calendar_availability_outbox_result',
  'claim_whatsapp_outbox',
  'claim_whatsapp_outbox_by_id',
  'record_whatsapp_inbound_message',
  'record_whatsapp_message_status',
  'record_whatsapp_outbox_result',
]);

/** Phase F-G Telegram operations. Kept separate so the legacy intake surface stays pinned. */
export const TELEGRAM_SELF_SERVICE_RPCS = new Set([
  'service_complete_telegram_link',
  'service_resolve_telegram_destination',
  'service_claim_telegram_notifications',
  'service_record_telegram_notification_result',
]);

/** Existing generic automation engine backend surface. Never exposed to public callers. */
export const AUTOMATION_BACKEND_RPCS = new Set([
  'service_run_automation_tick',
]);

/** Scheduler liveness proof is separate from the automation execution surface. */
export const AUTOMATION_HEARTBEAT_RPCS = new Set([
  'service_record_automation_scheduler_heartbeat',
]);

export const LIFECYCLE_ALERT_RPCS = new Set([
  'service_sweep_lifecycle_failure_alerts',
]);

/** Appointment client-action capability surface, kept separate from booking resolvers. */
export const APPOINTMENT_CLIENT_ACTION_RPCS = new Set([
  'service_resolve_appointment_client_action',
  'service_apply_appointment_client_action',
]);

/** Existing read-only registry/hosted public-edge lookups. */
export const READ_ONLY_RPCS = new Set([
  'resolve_booking_source_public',
  'resolve_hosted_booking_source',
]);

/** Canonical /book/{slug} lookup reuses the existing backend-only source resolver. */
export const PUBLIC_SLUG_LOOKUP_RPCS = new Set([
  'resolve_booking_source',
]);

export class SupabaseError extends Error {
  constructor(code, status) {
    // The message deliberately carries no provider body: a PostgREST error can
    // echo the submitted row, which would put client data into the logs.
    super(`supabase request failed (${statusClass(status)})`);
    this.name = 'SupabaseError';
    this.code = code;
    this.status = status;
  }
}

export function readSupabaseConfig(env) {
  const rawUrl = typeof env?.SUPABASE_URL === 'string' ? env.SUPABASE_URL.trim() : '';
  const secretKey = typeof env?.SUPABASE_SECRET_KEY === 'string' ? env.SUPABASE_SECRET_KEY.trim() : '';
  const legacyServiceRoleKey = typeof env?.SUPABASE_SERVICE_ROLE_KEY === 'string'
    ? env.SUPABASE_SERVICE_ROLE_KEY.trim()
    : '';

  if (secretKey && legacyServiceRoleKey) {
    throw new ConfigurationError(
      'supabase_key_conflict',
      'Configure one Supabase backend key, not both the secret and legacy service-role key.'
    );
  }

  if (secretKey && !secretKey.startsWith('sb_secret_')) {
    throw new ConfigurationError(
      'invalid_supabase_secret_key',
      'The Supabase secret key is not in the expected format.'
    );
  }

  if (legacyServiceRoleKey.startsWith('sb_secret_')) {
    throw new ConfigurationError(
      'supabase_secret_key_misnamed',
      'Configure a Supabase secret key through SUPABASE_SECRET_KEY.'
    );
  }

  if (!rawUrl || (!secretKey && !legacyServiceRoleKey)) {
    throw new ConfigurationError('supabase_not_configured', 'The booking system is not configured.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(
      'invalid_supabase_url',
      'The booking database URL is not valid.'
    );
  }

  if (
    parsedUrl.protocol !== 'https:'
    || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsedUrl.hostname)
    || parsedUrl.port
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.pathname !== '/'
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new ConfigurationError(
      'invalid_supabase_url',
      'Configure the HTTPS project root URL from Supabase.'
    );
  }

  const url = parsedUrl.origin;
  const authHeaders = secretKey
    ? { apikey: secretKey }
    : {
        apikey: legacyServiceRoleKey,
        Authorization: `Bearer ${legacyServiceRoleKey}`,
      };

  return {
    url,
    authHeaders,
    keyKind: secretKey ? 'secret' : 'legacy_service_role',
  };
}

export function createSupabaseClient(env, fetchImpl = fetch) {
  const { url, authHeaders, keyKind } = readSupabaseConfig(env);
  const observe = createBackendResponseObserver('shared_backend', keyKind);

  async function rpc(name, args) {
    if (
      !ALLOWED_RPCS.has(name)
      && !TELEGRAM_SELF_SERVICE_RPCS.has(name)
      && !AUTOMATION_BACKEND_RPCS.has(name)
      && !AUTOMATION_HEARTBEAT_RPCS.has(name)
      && !LIFECYCLE_ALERT_RPCS.has(name)
      && !APPOINTMENT_CLIENT_ACTION_RPCS.has(name)
      && !READ_ONLY_RPCS.has(name)
      && !PUBLIC_SLUG_LOOKUP_RPCS.has(name)
    ) {
      throw new ConfigurationError('rpc_not_allowed', 'That database operation is not available.');
    }

    let diagnostics;
    const request = async (attempt) => {
      const startedAt = Date.now();
      const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args ?? {}),
      });
      diagnostics = await observe(name, response, startedAt, attempt);
      return response;
    };

    let response = await request(1);

    if (!response.ok && response.status === 401 && keyKind === 'secret') {
      response = await request(2);
    }

    if (!response.ok) {
      const error = new SupabaseError('database_unavailable', response.status);
      error.supabaseCode = diagnostics.supabase_code;
      throw error;
    }

    return response.json();
  }

  return { url, rpc, authHeaders, keyKind };
}

export function toRequestError(error) {
  if (error instanceof RequestError || error instanceof ConfigurationError) return error;
  if (error instanceof SupabaseError) {
    const retryable = error.status >= 500 || error.status === 429;
    return new RequestError(
      retryable ? 'database_unavailable' : 'enquiry_rejected',
      retryable
        ? 'We could not save your enquiry just now. Please try again in a moment.'
        : 'We could not save your enquiry. Please check the details and try again.',
      retryable ? 503 : 400
    );
  }
  return new RequestError('unexpected_error', 'Something went wrong. Please try again.', 500);
}
