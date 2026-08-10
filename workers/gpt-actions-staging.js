import gptActionsWorker from './gpt-actions.js';

const RETAINED_STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';
const OAUTH_TOKEN_BODY_BYTES = 16 * 1024;

const NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function exactStagingOrigin(env) {
  return env.SUPABASE_URL === RETAINED_STAGING_SUPABASE_ORIGIN;
}

export async function handleOAuthRelay(request, env) {
  if (env.GPT_OAUTH_RELAY_ENABLED !== 'true') return null;

  const url = new URL(request.url);
  const authorizePath = url.pathname === '/oauth/authorize' || url.pathname === '/oauth/authorize/';
  const tokenPath = url.pathname === '/oauth/token' || url.pathname === '/oauth/token/';
  if (!authorizePath && !tokenPath) return null;

  if (!exactStagingOrigin(env)) return jsonError(503, 'oauth_relay_staging_boundary_mismatch');

  if (authorizePath) {
    if (request.method !== 'GET') {
      return new Response(null, {
        status: 405,
        headers: { ...NO_STORE_HEADERS, allow: 'GET' },
      });
    }

    const target = new URL('/auth/v1/oauth/authorize', RETAINED_STAGING_SUPABASE_ORIGIN);
    target.search = url.search;
    return new Response(null, {
      status: 302,
      headers: {
        ...NO_STORE_HEADERS,
        location: target.toString(),
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: { ...NO_STORE_HEADERS, allow: 'POST' },
    });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return jsonError(415, 'oauth_token_content_type_required');
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_TOKEN_BODY_BYTES) {
    return jsonError(413, 'oauth_token_body_too_large');
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > OAUTH_TOKEN_BODY_BYTES) return jsonError(413, 'oauth_token_body_too_large');

  const headers = new Headers({ 'content-type': contentType });
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let upstream;
  try {
    upstream = await fetch(`${RETAINED_STAGING_SUPABASE_ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    });
  } catch {
    return jsonError(502, 'oauth_token_upstream_unavailable');
  }

  const responseHeaders = new Headers(NO_STORE_HEADERS);
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) responseHeaders.set('content-type', upstreamContentType);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    const relayResponse = await handleOAuthRelay(request, env);
    if (relayResponse) return relayResponse;
    return gptActionsWorker.fetch(request, env);
  },
};

export const __testing = Object.freeze({ RETAINED_STAGING_SUPABASE_ORIGIN, OAUTH_TOKEN_BODY_BYTES });
