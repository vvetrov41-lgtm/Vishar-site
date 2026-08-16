import productionWorker from './gpt-actions-production.js';

const OAUTH_TOKEN_BODY_BYTES = 16 * 1024;
const OAUTH_CLIENT_SECRET_MAX_LENGTH = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function validClientId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 200
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function basicAuthorization(clientId, clientSecret) {
  const bytes = encoder.encode(`${clientId}:${clientSecret}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function isTokenRequest(request) {
  if (request.method !== 'POST') return false;
  const pathname = new URL(request.url).pathname;
  return pathname === '/oauth/token' || pathname === '/oauth/token/';
}

export async function normalizeTokenClientAuth(request) {
  if (!isTokenRequest(request)) return request;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return request;

  // Preserve the existing client_secret_basic path exactly as-is.
  if (request.headers.get('authorization')) return request;

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_TOKEN_BODY_BYTES) return request;

  const bodyBytes = await request.clone().arrayBuffer();
  if (bodyBytes.byteLength > OAUTH_TOKEN_BODY_BYTES) return request;

  const incoming = new URLSearchParams(decoder.decode(bodyBytes));
  const clientId = incoming.get('client_id');
  const clientSecret = incoming.get('client_secret');

  // No POST client credentials means the canonical worker will return its
  // existing oauth_token_client_auth_required response.
  if (clientId === null && clientSecret === null) return request;

  if (!validClientId(clientId)
    || typeof clientSecret !== 'string'
    || clientSecret.length < 1
    || clientSecret.length > OAUTH_CLIENT_SECRET_MAX_LENGTH) {
    return jsonError(401, 'oauth_token_client_auth_required');
  }

  // Supabase production clients remain confidential client_secret_basic.
  // The edge accepts ChatGPT's POST exchange form only as a compatibility
  // input, converts it to Basic, and removes the secret from the body before
  // handing the request to the canonical production OAuth bridge.
  const headers = new Headers(request.headers);
  headers.set('authorization', basicAuthorization(clientId, clientSecret));
  headers.delete('content-length');
  incoming.delete('client_secret');

  return new Request(request.url, {
    method: 'POST',
    headers,
    body: incoming.toString(),
  });
}

export default {
  async fetch(request, env) {
    const normalized = await normalizeTokenClientAuth(request);
    if (normalized instanceof Response) return normalized;
    return productionWorker.fetch(normalized, env);
  },
};

export const __testing = Object.freeze({
  OAUTH_TOKEN_BODY_BYTES,
  OAUTH_CLIENT_SECRET_MAX_LENGTH,
  validClientId,
  basicAuthorization,
  isTokenRequest,
});
