// Narrow Supabase client for the Instagram connector.
//
// The connector has one privileged RPC allow-list. Operator identity is not
// accepted from the browser body: the Worker verifies the supplied CRM session
// with Supabase Auth and only then passes the verified user id to the backend
// authorization RPC. Supabase Auth establishes identity only; artist membership
// and integration capability are still decided by the backend-only database RPC.
//
// The allow-list is the point. A Worker that could call any RPC with the
// service secret would be a general-purpose database credential wherever it
// runs, and a bug in request routing would become privilege escalation.

const BACKEND_RPCS = new Set([
  'service_authorize_instagram_connection',
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

// Retained as an explicit empty surface so tests can prove no browser-scoped RPC
// remains callable through the privileged Worker adapter.
const USER_RPCS = new Set();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_TOKEN = /^[A-Za-z0-9._~-]{16,8192}$/;

class InstagramSupabaseError extends Error {
  constructor(code, { status = null, pgcode = null } = {}) {
    super(code);
    this.name = 'InstagramSupabaseError';
    this.code = code;
    this.status = status;
    this.pgcode = pgcode;
  }
}

function projectOrigin(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InstagramSupabaseError('instagram_supabase_url_invalid');
  }
  if (
    url.protocol !== 'https:'
    || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new InstagramSupabaseError('instagram_supabase_url_invalid');
  }
  return url.origin;
}

function safeJsonResponse(response) {
  return response.json().catch(() => null);
}

async function callRpc(origin, name, args, headers, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args || {}),
      redirect: 'error',
    });
  } catch {
    throw new InstagramSupabaseError('instagram_rpc_unavailable');
  }

  const json = await safeJsonResponse(response);
  if (!response.ok) {
    const pgcode = typeof json?.code === 'string' ? json.code : null;
    throw new InstagramSupabaseError(
      pgcode === '42501' ? 'instagram_permission_denied' : 'instagram_rpc_failed',
      { status: response.status, pgcode },
    );
  }
  return json;
}

async function verifySession(origin, secret, bearer, fetchImpl) {
  if (typeof bearer !== 'string' || !SESSION_TOKEN.test(bearer)) {
    throw new InstagramSupabaseError('instagram_session_invalid', { status: 401 });
  }

  let response;
  try {
    response = await fetchImpl(`${origin}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: secret,
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
      },
      redirect: 'error',
    });
  } catch {
    throw new InstagramSupabaseError('instagram_session_verification_unavailable');
  }

  const json = await safeJsonResponse(response);
  if (response.status === 401 || response.status === 403) {
    throw new InstagramSupabaseError('instagram_session_invalid', { status: 401 });
  }
  if (!response.ok || !UUID.test(json?.id || '')) {
    throw new InstagramSupabaseError('instagram_session_verification_unavailable', {
      status: response.status,
    });
  }
  return { id: json.id };
}

export function createInstagramSupabase(env, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  const secret = String(env?.SUPABASE_SECRET_KEY || '').trim();
  if (!secret.startsWith('sb_secret_')) {
    throw new InstagramSupabaseError('instagram_supabase_secret_unavailable');
  }

  return {
    async verifyUser(bearer) {
      return verifySession(origin, secret, bearer, fetchImpl);
    },
    async rpc(name, args) {
      if (!BACKEND_RPCS.has(name)) {
        throw new InstagramSupabaseError('instagram_backend_rpc_not_allowed');
      }
      return callRpc(origin, name, args, { apikey: secret }, fetchImpl);
    },
  };
}

export const __testing = Object.freeze({
  BACKEND_RPCS,
  USER_RPCS,
  projectOrigin,
  verifySession,
  InstagramSupabaseError,
});
