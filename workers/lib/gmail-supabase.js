import { createBackendResponseObserver, readSafeSupabaseError } from './supabase-diagnostics.js';

const BACKEND_RPCS = new Set([
  'service_resolve_gmail_target',
  'service_resolve_gmail_client_target',
  'service_resolve_gmail_mailbox',
  'service_match_gmail_clients',
  'service_resolve_gmail_outbox_target',
  'service_set_gmail_integration',
  'service_disable_gmail_integration',
  'service_upsert_gmail_thread_context',
  'service_get_gmail_thread_context',
  'claim_email_outbox',
  'record_email_outbox_result',
]);

const USER_RPCS = new Set([
  'gpt_authorize_gmail_enquiry',
  'gpt_create_gmail_reply_draft',
  'list_capabilities',
]);

function projectOrigin(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  let url;
  try { url = new URL(value); } catch { throw new Error('gmail_supabase_url_invalid'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('gmail_supabase_url_invalid');
  }
  return url.origin;
}

function validBearer(bearer) {
  return typeof bearer === 'string' && /^[A-Za-z0-9._~-]{16,8192}$/.test(bearer);
}

function safeJsonResponse(response) {
  return response.json().catch(() => null);
}

async function callRpc(origin, name, args, headers, fetchImpl, observe, retrySecret401 = false) {
  let details;
  const request = async (attempt) => {
    const startedAt = Date.now();
    const response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args || {}),
      // Workers supports manual/follow only. Reject 3xx below without forwarding credentials.
      redirect: 'manual',
    });
    details = observe
      ? await observe(name, response, startedAt, attempt)
      : await readSafeSupabaseError(response);
    return response;
  };

  let response = await request(1);
  if (retrySecret401 && !response.ok && response.status === 401) {
    response = await request(2);
  }

  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? 'gmail_rpc_forbidden' : 'gmail_rpc_failed');
    error.status = response.status;
    error.code = details.supabase_code;
    throw error;
  }
  return safeJsonResponse(response);
}

async function readUserEnquiry(origin, enquiryId, headers, fetchImpl) {
  if (typeof enquiryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(enquiryId)) throw new Error('gmail_enquiry_id_invalid');
  const url = new URL('/rest/v1/enquiries', origin);
  url.searchParams.set('select', 'id,artist_id,client_id');
  url.searchParams.set('id', `eq.${enquiryId}`);
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...headers, accept: 'application/json' },
    redirect: 'manual',
  });
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'gmail_operator_unauthorized'
      : response.status === 403
        ? 'gmail_rpc_forbidden'
        : 'gmail_rpc_failed');
    error.status = response.status;
    throw error;
  }
  const rows = await safeJsonResponse(response);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('gmail_operator_scope_invalid');
  const row = rows[0];
  if (!row || row.id !== enquiryId || typeof row.artist_id !== 'string' || typeof row.client_id !== 'string') {
    throw new Error('gmail_operator_scope_invalid');
  }
  return { enquiry_id: row.id, artist_id: row.artist_id, client_id: row.client_id };
}

/**
 * The artists a client is genuinely related to, as the CALLER's row level
 * security sees it.
 *
 * Clients are canonical people rather than artist-owned rows (0059), so the
 * artist has to come from somewhere authoritative. It comes from here: the
 * enquiries this operator can actually read for this client. The browser sends
 * only a client id; every routing fact is read back out of the database.
 *
 * Returns artist ids, deduplicated. Deliberately not a single id - deciding
 * what to do when a client belongs to two artists is the caller's business,
 * and quietly picking one here would be exactly the kind of invisible routing
 * choice this indirection exists to prevent.
 */
async function readUserClientArtists(origin, clientId, headers, fetchImpl) {
  if (typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('gmail_client_id_invalid');
  const url = new URL('/rest/v1/enquiries', origin);
  url.searchParams.set('select', 'artist_id');
  url.searchParams.set('client_id', `eq.${clientId}`);
  url.searchParams.set('limit', '50');
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...headers, accept: 'application/json' },
    redirect: 'manual',
  });
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'gmail_operator_unauthorized'
      : response.status === 403
        ? 'gmail_rpc_forbidden'
        : 'gmail_rpc_failed');
    error.status = response.status;
    throw error;
  }
  const rows = await safeJsonResponse(response);
  if (!Array.isArray(rows)) throw new Error('gmail_operator_scope_invalid');
  const artistIds = [];
  for (const row of rows) {
    if (!row || typeof row.artist_id !== 'string') throw new Error('gmail_operator_scope_invalid');
    if (!artistIds.includes(row.artist_id)) artistIds.push(row.artist_id);
  }
  if (artistIds.length === 0) throw new Error('gmail_operator_scope_invalid');
  return artistIds;
}

export function createGmailSupabase(env, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  const secret = String(env?.SUPABASE_SECRET_KEY || '').trim();
  const publishable = String(env?.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!secret.startsWith('sb_secret_')) throw new Error('gmail_supabase_secret_unavailable');
  if (!publishable.startsWith('sb_publishable_')) throw new Error('gmail_supabase_publishable_unavailable');
  const observe = createBackendResponseObserver('gmail_backend', 'secret');

  return {
    async backendRpc(name, args) {
      if (!BACKEND_RPCS.has(name)) throw new Error('gmail_backend_rpc_not_allowed');
      return callRpc(origin, name, args, { apikey: secret }, fetchImpl, observe, true);
    },
    async userRpc(name, args, bearer) {
      if (!USER_RPCS.has(name)) throw new Error('gmail_user_rpc_not_allowed');
      if (!validBearer(bearer)) throw new Error('gmail_oauth_token_invalid');
      return callRpc(origin, name, args, { apikey: publishable, authorization: `Bearer ${bearer}` }, fetchImpl);
    },
    async userClientArtists(clientId, bearer) {
      if (!validBearer(bearer)) throw new Error('gmail_operator_token_invalid');
      return readUserClientArtists(
        origin,
        clientId,
        { apikey: publishable, authorization: `Bearer ${bearer}` },
        fetchImpl,
      );
    },
    async userEnquiry(enquiryId, bearer) {
      if (!validBearer(bearer)) throw new Error('gmail_operator_token_invalid');
      return readUserEnquiry(
        origin,
        enquiryId,
        { apikey: publishable, authorization: `Bearer ${bearer}` },
        fetchImpl,
      );
    },
  };
}

export const __testing = Object.freeze({
  BACKEND_RPCS, USER_RPCS, projectOrigin, validBearer, readUserEnquiry, readUserClientArtists,
});
