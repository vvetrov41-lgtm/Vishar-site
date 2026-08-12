import gptActionsWorker from './gpt-actions.js';

const RETAINED_STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';
const CRM_STAGING_HOST = 'vishar-crm-staging.pages.dev';
const CHATGPT_CALLBACK_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
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

function classifyAuthorizeRequest(url) {
  const responseType = url.searchParams.get('response_type');
  if (responseType && responseType !== 'code') {
    return 'oauth_authorize_response_type_invalid';
  }

  const scope = url.searchParams.get('scope');
  if (scope && scope.trim() !== 'email') {
    return 'oauth_authorize_scope_invalid';
  }

  const resource = url.searchParams.get('resource');
  if (resource) {
    try {
      const parsed = new URL(resource);
      if (!parsed.protocol || parsed.hash || parsed.search) {
        return 'oauth_authorize_resource_invalid';
      }
    } catch {
      return 'oauth_authorize_resource_invalid';
    }
  }

  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';
  if (!codeChallenge || !codeChallengeMethod) {
    return 'oauth_authorize_pkce_missing';
  }

  const normalizedMethod = codeChallengeMethod.toLowerCase();
  if (normalizedMethod !== 's256' && normalizedMethod !== 'plain') {
    return 'oauth_authorize_pkce_method_invalid';
  }

  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    return 'oauth_authorize_pkce_challenge_invalid';
  }

  return null;
}

function safeAuthorizeRedirect(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;

  if (url.hostname === CRM_STAGING_HOST) {
    return (url.pathname === '/oauth/consent' || url.pathname === '/oauth/consent/')
      ? url.toString()
      : null;
  }

  if (CHATGPT_CALLBACK_HOSTS.has(url.hostname)) {
    return url.pathname.startsWith('/aip/') ? url.toString() : null;
  }

  return null;
}

function safeUpstreamHeaders(upstream, { allowLocation = false } = {}) {
  const headers = new Headers(NO_STORE_HEADERS);
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  if (allowLocation) {
    const location = safeAuthorizeRedirect(upstream.headers.get('location'));
    if (location) headers.set('location', location);
  }
  return headers;
}

export async function handleOAuthRelay(request, env, fetchImpl = fetch) {
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

    const requestError = classifyAuthorizeRequest(url);
    if (requestError) return jsonError(400, requestError);

    const target = new URL('/auth/v1/oauth/authorize', RETAINED_STAGING_SUPABASE_ORIGIN);
    target.search = url.search;

    const headers = new Headers();
    const accept = request.headers.get('accept');
    if (accept) headers.set('accept', accept);

    let upstream;
    try {
      upstream = await fetchImpl(target.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
      });
    } catch {
      return jsonError(502, 'oauth_authorize_upstream_unavailable');
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = safeAuthorizeRedirect(upstream.headers.get('location'));
      if (!location) return jsonError(502, 'oauth_authorize_unsafe_redirect');
      return new Response(null, {
        status: upstream.status,
        headers: {
          ...NO_STORE_HEADERS,
          location,
        },
      });
    }

    if (!upstream.ok) return jsonError(upstream.status, 'oauth_authorize_upstream_rejected');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: safeUpstreamHeaders(upstream),
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

  const headers = new Headers({
    'content-type': contentType,
  });
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let upstream;
  try {
    upstream = await fetchImpl(`${RETAINED_STAGING_SUPABASE_ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    });
  } catch {
    return jsonError(502, 'oauth_token_upstream_unavailable');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: safeUpstreamHeaders(upstream),
  });
}

export default {
  async fetch(request, env) {
    const relayResponse = await handleOAuthRelay(request, env);
    if (relayResponse) return relayResponse;
    return gptActionsWorker.fetch(request, env);
  },
};

export const __testing = Object.freeze({
  RETAINED_STAGING_SUPABASE_ORIGIN,
  OAUTH_TOKEN_BODY_BYTES,
  classifyAuthorizeRequest,
  safeAuthorizeRedirect,
});
