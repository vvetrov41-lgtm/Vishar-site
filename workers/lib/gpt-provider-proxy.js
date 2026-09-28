// Calls a provider Worker for a provider-backed Unified GPT operation.
//
// It runs only after the operation's gpt_authorize_ RPC succeeded with the
// caller's own OAuth bearer. The Artist (and, for a client read, the client)
// comes from that database answer, never from the model. The provider Worker
// re-verifies the same bearer and CRM capability itself, and it alone holds
// provider tokens. No provider credential, account id or raw error passes
// back through here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024;

export const PROVIDER_ORIGINS = Object.freeze({
  gmail: 'https://gmail.vishartattoo.com',
  instagram: 'https://instagram.vishartattoo.com',
});

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function providerRequestFor(route, auth, token) {
  const artistId = typeof auth?.artist_id === 'string' && UUID.test(auth.artist_id) ? auth.artist_id : null;
  if (!artistId) throw new Error('provider_scope_invalid');
  const clientId = auth.client_id == null ? null : (UUID.test(auth.client_id) ? auth.client_id : false);
  if (clientId === false) throw new Error('provider_scope_invalid');

  const { service, method, path, artistIn } = route.provider;
  const origin = PROVIDER_ORIGINS[service];
  if (!origin) throw new Error('provider_unknown');

  let resolved = path.replace('{artist_id}', artistId);
  if (resolved.includes('{client_id}')) {
    if (!clientId) throw new Error('provider_scope_invalid');
    resolved = resolved.replace('{client_id}', clientId);
  }
  const url = new URL(resolved, origin);
  for (const [key, value] of Object.entries(route.providerParams || {})) url.searchParams.set(key, String(value));
  if (artistIn === 'query') url.searchParams.set('artist_id', artistId);

  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const init = { method, headers, redirect: 'manual' };
  if (artistIn === 'body') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ artist_id: artistId });
  }
  return new Request(url.toString(), init);
}

export async function callProvider(route, auth, token, env, fetchImpl) {
  let request;
  try {
    request = providerRequestFor(route, auth, token);
  } catch {
    return json(403, { error: 'provider_scope_invalid' });
  }

  let response;
  try {
    if (route.provider.service === 'gmail') {
      if (!env?.GMAIL_SERVICE || typeof env.GMAIL_SERVICE.fetch !== 'function') {
        return json(503, { error: 'gmail_provider_unavailable' });
      }
      response = await env.GMAIL_SERVICE.fetch(request);
    } else {
      response = await fetchImpl(request);
    }
  } catch {
    return json(502, { error: 'provider_unavailable' });
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    return json(502, { error: 'provider_response_too_large' });
  }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

  if (response.ok && parsed && typeof parsed === 'object') return json(200, parsed);
  if (response.status === 401) return json(401, { error: 'oauth_token_required' });
  if (response.status === 403) return json(403, { error: 'not_permitted' });
  if (response.status === 404) return json(404, { error: 'provider_not_configured' });
  if (response.status === 429) return json(429, { error: 'rate_limited' });
  const code = typeof parsed?.error === 'string' && /^[a-z_]{3,64}$/.test(parsed.error) ? parsed.error : 'provider_unavailable';
  return json(response.status >= 400 && response.status < 500 ? 400 : 502, { error: code });
}
