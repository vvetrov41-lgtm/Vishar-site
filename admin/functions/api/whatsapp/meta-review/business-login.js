// OAuth App Review probe for business_management. No CRM database writes,
// WhatsApp provisioning, Worker bindings, token persistence or phone operations.
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';
const OPERATOR_CRM_ORIGIN = 'https://app.vishartattoo.com';
const SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const APP_ID = '1481226093843982';
const GRAPH_VERSION = 'v25.0';
const REDIRECT_URI = 'https://app.vishartattoo.com/?meta_business_review=1';
const LIVE_BUSINESS_ID = '692776505711216';
const CONFIG_ID_PATTERN = /^[1-9][0-9]{8,24}$/;
const BUSINESS_ID_PATTERN = /^[1-9][0-9]{5,30}$/;
const CODE_PATTERN = /^[\x21-\x7e]{10,2048}$/;

function binding(env, key) {
  return typeof env?.[key] === 'string' ? env[key].trim() : '';
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-vishar-review-handler': 'business-login-v1',
    'cache-control': 'private, no-store, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  } });
}
function reject(message, status) {
  return Object.assign(new Error(message), { status });
}
async function checkedFetch(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw reject('upstream_redirect_rejected', 424);
  return response;
}
async function jsonResponse(response) { return response.json().catch(() => ({})); }
function authHeader(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([^\s]{20,4096})$/.exec(value);
  return match ? match[1] : null;
}
async function requireOwner(request, env) {
  const token = authHeader(request);
  if (!token) throw reject('crm_auth_required', 401);
  const key = binding(env, 'SUPABASE_PUBLISHABLE_KEY');
  if (!key) throw reject('server_not_configured', 503);
  const headers = { apikey: key, authorization: `Bearer ${token}`, accept: 'application/json' };
  const userResponse = await checkedFetch(`${SUPABASE_ORIGIN}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw reject('crm_auth_rejected', 401);
  const user = await jsonResponse(userResponse);
  const userId = typeof user?.id === 'string' ? user.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw reject('crm_auth_rejected', 401);
  const url = new URL(`${SUPABASE_ORIGIN}/rest/v1/profiles`);
  url.searchParams.set('id', `eq.${userId}`);
  url.searchParams.set('select', 'id,role,is_active');
  url.searchParams.set('limit', '1');
  const profileResponse = await checkedFetch(url.toString(), { headers });
  if (!profileResponse.ok) throw reject('crm_profile_check_failed', 503);
  const rows = await jsonResponse(profileResponse);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== userId
    || rows[0]?.role !== 'owner' || rows[0]?.is_active !== true) {
    throw reject('crm_owner_required', 403);
  }
}
function reviewConfig(env) {
  const configId = binding(env, 'META_REVIEW_BUSINESS_CONFIG_ID');
  const businessId = binding(env, 'META_REVIEW_BUSINESS_ID');
  const appSecret = binding(env, 'META_APP_SECRET');
  if (binding(env, 'META_REVIEW_BUSINESS_LOGIN_ENABLED') !== 'true'
    || !CONFIG_ID_PATTERN.test(configId)
    || !BUSINESS_ID_PATTERN.test(businessId)
    || businessId === LIVE_BUSINESS_ID
    || appSecret.length < 16 || appSecret.length > 512 || /\s/.test(appSecret)) {
    throw reject('meta_review_business_login_disabled', 404);
  }
  return { configId, businessId, appSecret };
}
async function graph(url, token, init = {}) {
  const response = await checkedFetch(url, {
    ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers || {}) },
  });
  const payload = await jsonResponse(response);
  if (!response.ok) {
    const error = reject('meta_review_graph_failed', 424);
    error.graph_code = Number.isInteger(payload?.error?.code) ? payload.error.code : null;
    error.graph_subcode = Number.isInteger(payload?.error?.error_subcode) ? payload.error.error_subcode : null;
    return Promise.reject(error);
  }
  return payload;
}
async function exchangeCode(code, config) {
  const form = new URLSearchParams({
    client_id: APP_ID,
    client_secret: config.appSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const response = await checkedFetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
  const payload = await jsonResponse(response);
  if (!response.ok || typeof payload?.access_token !== 'string'
    || payload.access_token.length < 20 || payload.access_token.length > 4096) {
    throw reject('meta_review_code_exchange_failed', 424);
  }
  return payload.access_token; // In-memory, never sent to browser or stored.
}
async function readGrantedBusiness(token, expectedBusinessId) {
  const permissions = await graph(`https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?fields=permission,status&limit=100`, token);
  if (!Array.isArray(permissions?.data)
    || !permissions.data.some(row => row?.permission === 'business_management' && row?.status === 'granted')) {
    throw reject('meta_business_management_not_granted', 409);
  }
  const businesses = await graph(`https://graph.facebook.com/${GRAPH_VERSION}/me/businesses?fields=id,name&limit=100`, token);
  const items = Array.isArray(businesses?.data) ? businesses.data : [];
  const matches = items.filter(row => String(row?.id) === expectedBusinessId);
  if (matches.length !== 1) throw reject('meta_review_business_not_selected', 409);
  return { business_id: expectedBusinessId,
    business_name: typeof matches[0].name === 'string' ? matches[0].name.slice(0, 100) : null,
    permission: 'business_management' };
}
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const operator = url.origin === PRODUCTION_CRM_ORIGIN
    && request.headers.get('origin') === OPERATOR_CRM_ORIGIN;
  if (request.method === 'OPTIONS') {
    if (!operator) return json({ ok: false, error: 'origin_not_allowed' }, 403);
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': OPERATOR_CRM_ORIGIN,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '300',
      vary: 'Origin',
    } });
  }
  if (!operator) return json({ ok: false, error: 'origin_not_allowed' }, 403);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  let response;
  try {
    const config = reviewConfig(env);
    await requireOwner(request, env);
    if (request.method === 'GET') {
      response = json({ ok: true, config_id: config.configId });
    } else {
      if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        throw reject('json_required', 415);
      }
      if (Number(request.headers.get('content-length') || 0) > 4096) throw reject('body_too_large', 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 4096) throw reject('body_too_large', 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw reject('invalid_json', 400); }
      if (typeof body?.code !== 'string' || !CODE_PATTERN.test(body.code)) throw reject('invalid_oauth_code', 400);
      const token = await exchangeCode(body.code, config);
      const business = await readGrantedBusiness(token, config.businessId);
      response = json({ ok: true, ...business });
    }
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    response = json({ ok: false, error: typeof error?.message === 'string' ? error.message : 'meta_review_failed',
      ...(Number.isInteger(error?.graph_code) ? { graph_code: error.graph_code } : {}),
      ...(Number.isInteger(error?.graph_subcode) ? { graph_subcode: error.graph_subcode } : {}) }, status);
  }
  response.headers.set('access-control-allow-origin', OPERATOR_CRM_ORIGIN);
  response.headers.set('access-control-expose-headers', 'x-vishar-review-handler');
  response.headers.set('vary', 'Origin');
  return response;
}
