import gptActionsWorker from './gpt-actions.js';

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const CRM_PRODUCTION_HOST = 'crm.vishartattoo.com';
const CHATGPT_CALLBACK_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
const OAUTH_BRIDGE_CALLBACK = 'https://gpt-actions.vishartattoo.com/oauth/callback';
const OAUTH_TOKEN_BODY_BYTES = 16 * 1024;
const OAUTH_BRIDGE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_MAX_LENGTH = 2048;
const OAUTH_CODE_MAX_LENGTH = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function validClientId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 200
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function safeChatGPTCallback(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (!CHATGPT_CALLBACK_HOSTS.has(url.hostname)) return null;
  if (!/^\/aip\/[A-Za-z0-9_-]+\/oauth\/callback$/.test(url.pathname)) return null;
  return url.toString();
}

function classifyAuthorizeRequest(url) {
  if (url.searchParams.get('response_type') !== 'code') return 'oauth_authorize_response_type_invalid';
  if (!validClientId(url.searchParams.get('client_id'))) return 'oauth_authorize_client_id_invalid';
  if (!safeChatGPTCallback(url.searchParams.get('redirect_uri'))) return 'oauth_authorize_redirect_uri_invalid';

  const state = url.searchParams.get('state') || '';
  if (!state || state.length > OAUTH_STATE_MAX_LENGTH) return 'oauth_authorize_state_invalid';

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

  return safeChatGPTCallback(value);
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

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function oauthBridgeSecret(env) {
  const value = env?.GPT_OAUTH_BRIDGE_SECRET;
  return typeof value === 'string' && value.length >= 32 ? value : null;
}

async function bridgeCryptoKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealBridgePayload(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await bridgeCryptoKey(secret);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function openBridgePayload(value, secret) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('bridge_value_invalid');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('bridge_version_invalid');
  const iv = base64UrlDecode(parts[1]);
  if (iv.byteLength !== 12) throw new Error('bridge_iv_invalid');
  const ciphertext = base64UrlDecode(parts[2]);
  const key = await bridgeCryptoKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}

function bridgePayloadValid(payload, kind) {
  return payload
    && payload.v === 1
    && payload.kind === kind
    && validClientId(payload.client_id)
    && safeChatGPTCallback(payload.redirect_uri)
    && typeof payload.exp === 'number'
    && Number.isFinite(payload.exp)
    && payload.exp >= Date.now()
    && payload.exp <= Date.now() + OAUTH_BRIDGE_TTL_MS + 60_000;
}

function randomCodeVerifier() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function codeChallengeFor(verifier) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return base64UrlEncode(digest);
}

function parseBasicClientId(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    const clientId = decoded.slice(0, separator);
    return validClientId(clientId) ? clientId : null;
  } catch {
    return null;
  }
}

function redirectWithParams(destination, params) {
  const url = new URL(destination);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) url.searchParams.set(key, value);
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE_HEADERS, location: url.toString() } });
}

function routeClass(pathname) {
  if (pathname === '/privacy' || pathname === '/privacy/') return 'privacy';
  if (pathname === '/oauth/authorize' || pathname === '/oauth/authorize/') return 'oauth_authorize';
  if (pathname === '/oauth/callback' || pathname === '/oauth/callback/') return 'oauth_callback';
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

async function handleAuthorize(request, url, env, fetchImpl) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...NO_STORE_HEADERS, allow: 'GET' } });
  const requestError = classifyAuthorizeRequest(url);
  if (requestError) return jsonError(400, requestError);
  const secret = oauthBridgeSecret(env);
  if (!secret) return jsonError(503, 'oauth_bridge_secret_unavailable');

  const redirectUri = safeChatGPTCallback(url.searchParams.get('redirect_uri'));
  const verifier = randomCodeVerifier();
  const challenge = await codeChallengeFor(verifier);
  const bridgeState = await sealBridgePayload({
    v: 1,
    kind: 'authorize',
    client_id: url.searchParams.get('client_id'),
    redirect_uri: redirectUri,
    state: url.searchParams.get('state'),
    verifier,
    exp: Date.now() + OAUTH_BRIDGE_TTL_MS,
  }, secret);

  const target = new URL('/auth/v1/oauth/authorize', PRODUCTION_SUPABASE_ORIGIN);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', url.searchParams.get('client_id'));
  target.searchParams.set('redirect_uri', OAUTH_BRIDGE_CALLBACK);
  target.searchParams.set('scope', url.searchParams.get('scope')?.trim() || 'email');
  target.searchParams.set('state', bridgeState);
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');

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

async function handleBridgeCallback(request, url, env) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...NO_STORE_HEADERS, allow: 'GET' } });
  const secret = oauthBridgeSecret(env);
  if (!secret) return jsonError(503, 'oauth_bridge_secret_unavailable');
  const encodedState = url.searchParams.get('state') || '';
  if (!encodedState || encodedState.length > 8192) return jsonError(400, 'oauth_callback_state_invalid');

  let bridge;
  try {
    bridge = await openBridgePayload(encodedState, secret);
  } catch {
    return jsonError(400, 'oauth_callback_state_invalid');
  }
  if (!bridgePayloadValid(bridge, 'authorize') || typeof bridge.state !== 'string' || !bridge.state || bridge.state.length > OAUTH_STATE_MAX_LENGTH) {
    return jsonError(400, 'oauth_callback_state_invalid');
  }
  if (typeof bridge.verifier !== 'string' || bridge.verifier.length < 43 || bridge.verifier.length > 128) {
    return jsonError(400, 'oauth_callback_state_invalid');
  }

  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const safeError = /^[A-Za-z0-9._-]{1,100}$/.test(oauthError) ? oauthError : 'access_denied';
    const description = (url.searchParams.get('error_description') || '').slice(0, 512);
    return redirectWithParams(bridge.redirect_uri, {
      error: safeError,
      error_description: description,
      state: bridge.state,
    });
  }

  const upstreamCode = url.searchParams.get('code') || '';
  if (!upstreamCode || upstreamCode.length > OAUTH_CODE_MAX_LENGTH) return jsonError(400, 'oauth_callback_code_invalid');
  const bridgeCode = await sealBridgePayload({
    v: 1,
    kind: 'code',
    client_id: bridge.client_id,
    redirect_uri: bridge.redirect_uri,
    code: upstreamCode,
    verifier: bridge.verifier,
    exp: Math.min(bridge.exp, Date.now() + OAUTH_BRIDGE_TTL_MS),
  }, secret);
  return redirectWithParams(bridge.redirect_uri, { code: bridgeCode, state: bridge.state });
}

