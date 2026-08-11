import gptActionsWorker from './gpt-actions.js';

const RETAINED_STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';
const GPT_ACTIONS_STAGING_ORIGIN = 'https://gpt-actions-staging.vishartattoo.com';
const INTERNAL_BRIDGE_CALLBACK = `${GPT_ACTIONS_STAGING_ORIGIN}/oauth/authorize/`;
const CRM_STAGING_HOST = 'vishar-crm-staging.pages.dev';
const CHATGPT_CALLBACK_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
const OAUTH_TOKEN_BODY_BYTES = 16 * 1024;
const BRIDGE_STATE_TTL_SECONDS = 10 * 60;
const BRIDGE_CODE_TTL_SECONDS = 5 * 60;
const BRIDGE_AAD_PREFIX = 'vishar-gpt-oauth-pkce-bridge-v1';

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

function bridgeEnabled(env) {
  return env.GPT_OAUTH_PKCE_BRIDGE_ENABLED === 'true';
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function safeChatGPTCallback(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (!CHATGPT_CALLBACK_HOSTS.has(url.hostname)) return null;
  if (!/^\/aip\/[A-Za-z0-9_-]{8,200}\/oauth\/callback$/.test(url.pathname)) return null;
  return url.toString();
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

  if (url.origin === GPT_ACTIONS_STAGING_ORIGIN && url.pathname === '/oauth/authorize/') {
    return url.toString();
  }

  if (url.hostname === CRM_STAGING_HOST) {
    return (url.pathname === '/oauth/consent' || url.pathname === '/oauth/consent/')
      ? url.toString()
      : null;
  }

  if (CHATGPT_CALLBACK_HOSTS.has(url.hostname)) {
    return /^\/aip\/[A-Za-z0-9_-]{8,200}\/oauth\/callback$/.test(url.pathname)
      ? url.toString()
      : null;
  }

  return null;
}

function safeUpstreamHeaders(upstream) {
  const headers = new Headers(NO_STORE_HEADERS);
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

function classifyCommonAuthorizeRequest(url) {
  const clientId = url.searchParams.get('client_id') || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    return 'oauth_authorize_client_invalid';
  }

  if (!safeChatGPTCallback(url.searchParams.get('redirect_uri'))) {
    return 'oauth_authorize_callback_invalid';
  }

  const state = url.searchParams.get('state') || '';
  if (!state || state.length > 2048) return 'oauth_authorize_state_invalid';

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

  return null;
}

function classifyProvidedPKCE(url) {
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';

  if (!codeChallenge && !codeChallengeMethod) return null;
  if (!codeChallenge || !codeChallengeMethod) return 'oauth_authorize_pkce_partial';

  const normalizedMethod = codeChallengeMethod.toLowerCase();
  if (normalizedMethod !== 's256' && normalizedMethod !== 'plain') {
    return 'oauth_authorize_pkce_method_invalid';
  }

  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    return 'oauth_authorize_pkce_challenge_invalid';
  }

  return null;
}

