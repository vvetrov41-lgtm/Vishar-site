import {
  deleteRefreshToken,
  getProfile,
  getThread,
  refreshAccessToken,
  searchThreads,
} from './lib/google-gmail.js';
import { createGmailSupabase } from './lib/gmail-supabase.js';

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const GMAIL_PUBLIC_HOST = 'gmail.vishartattoo.com';
const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const REQUIRED_OPERATOR_CAPABILITY = 'manage_communications';
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(request.headers.get('authorization') || '');
  return match?.[1] || null;
}

function corsHeaders(request) {
  return request.headers.get('origin') === CRM_ORIGIN
    ? { 'access-control-allow-origin': CRM_ORIGIN, vary: 'Origin' }
    : {};
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

function methodNotAllowed(request, allow) {
  return new Response(null, {
    status: 405,
    headers: { allow, 'cache-control': 'no-store', ...corsHeaders(request) },
  });
}

function operatorPath(pathname) {
  return pathname.startsWith('/v1/operator/');
}

function configured(env) {
  return env?.VISHAR_ENVIRONMENT === 'production'
    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN
    && env?.GMAIL_READ_ENABLED === 'true';
}

async function enforceRateLimit(request, env) {
  if (!env?.GMAIL_RATE_LIMIT?.limit) return false;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await env.GMAIL_RATE_LIMIT.limit({ key: `operator:${address}` });
  return result?.success === false;
}

async function authorizeOperator(db, token, enquiryId) {
  // First let the caller's own Supabase RLS decide whether this enquiry is even
  // visible. Then ask the canonical capability registry whether the same session
  // may manage communications for that exact artist. No profile id is accepted
  // from the browser and no service-role-only authorization function is needed.
  const auth = await db.userEnquiry(enquiryId, token);
  if (!auth || !uuid(auth.artist_id) || auth.enquiry_id !== enquiryId || !uuid(auth.client_id)) {
    throw new Error('gmail_operator_scope_invalid');
  }
  const capabilities = await db.userRpc('list_capabilities', { p_artist_id: auth.artist_id }, token);
  if (!Array.isArray(capabilities)
    || !capabilities.some((row) => row?.artist_id === auth.artist_id && row?.capability === REQUIRED_OPERATOR_CAPABILITY)) {
    throw new Error('gmail_operator_scope_invalid');
  }
  return auth;
}

async function resolveTarget(db, auth) {
  const target = firstRow(await db.backendRpc('service_resolve_gmail_target', {
    p_artist_id: auth.artist_id,
    p_enquiry_id: auth.enquiry_id,
    p_client_id: auth.client_id,
  }));
  if (!target || target.artist_id !== auth.artist_id || target.enquiry_id !== auth.enquiry_id || target.client_id !== auth.client_id) {
    throw new Error('gmail_target_scope_invalid');
  }
  return target;
}

async function accessForTarget(env, db, target, fetchImpl) {
  try {
    const { accessToken, stored } = await refreshAccessToken(env, target.artist_id, fetchImpl);
    if (stored.integration_key !== target.integration_key || stored.mailbox_email !== target.mailbox_email) {
      throw new Error('gmail_token_binding_mismatch');
    }
    const profile = await getProfile(accessToken, fetchImpl);
    if (profile.emailAddress !== target.mailbox_email) throw new Error('gmail_profile_binding_mismatch');
    return accessToken;
  } catch (error) {
    if (error instanceof Error && error.message === 'gmail_refresh_token_revoked') {
      try {
        await db.backendRpc('service_disable_gmail_integration', {
          p_artist_id: target.artist_id,
          p_integration_key: target.integration_key,
          p_error_code: 'gmail_refresh_token_revoked',
        });
      } finally {
        await deleteRefreshToken(env, target.artist_id);
      }
    }
    throw error;
  }
}

function publicMessage(message) {
  return {
    from: message.from,
    to: message.to,
    subject: message.subject,
    timestamp: message.timestamp,
    body: message.body,
    direction: message.direction,
    untrusted_content: true,
  };
}

function safeReason(error) {
  return error instanceof Error ? error.message : 'gmail_operator_failed';
}

function errorResponse(request, error) {
  const reason = safeReason(error);
  if (reason === 'gmail_operator_token_invalid' || reason === 'gmail_operator_unauthorized') {
    return json(request, 401, { error: 'authentication_required' });
  }
  if (
    reason === 'gmail_rpc_forbidden'
    || reason === 'gmail_operator_scope_invalid'
    || reason === 'gmail_target_scope_invalid'
    || reason === 'gmail_token_binding_mismatch'
    || reason === 'gmail_thread_outside_client_scope'
    || reason.includes('scope')
  ) {
    return json(request, 403, { error: 'artist_scope_denied' });
  }
  if (reason === 'gmail_refresh_token_missing' || reason === 'gmail_refresh_token_revoked') {
    return json(request, 409, { error: 'gmail_reconnect_required' });
  }
  return json(request, 502, { error: 'gmail_provider_unavailable' });
}

export async function handleGmailOperatorRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.hostname !== GMAIL_PUBLIC_HOST || !operatorPath(url.pathname)) return null;

  const origin = request.headers.get('origin');
  if (origin && origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
  if (request.method === 'OPTIONS') {
    if (origin !== CRM_ORIGIN) return json(request, 403, { error: 'origin_denied' });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': CRM_ORIGIN,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        vary: 'Origin',
      },
    });
  }
  if (!configured(env)) return json(request, 404, { error: 'not_found' });
  if (await enforceRateLimit(request, env)) return json(request, 429, { error: 'rate_limited' });

  const history = /^\/v1\/operator\/enquiries\/([0-9a-f-]{36})\/gmail\/history\/?$/i.exec(url.pathname);
  const thread = /^\/v1\/operator\/enquiries\/([0-9a-f-]{36})\/gmail\/threads\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
  if (!history && !thread) return json(request, 404, { error: 'not_found' });
  if (request.method !== 'GET') return methodNotAllowed(request, 'GET, OPTIONS');

  const token = bearer(request);
  if (!token) return json(request, 401, { error: 'authentication_required' });
  const enquiryId = uuid((history || thread)?.[1]);
  if (!enquiryId) return json(request, 400, { error: 'invalid_enquiry_id' });

  try {
    const db = createGmailSupabase(env, fetchImpl);
    const auth = await authorizeOperator(db, token, enquiryId);
    const target = await resolveTarget(db, auth);
    const accessToken = await accessForTarget(env, db, target, fetchImpl);

    if (history) {
      for (const key of url.searchParams.keys()) {
        if (!['thread_limit', 'message_limit'].includes(key)) return json(request, 400, { error: 'unexpected_field', field: key });
      }
      const threadLimit = Number(url.searchParams.get('thread_limit') || 4);
      const messageLimit = Number(url.searchParams.get('message_limit') || 20);
      if (!Number.isInteger(threadLimit) || threadLimit < 1 || threadLimit > 8 || !Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 30) {
        return json(request, 400, { error: 'invalid_limit' });
      }

      const found = await searchThreads(accessToken, {
        mailboxEmail: target.mailbox_email,
        clientEmail: target.client_email,
        threadLimit,
        messageLimit,
        fetchImpl,
      });
      const threads = [];
      for (const item of found) {
        const last = item.messages.at(-1);
        const contextId = await db.backendRpc('service_upsert_gmail_thread_context', {
          p_artist_id: auth.artist_id,
          p_enquiry_id: auth.enquiry_id,
          p_client_id: auth.client_id,
          p_provider_thread_id: item.providerThreadId,
          p_subject: last?.subject || '(no subject)',
          p_last_provider_message_id: last?.provider_message_id || null,
          p_last_rfc822_message_id: last?._rfc822_message_id || null,
        });
        threads.push({
          thread_context_id: contextId,
          subject: last?.subject || '(no subject)',
          message_count: item.messages.length,
          messages: item.messages.map(publicMessage),
          untrusted_content: true,
        });
      }
      return json(request, 200, { enquiry_id: enquiryId, threads, untrusted_content: true });
    }

    if ([...url.searchParams.keys()].length) return json(request, 400, { error: 'unexpected_query' });
    const contextId = uuid(thread[2]);
    if (!contextId) return json(request, 400, { error: 'invalid_thread_context_id' });
    const context = firstRow(await db.backendRpc('service_get_gmail_thread_context', {
      p_thread_context_id: contextId,
      p_artist_id: auth.artist_id,
      p_enquiry_id: auth.enquiry_id,
      p_client_id: auth.client_id,
    }));
    if (!context?.provider_thread_id) throw new Error('gmail_thread_outside_client_scope');
    const found = await getThread(accessToken, context.provider_thread_id, {
      mailboxEmail: target.mailbox_email,
      clientEmail: target.client_email,
      messageLimit: 30,
      fetchImpl,
    });
    return json(request, 200, {
      enquiry_id: enquiryId,
      thread_context_id: contextId,
      subject: found.messages.at(-1)?.subject || context.subject,
      messages: found.messages.map(publicMessage),
      untrusted_content: true,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export const __testing = Object.freeze({
  CRM_ORIGIN,
  GMAIL_PUBLIC_HOST,
  REQUIRED_OPERATOR_CAPABILITY,
  operatorPath,
  publicMessage,
  errorResponse,
});
