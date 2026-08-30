import { handleGptActionsRequest as handleCoreGptActionsRequest } from './gpt-actions.js';
import { routeForFullGptAction } from './gpt-full-actions.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function configured(env) {
  return env?.GPT_ACTIONS_ENABLED === 'true'
    && typeof env?.SUPABASE_URL === 'string'
    && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL)
    && typeof env?.SUPABASE_PUBLISHABLE_KEY === 'string'
    && env.SUPABASE_PUBLISHABLE_KEY.length >= 20;
}

function bearer(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] || null;
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_json_object');
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_json_object') throw error;
    throw new Error('invalid_json');
  }
}

function clientListRoute(request, url) {
  if (request.method.toUpperCase() !== 'GET' || url.pathname.replace(/\/+$/, '') !== '/v1/clients') return null;
  for (const key of url.searchParams.keys()) {
    if (['artist_id', 'oauth_client_id', 'integration_key', 'sql', 'rpc'].includes(key)) {
      throw new Error(`forbidden_field:${key}`);
    }
    if (key !== 'limit') throw new Error(`unexpected_field:${key}`);
  }
  const rawLimit = url.searchParams.get('limit');
  let limit = 25;
  if (rawLimit != null && rawLimit !== '') {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_field:limit');
  }
  return { rpc: 'gpt_list_clients', payload: { p_limit: limit }, responseKind: 'list' };
}

const CONTEXT_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

// The unified GPT is one OAuth application shared by every CRM human, so it
// needs one place to ask "which Artists may I act for, and which one am I on?".
//
// This is the only route that accepts an artist_id, and it accepts it as a
// selector rather than as authority: public.gpt_artist_context re-derives the
// caller's memberships from their own OAuth token before it stores or returns
// anything, and refuses an Artist they do not hold. Every other route still
// rejects artist_id outright, which is why this parser is written here instead
// of reusing the operational mapper's exactObject().
function contextRoute(request, url, body) {
  if (url.pathname.replace(/\/+$/, '') !== '/v1/context') return null;
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return null;

  for (const key of url.searchParams.keys()) {
    if (['oauth_client_id', 'integration_key', 'capability', 'provider', 'sql', 'rpc'].includes(key)) {
      throw new Error(`forbidden_field:${key}`);
    }
    throw new Error(`unexpected_field:${key}`);
  }

  if (method === 'GET') {
    return { rpc: 'gpt_artist_context', payload: { p_artist_id: null }, responseKind: 'object' };
  }

  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('invalid_json_object');
  for (const forbidden of [
    'oauth_client_id', 'integration_key', 'capability', 'provider', 'scope',
    'profile_id', 'sql', 'query', 'rpc',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, forbidden)) throw new Error(`forbidden_field:${forbidden}`);
  }
  const unexpected = Object.keys(body).filter((key) => key !== 'artist_id');
  if (unexpected.length) throw new Error(`unexpected_field:${unexpected[0]}`);

  const artistId = body.artist_id;
  if (artistId == null || artistId === '') throw new Error('required_field:artist_id');
  if (typeof artistId !== 'string' || !CONTEXT_UUID.test(artistId)) throw new Error('invalid_field:artist_id');
  return { rpc: 'gpt_artist_context', payload: { p_artist_id: artistId }, responseKind: 'object' };
}

function safeRpcError(status, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const code = typeof parsed?.code === 'string' ? parsed.code : 'upstream_error';
  const messages = {
    '40001': 'The CRM record changed since it was read. Refresh it before changing it.',
    '42501': 'This action is not permitted for the current GPT or artist scope.',
    '23503': 'A referenced CRM record was not found.',
    '23514': 'The request violates CRM validation rules.',
  };
  const message = code === '22023' && typeof parsed?.message === 'string'
    ? parsed.message.slice(0, 300)
    : messages[code] || 'The CRM action could not be completed.';
  const mapped = status === 401 ? 401
    : status === 403 || code === '42501' ? 403
      : code === '40001' ? 409
        : code === '23503' ? 404
          : status >= 400 && status < 500 ? 400
            : 502;
  return json(mapped, { error: code, message });
}

async function handleFullRequest(request, env, fetchImpl) {
  if (!configured(env)) return json(404, { error: 'not_found' });
  const token = bearer(request);
  if (!token) return json(401, { error: 'oauth_token_required' });

  const url = new URL(request.url);
  let body = {};
  try {
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) body = await readJson(request);
    const route = contextRoute(request, url, body)
      || clientListRoute(request, url)
      || routeForFullGptAction(request, url, body);
    if (!route) return null;

    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${route.rpc}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(route.payload),
      // `manual`, never the `error` redirect mode: the Workers runtime rejects
      // that mode and throws before the subrequest is dispatched. A redirect
      // arrives here as a 3xx response and is refused as a non-ok status below.
      redirect: 'manual',
    });

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      return json(502, { error: 'upstream_response_too_large' });
    }
    if (!response.ok) return safeRpcError(response.status, text);

    let parsed;
    try { parsed = text ? JSON.parse(text) : null; }
    catch { return json(502, { error: 'invalid_upstream_response' }); }

    if (route.responseKind === 'single-row') {
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return json(404, { error: route.notFoundError || 'record_not_found' });
      }
      return json(200, parsed[0]);
    }
    if (route.responseKind === 'list') return json(200, Array.isArray(parsed) ? parsed : []);
    return json(200, parsed && typeof parsed === 'object' ? parsed : {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_request';
    if (reason === 'body_too_large') return json(413, { error: reason });
    if (reason === 'unsupported_media_type') return json(415, { error: reason });
    const [kind, field] = reason.split(':', 2);
    if (['unexpected_field', 'forbidden_field', 'required_field', 'invalid_field'].includes(kind)) {
      return json(400, { error: kind, field });
    }
    if (reason === 'invalid_json' || reason === 'invalid_json_object') return json(400, { error: reason });
    return json(502, { error: 'gateway_error' });
  }
}

export async function handleGptActionsRequest(request, env, fetchImpl = fetch) {
  // Use a clone because the extension parser may inspect a request body before
  // deciding that a path belongs to the unchanged core handler.
  const extended = await handleFullRequest(request.clone(), env, fetchImpl);
  if (extended) return extended;
  return handleCoreGptActionsRequest(request, env, fetchImpl);
}

export const __testing = Object.freeze({ configured, bearer, clientListRoute, contextRoute, handleFullRequest });