async function bridgeKey(env) {
  const secret = env.GPT_OAUTH_BRIDGE_KEY;
  if (typeof secret !== 'string' || !secret) throw new Error('bridge secret missing');
  const raw = base64UrlDecode(secret);
  if (raw.byteLength !== 32) throw new Error('bridge secret invalid');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sealBridgePayload(env, purpose, payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = new TextEncoder().encode(JSON.stringify({
    v: 1,
    p: purpose,
    iat: now,
    exp: now + ttlSeconds,
    ...payload,
  }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${BRIDGE_AAD_PREFIX}:${purpose}`);
  const key = await bridgeKey(env);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, body);
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function openBridgePayload(env, purpose, value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('bridge payload invalid');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('bridge payload invalid');
  const iv = base64UrlDecode(parts[1]);
  const ciphertext = base64UrlDecode(parts[2]);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error('bridge payload invalid');
  const aad = new TextEncoder().encode(`${BRIDGE_AAD_PREFIX}:${purpose}`);
  const key = await bridgeKey(env);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1 || payload?.p !== purpose || !Number.isInteger(payload?.iat) || !Number.isInteger(payload?.exp)) {
    throw new Error('bridge payload invalid');
  }
  if (payload.exp < now || payload.iat > now + 60) throw new Error('bridge payload expired');
  return payload;
}

async function createPKCE() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
  };
}

function basicClientId(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Basic ')) return null;
  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    return decoded.slice(0, separator);
  } catch {
    return null;
  }
}

function redirectResponse(location, status = 302) {
  return new Response(null, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      location,
    },
  });
}

async function relayAuthorize(target, headers, fetchImpl) {
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
    return redirectResponse(location, upstream.status);
  }

  if (!upstream.ok) return jsonError(upstream.status, 'oauth_authorize_upstream_rejected');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: safeUpstreamHeaders(upstream),
  });
}

async function handleBridgeAuthorize(url, env, headers, fetchImpl) {
  let sealedState;
  let pkce;
  try {
    pkce = await createPKCE();
    sealedState = await sealBridgePayload(env, 'state', {
      clientId: url.searchParams.get('client_id'),
      redirectUri: safeChatGPTCallback(url.searchParams.get('redirect_uri')),
      originalState: url.searchParams.get('state'),
      verifier: pkce.verifier,
      resource: url.searchParams.get('resource') || '',
    }, BRIDGE_STATE_TTL_SECONDS);
  } catch {
    return jsonError(503, 'oauth_bridge_secret_unavailable');
  }

  const target = new URL('/auth/v1/oauth/authorize', RETAINED_STAGING_SUPABASE_ORIGIN);
  target.searchParams.set('client_id', url.searchParams.get('client_id'));
  target.searchParams.set('redirect_uri', INTERNAL_BRIDGE_CALLBACK);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', url.searchParams.get('scope') || 'email');
  target.searchParams.set('state', sealedState);
  target.searchParams.set('code_challenge', pkce.challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  const resource = url.searchParams.get('resource');
  if (resource) target.searchParams.set('resource', resource);
  const nonce = url.searchParams.get('nonce');
  if (nonce) target.searchParams.set('nonce', nonce);

  return relayAuthorize(target, headers, fetchImpl);
}

async function handleBridgeCallback(url, env) {
  if (!bridgeEnabled(env)) return jsonError(404, 'oauth_bridge_callback_disabled');

  let statePayload;
  try {
    statePayload = await openBridgePayload(env, 'state', url.searchParams.get('state'));
  } catch {
    return jsonError(400, 'oauth_bridge_state_invalid');
  }

  const originalCallback = safeChatGPTCallback(statePayload.redirectUri);
  if (!originalCallback || typeof statePayload.originalState !== 'string' || !statePayload.originalState) {
    return jsonError(400, 'oauth_bridge_state_invalid');
  }

  const destination = new URL(originalCallback);
  destination.searchParams.set('state', statePayload.originalState);

  const upstreamError = url.searchParams.get('error');
  if (upstreamError) {
    const safeError = new Set(['access_denied', 'invalid_request', 'server_error']).has(upstreamError)
      ? upstreamError
      : 'server_error';
    destination.searchParams.set('error', safeError);
    return redirectResponse(destination.toString());
  }

  const upstreamCode = url.searchParams.get('code') || '';
  if (!upstreamCode || upstreamCode.length > 4096 || typeof statePayload.verifier !== 'string') {
    return jsonError(400, 'oauth_bridge_callback_invalid');
  }

  let syntheticCode;
  try {
    syntheticCode = await sealBridgePayload(env, 'code', {
      upstreamCode,
      verifier: statePayload.verifier,
      clientId: statePayload.clientId,
      redirectUri: originalCallback,
      resource: statePayload.resource || '',
    }, BRIDGE_CODE_TTL_SECONDS);
  } catch {
    return jsonError(503, 'oauth_bridge_secret_unavailable');
  }

  destination.searchParams.set('code', syntheticCode);
  return redirectResponse(destination.toString());
}

async function handleBridgeTokenExchange(request, env, body, contentType, fetchImpl) {
  let params;
  try {
    params = new URLSearchParams(new TextDecoder().decode(body));
  } catch {
    return jsonError(400, 'oauth_token_form_invalid');
  }

  if (params.get('grant_type') !== 'authorization_code') return null;
  const syntheticCode = params.get('code') || '';
  if (!syntheticCode.startsWith('v1.')) return null;

  let codePayload;
  try {
    codePayload = await openBridgePayload(env, 'code', syntheticCode);
  } catch {
    return jsonError(400, 'oauth_bridge_code_invalid');
  }

  const requestRedirect = safeChatGPTCallback(params.get('redirect_uri'));
  if (!requestRedirect || requestRedirect !== codePayload.redirectUri) {
    return jsonError(400, 'oauth_bridge_token_redirect_mismatch');
  }

  const authorization = request.headers.get('authorization');
  const requestClientId = basicClientId(authorization);
  if (!requestClientId || requestClientId !== codePayload.clientId) {
    return jsonError(401, 'oauth_bridge_token_client_mismatch');
  }

  const upstreamParams = new URLSearchParams();
  upstreamParams.set('grant_type', 'authorization_code');
  upstreamParams.set('code', codePayload.upstreamCode);
  upstreamParams.set('redirect_uri', INTERNAL_BRIDGE_CALLBACK);
  upstreamParams.set('code_verifier', codePayload.verifier);
  if (codePayload.resource) upstreamParams.set('resource', codePayload.resource);

  const headers = new Headers({ 'content-type': contentType });
  headers.set('authorization', authorization);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  let upstream;
  try {
    upstream = await fetchImpl(`${RETAINED_STAGING_SUPABASE_ORIGIN}/auth/v1/oauth/token`, {
      method: 'POST',
      headers,
      body: upstreamParams.toString(),
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

export async function handleOAuthRelay(request, env, fetchImpl = fetch) {
  if (env.GPT_OAUTH_RELAY_ENABLED !== 'true') return null;

  const url = new URL(request.url);
  const authorizeEntryPath = url.pathname === '/oauth/authorize';
  const authorizeCallbackPath = url.pathname === '/oauth/authorize/';
  const tokenPath = url.pathname === '/oauth/token' || url.pathname === '/oauth/token/';
  if (!authorizeEntryPath && !authorizeCallbackPath && !tokenPath) return null;

  if (!exactStagingOrigin(env)) return jsonError(503, 'oauth_relay_staging_boundary_mismatch');

  if (authorizeCallbackPath) {
    if (request.method !== 'GET') {
      return new Response(null, {
        status: 405,
        headers: { ...NO_STORE_HEADERS, allow: 'GET' },
      });
    }
    return handleBridgeCallback(url, env);
  }

  if (authorizeEntryPath) {
    if (request.method !== 'GET') {
      return new Response(null, {
        status: 405,
        headers: { ...NO_STORE_HEADERS, allow: 'GET' },
      });
    }

    const commonError = classifyCommonAuthorizeRequest(url);
    if (commonError) return jsonError(400, commonError);
    const pkceError = classifyProvidedPKCE(url);
    if (pkceError) return jsonError(400, pkceError);

    const headers = new Headers();
    const accept = request.headers.get('accept');
    if (accept) headers.set('accept', accept);

    const hasClientPKCE = Boolean(url.searchParams.get('code_challenge') && url.searchParams.get('code_challenge_method'));
    if (!hasClientPKCE) {
      if (!bridgeEnabled(env)) return jsonError(400, 'oauth_authorize_pkce_missing');
      return handleBridgeAuthorize(url, env, headers, fetchImpl);
    }

    const target = new URL('/auth/v1/oauth/authorize', RETAINED_STAGING_SUPABASE_ORIGIN);
    target.search = url.search;
    return relayAuthorize(target, headers, fetchImpl);
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

  if (bridgeEnabled(env)) {
    const bridged = await handleBridgeTokenExchange(request, env, body, contentType, fetchImpl);
    if (bridged) return bridged;
  }

  const headers = new Headers({ 'content-type': contentType });
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
  GPT_ACTIONS_STAGING_ORIGIN,
  INTERNAL_BRIDGE_CALLBACK,
  OAUTH_TOKEN_BODY_BYTES,
  classifyCommonAuthorizeRequest,
  classifyProvidedPKCE,
  safeAuthorizeRedirect,
  safeChatGPTCallback,
});