const MAX_BODY_BYTES = 640 * 1024;
const MAX_GATEWAY_BYTES = 768 * 1024;
const MAX_WORKER_SOURCE_BYTES = 512 * 1024;

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

const ROUTES = Object.freeze({
  '/v1/cloudflare/account': { method: 'GET', access: 'read', internal: '/internal/cloudflare/account', allowed: [], required: [] },
  '/v1/cloudflare/zones': { method: 'GET', access: 'read', internal: '/internal/cloudflare/zones', allowed: [], required: [] },
  '/v1/cloudflare/workers': { method: 'GET', access: 'read', internal: '/internal/cloudflare/workers', allowed: [], required: [] },
  '/v1/cloudflare/worker': { method: 'POST', access: 'read', internal: '/internal/cloudflare/worker', allowed: ['script_name'], required: ['script_name'] },
  '/v1/cloudflare/worker/deployments': { method: 'POST', access: 'read', internal: '/internal/cloudflare/worker/deployments', allowed: ['script_name'], required: ['script_name'] },
  '/v1/cloudflare/pages': { method: 'GET', access: 'read', internal: '/internal/cloudflare/pages', allowed: [], required: [] },
  '/v1/cloudflare/d1': { method: 'GET', access: 'read', internal: '/internal/cloudflare/d1', allowed: [], required: [] },
  '/v1/cloudflare/kv': { method: 'GET', access: 'read', internal: '/internal/cloudflare/kv', allowed: [], required: [] },
  '/v1/cloudflare/r2': { method: 'GET', access: 'read', internal: '/internal/cloudflare/r2', allowed: [], required: [] },
  '/v1/cloudflare/dns/list': { method: 'POST', access: 'read', internal: '/internal/cloudflare/dns/list', allowed: ['zone'], required: ['zone'] },
  '/v1/cloudflare/routes/list': { method: 'POST', access: 'read', internal: '/internal/cloudflare/routes/list', allowed: ['zone'], required: ['zone'] },
  '/v1/cloudflare/worker/deploy': { method: 'POST', access: 'write', internal: '/internal/cloudflare/worker/deploy', allowed: ['script_name', 'code'], required: ['script_name', 'code'] },
  '/v1/cloudflare/worker/delete': { method: 'POST', access: 'write', internal: '/internal/cloudflare/worker/delete', allowed: ['script_name', 'confirm'], required: ['script_name', 'confirm'] },
  '/v1/cloudflare/dns/upsert': { method: 'POST', access: 'write', internal: '/internal/cloudflare/dns/upsert', allowed: ['zone', 'record_id', 'type', 'name', 'content', 'ttl', 'proxied', 'priority', 'comment'], required: ['zone', 'type', 'name', 'content'] },
  '/v1/cloudflare/dns/delete': { method: 'POST', access: 'write', internal: '/internal/cloudflare/dns/delete', allowed: ['zone', 'record_id', 'confirm'], required: ['zone', 'record_id', 'confirm'] },
  '/v1/cloudflare/cache/purge': { method: 'POST', access: 'write', internal: '/internal/cloudflare/cache/purge', allowed: ['zone', 'urls', 'purge_everything'], required: ['zone'] },
  '/v1/cloudflare/routes/upsert': { method: 'POST', access: 'write', internal: '/internal/cloudflare/routes/upsert', allowed: ['zone', 'route_id', 'pattern', 'script_name'], required: ['zone', 'pattern', 'script_name'] },
  '/v1/cloudflare/routes/delete': { method: 'POST', access: 'write', internal: '/internal/cloudflare/routes/delete', allowed: ['zone', 'route_id', 'confirm'], required: ['zone', 'route_id', 'confirm'] },
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

function enabled(env, access) {
  if (env?.CLOUDFLARE_CONTROL_ENABLED !== 'true') return false;
  if (access === 'read') return env?.CLOUDFLARE_CONTROL_READ_ENABLED === 'true';
  if (access === 'write') return env?.CLOUDFLARE_CONTROL_WRITE_ENABLED === 'true';
  return false;
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
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('invalid_json'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_json_object');
  return parsed;
}

function exactObject(body, allowed, required) {
  for (const forbidden of [
    'artist_id', 'oauth_client_id', 'integration_key', 'provider', 'capability', 'profile_id',
    'account_id', 'zone_id', 'api_token', 'access_token', 'authorization', 'secret', 'secret_value',
    'upstream', 'url_path', 'method', 'headers', 'sql', 'rpc',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, forbidden)) throw new Error(`forbidden_field:${forbidden}`);
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new Error(`unexpected_field:${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) throw new Error(`required_field:${key}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'code')) {
    if (typeof body.code !== 'string' || !body.code.trim()
      || new TextEncoder().encode(body.code).byteLength > MAX_WORKER_SOURCE_BYTES) {
      throw new Error('invalid_field:code');
    }
  }
}

function safeAuthError(status, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const code = typeof parsed?.code === 'string' ? parsed.code : 'upstream_error';
  if (status === 401) return json(401, { error: 'oauth_token_invalid' });
  if (status === 403 || code === '42501') return json(403, { error: 'cloudflare_control_not_permitted' });
  if (code === '22023') return json(400, { error: 'invalid_context' });
  return json(502, { error: 'authorization_gateway_error' });
}

async function authorize(env, token, fetchImpl) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/gpt_authorize_cloudflare_control`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: '{}',
    redirect: 'manual',
  });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 128 * 1024) {
    return { error: json(502, { error: 'authorization_response_too_large' }) };
  }
  if (!response.ok) return { error: safeAuthError(response.status, text) };
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { return { error: json(502, { error: 'invalid_authorization_response' }) }; }
  if (!parsed || parsed.allowed !== true) return { error: json(502, { error: 'invalid_authorization_response' }) };
  return { allowed: true };
}

async function readGatewayResponse(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_GATEWAY_BYTES) {
    return json(502, { error: 'cloudflare_gateway_response_too_large' });
  }
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { return json(502, { error: 'invalid_cloudflare_gateway_response' }); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return json(502, { error: 'invalid_cloudflare_gateway_response' });
  }
  return json(response.status, parsed);
}

async function callGateway(route, body, env) {
  if (!env?.CLOUDFLARE_GATEWAY || typeof env.CLOUDFLARE_GATEWAY.fetch !== 'function') {
    return json(503, { error: 'cloudflare_gateway_unavailable' });
  }
  const headers = new Headers({ accept: 'application/json' });
  const init = { method: route.method, headers };
  if (route.method !== 'GET') {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await env.CLOUDFLARE_GATEWAY.fetch(`https://cloudflare-gateway.internal${route.internal}`, init);
  } catch {
    return json(502, { error: 'cloudflare_gateway_transport_error' });
  }
  return readGatewayResponse(response);
}

