// Narrow Supabase client for the trusted Worker.
//
// This client can call exactly the RPCs listed in ALLOWED_RPCS. It has no
// generic table endpoint, no query builder and no way to send arbitrary SQL —
// the service-role key it carries is powerful, so the call surface is kept
// deliberately small.
//
// The key is never logged, never echoed in an error, and never returned to a
// caller.

import { ConfigurationError, RequestError } from './http.js';
import { statusClass } from './logging.js';

/**
 * The complete set of database entry points the Worker may use. Anything not
 * on this list cannot be reached from the public edge, whatever a future caller
 * asks for.
 */
export const ALLOWED_RPCS = new Set([
  'create_enquiry_intake',
  'mark_enquiry_file_uploaded',
  'finalize_enquiry_intake',
  'fail_enquiry_intake',
  'list_incomplete_intakes',
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
  const url = typeof env?.SUPABASE_URL === 'string' ? env.SUPABASE_URL.replace(/\/+$/, '') : '';
  const serviceKey = typeof env?.SUPABASE_SERVICE_ROLE_KEY === 'string' ? env.SUPABASE_SERVICE_ROLE_KEY : '';

  if (!url || !serviceKey) {
    // Refusing here is the point. Falling back to notification-only behaviour
    // would silently turn a durable booking system back into a Telegram relay,
    // and the visitor would be told their enquiry was saved when it was not.
    throw new ConfigurationError('supabase_not_configured', 'The booking system is not configured.');
  }

  return { url, serviceKey };
}

export function createSupabaseClient(env, fetchImpl = fetch) {
  const { url, serviceKey } = readSupabaseConfig(env);

  async function rpc(name, args) {
    if (!ALLOWED_RPCS.has(name)) {
      throw new ConfigurationError('rpc_not_allowed', 'That database operation is not available.');
    }

    const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args ?? {}),
    });

    if (!response.ok) {
      throw new SupabaseError('database_unavailable', response.status);
    }

    return response.json();
  }

  return { url, rpc, serviceKey };
}

/**
 * Maps a database failure to a safe, visitor-facing error. A 4xx from PostgREST
 * means the payload was rejected by a constraint or a validation raise, which
 * is not retryable; a 5xx is.
 */
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
