import gptActionsWorker from './gpt-actions.js';

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const CRM_PRODUCTION_HOST = 'crm.vishartattoo.com';
const CHATGPT_CALLBACK_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
const OAUTH_TOKEN_BODY_BYTES = 16 * 1024;

const NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const PUBLIC_HEADERS = Object.freeze({
  'cache-control': 'public, max-age=300',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
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

function exactProductionOrigin(env) {
  return env?.VISHAR_ENVIRONMENT === 'production'
    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN;
}

function classifyAuthorizeRequest(url) {
  const responseType = url.searchParams.get('response_type');
  if (responseType && responseType !== 'code') return 'oauth_authorize_response_type_invalid';

  const scope = url.searchParams.get('scope');
  if (scope && scope.trim() !== 'email') return 'oauth_authorize_scope_invalid';

  const resource = url.searchParams.get('resource');
  if (resource) {
    try {
      const parsed = new URL(resource);
      if (!parsed.protocol || parsed.hash || parsed.search) return 'oauth_authorize_resource_invalid';
    } catch {
      return 'oauth_authorize_resource_invalid';
    }
  }

  const challenge = url.searchParams.get('code_challenge') || '';
  const method = url.searchParams.get('code_challenge_method') || '';
  if (!challenge || !method) return 'oauth_authorize_pkce_missing';
  if (method.toUpperCase() !== 'S256') return 'oauth_authorize_pkce_method_invalid';
  if (challenge.length < 43 || challenge.length > 128) return 'oauth_authorize_pkce_challenge_invalid';
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

  if (url.hostname === CRM_PRODUCTION_HOST) {
    return (url.pathname === '/oauth/consent' || url.pathname === '/oauth/consent/')
      ? url.toString()
      : null;
  }

  if (CHATGPT_CALLBACK_HOSTS.has(url.hostname) && url.pathname.startsWith('/aip/')) {
    return url.toString();
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

function routeClass(pathname) {
  if (pathname === '/privacy' || pathname === '/privacy/') return 'privacy';
  if (pathname === '/oauth/authorize' || pathname === '/oauth/authorize/') return 'oauth_authorize';
  if (pathname === '/oauth/token' || pathname === '/oauth/token/') return 'oauth_token';
  if (pathname.startsWith('/v1/')) return 'actions';
  return 'other';
}

async function enforceRateLimit(request, url, env) {
  const limiter = env?.GPT_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await limiter.limit({ key: `${routeClass(url.pathname)}:${address}` });
  return success ? null : jsonError(429, 'rate_limited');
}

const PRIVACY_HTML = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vishar CRM Private GPT Actions Privacy Notice</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.55;background:#0b0b0b;color:#f4f4f4}h1,h2{line-height:1.2}h1{font-size:2rem}h2{margin-top:2rem;font-size:1.2rem}p,li{color:#d4d4d4}a{color:#fff}</style>
</head>
<body>
<h1>Vishar CRM Private GPT Actions Privacy Notice</h1>
<p>This private production integration connects an authorised Vishar CRM user to artist-scoped appointment actions. It is not a public booking service.</p>
<h2>What the private GPT can access</h2>
<p>After CRM sign-in, the action service can access only appointment functions for the single artist permanently bound to that GPT OAuth client. The action API does not accept an artist identifier from ChatGPT.</p>
<ul><li>Search existing client names, returning only client ID and name.</li><li>List and read appointments.</li><li>Check appointment conflicts.</li><li>Create, reschedule or cancel appointments when the signed-in CRM user also has the required permission.</li></ul>
<h2>Data deliberately excluded</h2>
<p>The action surface does not expose client email addresses, phone numbers, Instagram handles, addresses, finance, payments, arbitrary database queries or privileged Supabase credentials. It does not provide a client-messaging action.</p>
<h2>Authentication and artist separation</h2>
<p>Authentication uses the production Supabase OAuth server. A separate OAuth client is registered for each private GPT and bound in the CRM database to exactly one artist. CRM identity, active membership and appointment permissions are checked again for every action.</p>
<h2>Changes made through the GPT</h2>
<p>Writes use idempotency request IDs. Reschedule and cancellation require the current calendar version. AI-assisted mutations are recorded in the CRM activity log and Calendar synchronisation follows the same CRM outbox used by human CRM actions.</p>
<h2>Providers</h2>
<p>OpenAI provides ChatGPT and the private GPT interface. Cloudflare hosts the action endpoint. Supabase provides authentication and the CRM database. Google Calendar may receive appointment projections through the separately authorised production Calendar integration.</p>
<h2>Contact</h2>
<p>Questions can be sent to <a href="mailto:info@vishartattoo.com">info@vishartattoo.com</a>.</p>
</body>
</html>`;

function publicRoute(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  if (url.pathname !== '/privacy' && url.pathname !== '/privacy/') return null;
  return new Response(request.method === 'HEAD' ? null : PRIVACY_HTML, {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function handleOAuthRelay(request, env, fetchImpl = fetch) {
  if (env?.GPT_OAUTH_RELAY_ENABLED !== 'true') return null;

  const url = new URL(request.url);
  const authorizePath = url.pathname === '/oauth/authorize' || url.pathname === '/oauth/authorize/';
  const tokenPath = url.pathname === '/oauth/token' || url.pathname === '/oauth/token/';
  if (!authorizePath && !tokenPath) return null;
  if (!exactProductionOrigin(env)) return jsonError(503, 'oauth_relay_production_boundary_mismatch');

  if (authorizePath) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...NO_STORE_HEADERS, allow: 'GET' } });
    const requestError = classifyAuthorizeRequest(url);
    if (requestError) return jsonError(400, requestError);

    const target = new URL('/auth/v1/oauth/authorize', PRODUCTION_SUPABASE_ORIGIN);
    target.search = url.search;
    const headers = new Headers();
    const accept = request.headers.get('accept');
    if (accept) headers.set('accept', accept);

    let upstream;
    try {
      upstream = await fetchImpl(target.toString(), { method: 'GET', headers, redirect: 'manual' });
    } catch {
      return jsonError(502, 'oauth_authorize_upstream_unavailable');
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = safeAuthorizeRedirect(upstream.headers.get('location'));
      if (!location) return jsonError(502, 'oauth_authorize_unsafe_redirect');
      return new Response(null, { status: upstream.status, headers: { ...NO_STORE_HEADERS, location } });
    }
    if (!upstream.ok) return jsonError(upstream.status, 'oauth_authorize_upstream_rejected');
    return new Response(upstream.body, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
  }

  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...NO_STORE_HEADERS, allow: 'POST' } });
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return jsonError(415, 'oauth_token_content_type_required');
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_TOKEN_BODY_BYTES) return jsonError(413, 'oauth_token_body_too_large');
  const body = await request.arrayBuffer();
  if (body.byteLength > OAUTH_TOKEN_BODY_BYTES) return jsonError(413, 'oauth_token_body_too_large');

  const headers = new Headers({ 'content-type': contentType });
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let upstream;
  try {
    upstream = await fetchImpl(`${PRODUCTION_SUPABASE_ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST', headers, body, redirect: 'manual',
    });
  } catch {
    return jsonError(502, 'oauth_token_upstream_unavailable');
  }
  return new Response(upstream.body, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const limited = await enforceRateLimit(request, url, env);
    if (limited) return limited;

    const publicResponse = publicRoute(request);
    if (publicResponse) return publicResponse;

    if (!exactProductionOrigin(env)) return jsonError(503, 'gpt_actions_production_boundary_mismatch');
    const relayResponse = await handleOAuthRelay(request, env);
    if (relayResponse) return relayResponse;
    return gptActionsWorker.fetch(request, env);
  },
};

export const __testing = Object.freeze({
  PRODUCTION_SUPABASE_ORIGIN,
  CRM_PRODUCTION_HOST,
  OAUTH_TOKEN_BODY_BYTES,
  exactProductionOrigin,
  classifyAuthorizeRequest,
  safeAuthorizeRedirect,
  routeClass,
  publicRoute,
  enforceRateLimit,
});
