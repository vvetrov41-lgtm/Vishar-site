// Narrow Supabase client for the Instagram connector.
//
// Two allow-lists, one per trust level, mirroring the Gmail connector:
//
//   backendRpc  runs with the service secret and may call only the trusted
//               ingestion, routing and queue functions;
//   userRpc     runs with the operator's own Supabase session and may call
//               only the onboarding authorisation function.
//
// The allow-lists are the point. A Worker that could call any RPC with the
// service secret would be a general-purpose database credential wherever it
// runs, and a bug in request routing would become privilege escalation.

const BACKEND_RPCS = new Set([
  'service_resolve_instagram_route',
  'service_set_instagram_integration',
  'service_disable_instagram_integration',
  'service_update_communication_participant',
  'service_list_unenriched_participants',
  'record_communication_inbound_message',
  'record_communication_outbound_echo',
  'record_communication_read_receipt',
  'claim_communication_outbox',
  'record_communication_outbox_result',
  'resolve_outbox_route',
]);

const USER_RPCS = new Set([
  'authorize_instagram_connection',
]);

function projectOrigin(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('instagram_supabase_url_invalid');
  }
  if (
    url.protocol !== 'https:'
    || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('instagram_supabase_url_invalid');
  }
  return url.origin;
}

function safeJsonResponse(response) {
  return response.json().catch(() => null);
}

async function callRpc(origin, name, args, headers, fetchImpl) {
  const response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(args || {}),
    redirect: 'error',
  });
  const json = await safeJsonResponse(response);
  if (!response.ok) {
    const error = new Error(
      response.status === 401 || response.status === 403
        ? 'instagram_rpc_forbidden'
        : 'instagram_rpc_failed',
    );
    error.status = response.status;
    // Postgres error codes are safe to surface; provider payloads are not.
    error.pgcode = typeof json?.code === 'string' ? json.code : null;
    throw error;
  }
  return json;
}

export function createInstagramSupabase(env, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  const secret = String(env?.SUPABASE_SECRET_KEY || '').trim();
  const publishable = String(env?.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!secret.startsWith('sb_secret_')) throw new Error('instagram_supabase_secret_unavailable');
  if (!publishable.startsWith('sb_publishable_')) {
    throw new Error('instagram_supabase_publishable_unavailable');
  }

  return {
    async rpc(name, args) {
      if (!BACKEND_RPCS.has(name)) throw new Error('instagram_backend_rpc_not_allowed');
      return callRpc(origin, name, args, { apikey: secret }, fetchImpl);
    },
    async userRpc(name, args, bearer) {
      if (!USER_RPCS.has(name)) throw new Error('instagram_user_rpc_not_allowed');
      if (typeof bearer !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(bearer)) {
        throw new Error('instagram_session_token_invalid');
      }
      return callRpc(
        origin,
        name,
        args,
        { apikey: publishable, authorization: `Bearer ${bearer}` },
        fetchImpl,
      );
    },
  };
}

export const __testing = Object.freeze({ BACKEND_RPCS, USER_RPCS, projectOrigin });