async function handleToken(request, env, fetchImpl) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...NO_STORE_HEADERS, allow: 'POST' } });
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return jsonError(415, 'oauth_token_content_type_required');
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_TOKEN_BODY_BYTES) return jsonError(413, 'oauth_token_body_too_large');
  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > OAUTH_TOKEN_BODY_BYTES) return jsonError(413, 'oauth_token_body_too_large');

  const authorization = request.headers.get('authorization');
  const basicClientId = parseBasicClientId(authorization);
  if (!basicClientId) return jsonError(401, 'oauth_token_client_auth_required');

  const incoming = new URLSearchParams(decoder.decode(bodyBytes));
  const grantType = incoming.get('grant_type');
  let upstreamBody;

  if (grantType === 'authorization_code') {
    const secret = oauthBridgeSecret(env);
    if (!secret) return jsonError(503, 'oauth_bridge_secret_unavailable');
    const bridgeCode = incoming.get('code') || '';
    let bridge;
    try {
      bridge = await openBridgePayload(bridgeCode, secret);
    } catch {
      return jsonError(400, 'oauth_token_bridge_code_invalid');
    }
    if (!bridgePayloadValid(bridge, 'code')
      || bridge.client_id !== basicClientId
      || typeof bridge.code !== 'string'
      || !bridge.code
      || bridge.code.length > OAUTH_CODE_MAX_LENGTH
      || typeof bridge.verifier !== 'string'
      || bridge.verifier.length < 43
      || bridge.verifier.length > 128) {
      return jsonError(400, 'oauth_token_bridge_code_invalid');
    }
    const requestedRedirect = safeChatGPTCallback(incoming.get('redirect_uri'));
    if (!requestedRedirect || requestedRedirect !== bridge.redirect_uri) return jsonError(400, 'oauth_token_redirect_uri_invalid');
    const bodyClientId = incoming.get('client_id');
    if (bodyClientId && bodyClientId !== bridge.client_id) return jsonError(400, 'oauth_token_client_id_mismatch');

    upstreamBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: bridge.code,
      redirect_uri: OAUTH_BRIDGE_CALLBACK,
      code_verifier: bridge.verifier,
    }).toString();
  } else if (grantType === 'refresh_token') {
    const refreshToken = incoming.get('refresh_token') || '';
    if (!refreshToken || refreshToken.length > 8192) return jsonError(400, 'oauth_token_refresh_token_invalid');
    const bodyClientId = incoming.get('client_id');
    if (bodyClientId && bodyClientId !== basicClientId) return jsonError(400, 'oauth_token_client_id_mismatch');
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const scope = incoming.get('scope');
    if (scope) {
      if (scope.trim() !== 'email') return jsonError(400, 'oauth_token_scope_invalid');
      params.set('scope', 'email');
    }
    upstreamBody = params.toString();
  } else {
    return jsonError(400, 'oauth_token_grant_type_invalid');
  }

  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  headers.set('authorization', authorization);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let upstream;
  try {
    upstream = await fetchImpl(`${PRODUCTION_SUPABASE_ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST', headers, body: upstreamBody, redirect: 'manual',
    });
  } catch {
    return jsonError(502, 'oauth_token_upstream_unavailable');
  }
  return new Response(upstream.body, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
}

export async function handleOAuthRelay(request, env, fetchImpl = fetch) {
  if (env?.GPT_OAUTH_RELAY_ENABLED !== 'true') return null;

  const url = new URL(request.url);
  const authorizePath = url.pathname === '/oauth/authorize' || url.pathname === '/oauth/authorize/';
  const callbackPath = url.pathname === '/oauth/callback' || url.pathname === '/oauth/callback/';
  const tokenPath = url.pathname === '/oauth/token' || url.pathname === '/oauth/token/';
  if (!authorizePath && !callbackPath && !tokenPath) return null;
  if (!exactProductionOrigin(env)) return jsonError(503, 'oauth_relay_production_boundary_mismatch');

  if (authorizePath) return handleAuthorize(request, url, env, fetchImpl);
  if (callbackPath) return handleBridgeCallback(request, url, env);
  return handleToken(request, env, fetchImpl);
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
  OAUTH_BRIDGE_CALLBACK,
  OAUTH_TOKEN_BODY_BYTES,
  OAUTH_BRIDGE_TTL_MS,
  exactProductionOrigin,
  classifyAuthorizeRequest,
  safeChatGPTCallback,
  safeAuthorizeRedirect,
  routeClass,
  publicRoute,
  enforceRateLimit,
  sealBridgePayload,
  openBridgePayload,
});