export async function handleGptCloudflareControlRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const route = ROUTES[path];
  if (!route) return null;
  if (!configured(env) || !enabled(env, route.access)) return json(404, { error: 'not_found' });

  const token = bearer(request);
  if (!token) return json(401, { error: 'oauth_token_required' });

  try {
    if (request.method.toUpperCase() !== route.method) return json(405, { error: 'method_not_allowed' });
    if ([...url.searchParams.keys()].length) throw new Error(`unexpected_field:${[...url.searchParams.keys()][0]}`);
    const body = route.method === 'GET' ? {} : await readJson(request);
    exactObject(body, route.allowed, route.required);

    const authorization = await authorize(env, token, fetchImpl);
    if (authorization.error) return authorization.error;
    return callGateway(route, body, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_request';
    if (reason === 'body_too_large') return json(413, { error: reason });
    if (reason === 'unsupported_media_type') return json(415, { error: reason });
    const [kind, field] = reason.split(':', 2);
    if (['unexpected_field', 'forbidden_field', 'required_field', 'invalid_field'].includes(kind)) {
      return json(400, { error: kind, field });
    }
    if (reason === 'invalid_json' || reason === 'invalid_json_object') return json(400, { error: reason });
    return json(502, { error: 'cloudflare_control_gateway_error' });
  }
}

export const __testing = Object.freeze({
  ROUTES, configured, enabled, bearer, readJson, exactObject, authorize, callGateway, readGatewayResponse,
});
