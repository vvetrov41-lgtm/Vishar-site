import {
  deleteRefreshToken,
  getProfile,
  getThread,
  listRecentCorrespondents,
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

/**
 * The same proof as `authorizeOperator`, for a read that names a client and no
 * enquiry.
 *
 * The artist is derived from the caller's own RLS view of that client's
 * enquiries, then checked against the capability registry - so the browser
 * supplies an opaque client id and nothing else. A client related to two
 * artists the operator may manage is refused rather than guessed: picking one
 * would silently choose whose mailbox to open.
 */
async function authorizeOperatorForClient(db, token, clientId) {
  const artistIds = await db.userClientArtists(clientId, token);
  const capabilities = await db.userRpc('list_capabilities', {}, token);
  if (!Array.isArray(capabilities)) throw new Error('gmail_operator_scope_invalid');
  const permitted = artistIds.filter((artistId) => capabilities.some(
    (row) => row?.artist_id === artistId && row?.capability === REQUIRED_OPERATOR_CAPABILITY,
  ));
  if (permitted.length === 0) throw new Error('gmail_operator_scope_invalid');
  if (permitted.length > 1) throw new Error('gmail_client_scope_ambiguous');
  return { artist_id: permitted[0], client_id: clientId };
}

/**
 * Discovery is the one read where the operator names the artist.
 *
 * That is not a weaker check than the client route's derivation - it is a
 * stricter one. The artist is verified against the capability registry under
 * the caller's own session before anything is read, so an id in the path buys
 * access to nothing the operator did not already have. What it avoids is the
 * alternative: sweeping every artist the operator can reach and quietly
 * choosing which mailbox to open.
 */
async function authorizeOperatorForArtist(db, token, artistId) {
  const capabilities = await db.userRpc('list_capabilities', { p_artist_id: artistId }, token);
  if (!Array.isArray(capabilities)
    || !capabilities.some((row) => row?.artist_id === artistId && row?.capability === REQUIRED_OPERATOR_CAPABILITY)) {
    throw new Error('gmail_operator_scope_invalid');
  }
  return { artist_id: artistId };
}

async function resolveMailbox(db, artistId) {
  const mailbox = firstRow(await db.backendRpc('service_resolve_gmail_mailbox', { p_artist_id: artistId }));
  if (!mailbox || mailbox.artist_id !== artistId || typeof mailbox.mailbox_email !== 'string') {
    throw new Error('gmail_target_scope_invalid');
  }
  return mailbox;
}

async function resolveClientTarget(db, auth) {
  const target = firstRow(await db.backendRpc('service_resolve_gmail_client_target', {
    p_artist_id: auth.artist_id,
    p_client_id: auth.client_id,
  }));
  if (!target || target.artist_id !== auth.artist_id || target.client_id !== auth.client_id) {
    throw new Error('gmail_target_scope_invalid');
  }
  return target;
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
    || reason === 'gmail_client_scope_ambiguous'
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

  const discovery = /^\/v1\/operator\/artists\/([0-9a-f-]{36})\/gmail\/inbox\/?$/i.exec(url.pathname);
  if (discovery) {
    if (request.method !== 'GET') return methodNotAllowed(request, 'GET, OPTIONS');
    const token = bearer(request);
    if (!token) return json(request, 401, { error: 'authentication_required' });
    const artistId = uuid(discovery[1]);
    if (!artistId) return json(request, 400, { error: 'invalid_artist_id' });
    for (const key of url.searchParams.keys()) {
      if (key !== 'message_limit') return json(request, 400, { error: 'unexpected_field', field: key });
    }
    const messageLimit = Number(url.searchParams.get('message_limit') || 40);
    if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 60) {
      return json(request, 400, { error: 'invalid_limit' });
    }

    try {
      const db = createGmailSupabase(env, fetchImpl);
      const auth = await authorizeOperatorForArtist(db, token, artistId);
      const mailbox = await resolveMailbox(db, auth.artist_id);
      const accessToken = await accessForTarget(env, db, {
        artist_id: auth.artist_id,
        integration_key: mailbox.integration_key,
        mailbox_email: mailbox.mailbox_email,
      }, fetchImpl);

      // Metadata only, and no message is opened: this answers "is this somebody
      // we know?", not "what did they say".
      const seen = await listRecentCorrespondents(accessToken, {
        mailboxEmail: mailbox.mailbox_email,
        messageLimit,
        fetchImpl,
      });

      // The database decides who is known. An address it cannot name is not
      // filtered out downstream - it never comes back at all, so there is no
      // later step where forgetting a filter would leak an unknown sender.
      const matched = seen.length
        ? await db.backendRpc('service_match_gmail_clients', {
          p_artist_id: auth.artist_id,
          p_emails: [...new Set(seen.map((item) => item.email))],
        })
        : [];
      const byEmail = new Map(
        (Array.isArray(matched) ? matched : [])
          .filter((row) => uuid(row?.client_id) && typeof row?.client_email === 'string')
          .map((row) => [row.client_email, row]),
      );

      // One row per CLIENT, newest message wins. A client with several
      // enquiries is one person with one mailbox, and several rows for them
      // would be the duplication this whole design exists to avoid.
      const latest = new Map();
      for (const item of seen) {
        const client = byEmail.get(item.email);
        if (!client) continue;
        const current = latest.get(client.client_id);
        const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
        const currentAt = current?.last_message_at ? Date.parse(current.last_message_at) : Number.NaN;
        if (!current || (Number.isFinite(at) && (!Number.isFinite(currentAt) || at > currentAt))) {
          latest.set(client.client_id, {
            client_id: client.client_id,
            client_name: typeof client.full_name === 'string' ? client.full_name : null,
            subject: item.subject,
            last_message_at: item.timestamp,
            direction: item.direction,
            untrusted_content: true,
          });
        }
      }

      return json(request, 200, {
        artist_id: auth.artist_id,
        clients: [...latest.values()],
        untrusted_content: true,
      });
    } catch (error) {
      return errorResponse(request, error);
    }
  }

  const clientHistory = /^\/v1\/operator\/clients\/([0-9a-f-]{36})\/gmail\/history\/?$/i.exec(url.pathname);
  if (clientHistory) {
    if (request.method !== 'GET') return methodNotAllowed(request, 'GET, OPTIONS');
    const token = bearer(request);
    if (!token) return json(request, 401, { error: 'authentication_required' });
    const clientId = uuid(clientHistory[1]);
    if (!clientId) return json(request, 400, { error: 'invalid_client_id' });
    for (const key of url.searchParams.keys()) {
      if (!['thread_limit', 'message_limit'].includes(key)) return json(request, 400, { error: 'unexpected_field', field: key });
    }
    const threadLimit = Number(url.searchParams.get('thread_limit') || 4);
    const messageLimit = Number(url.searchParams.get('message_limit') || 20);
    if (!Number.isInteger(threadLimit) || threadLimit < 1 || threadLimit > 8
      || !Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 30) {
      return json(request, 400, { error: 'invalid_limit' });
    }

    try {
      const db = createGmailSupabase(env, fetchImpl);
      const auth = await authorizeOperatorForClient(db, token, clientId);
      const target = await resolveClientTarget(db, auth);
      const accessToken = await accessForTarget(env, db, target, fetchImpl);

      // Gmail is searched by the client's address, which is the only thing it
      // understands, and exactly once. No thread context is written.
      //
      // That omission is the point of this route. Contexts are unique on
      // (artist, enquiry, provider thread), so creating them from a read that
      // has no enquiry would mean either inventing one or writing the same
      // Gmail conversation under several - which is how a later reply ends up
      // bound to the wrong enquiry. Discovery stays read-only; replies keep
      // using the enquiry route, which has a real enquiry to bind to.
      const found = await searchThreads(accessToken, {
        mailboxEmail: target.mailbox_email,
        clientEmail: target.client_email,
        threadLimit,
        messageLimit,
        fetchImpl,
      });
      return json(request, 200, {
        client_id: clientId,
        threads: found.map((item) => ({
          subject: item.messages.at(-1)?.subject || '(no subject)',
          message_count: item.messages.length,
          messages: item.messages.map(publicMessage),
          untrusted_content: true,
        })),
        untrusted_content: true,
      });
    } catch (error) {
      return errorResponse(request, error);
    }
  }

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
  authorizeOperatorForArtist,
  authorizeOperatorForClient,
  CRM_ORIGIN,
  GMAIL_PUBLIC_HOST,
  REQUIRED_OPERATOR_CAPABILITY,
  operatorPath,
  publicMessage,
  errorResponse,
});
