const APP_ID = '1481226093843982';
const GRAPH_VERSION = 'v25.0';
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';
const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const WEBHOOK_WORKER = 'vishar-whatsapp-webhook-production';
const DRAIN_WORKER = 'vishar-whatsapp-drain-production';
const MAX_BODY_BYTES = 8192;

const APPROVED_ARTISTS = Object.freeze({
  'a1111111-1111-4111-8111-111111111111': Object.freeze({
    slug: 'vladimir',
    integrationKey: 'vladimir-production',
    bindingName: 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION',
    wabaId: '341184815737145',
    phoneNumberId: '328102027058293',
  }),
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function boundedJson(request) {
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw Object.assign(new Error('body_too_large'), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw Object.assign(new Error('body_too_large'), { status: 413 });
  return JSON.parse(text);
}

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([^\s]{20,4096})$/.exec(value);
  return match ? match[1] : null;
}

function binding(env, name) {
  return typeof env?.[name] === 'string' ? env[name].trim() : '';
}

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

async function noFollowFetch(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw Object.assign(new Error('upstream_redirect_rejected'), { status: 502 });
  }
  return response;
}

async function requireCrmOperator(request, env) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error('crm_auth_required'), { status: 401 });
  const publishableKey = binding(env, 'SUPABASE_PUBLISHABLE_KEY');
  if (!publishableKey) throw Object.assign(new Error('server_not_configured'), { status: 503 });

  const authResponse = await noFollowFetch(`${PRODUCTION_SUPABASE_ORIGIN}/auth/v1/user`, {
    method: 'GET',
    headers: { apikey: publishableKey, authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!authResponse.ok) throw Object.assign(new Error('crm_auth_rejected'), { status: 401 });
  const user = await responseJson(authResponse);
  const userId = typeof user.id === 'string' ? user.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw Object.assign(new Error('crm_auth_rejected'), { status: 401 });

  const profileUrl = new URL(`${PRODUCTION_SUPABASE_ORIGIN}/rest/v1/profiles`);
  profileUrl.searchParams.set('id', `eq.${userId}`);
  profileUrl.searchParams.set('select', 'id,role,is_active');
  profileUrl.searchParams.set('limit', '1');
  const profileResponse = await noFollowFetch(profileUrl.toString(), {
    method: 'GET',
    headers: { apikey: publishableKey, authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!profileResponse.ok) throw Object.assign(new Error('crm_profile_check_failed'), { status: 503 });
  const profiles = await responseJson(profileResponse);
  const profile = Array.isArray(profiles) && profiles.length === 1 ? profiles[0] : null;
  if (!profile || profile.id !== userId || !['owner', 'booking_manager'].includes(profile.role) || profile.is_active !== true) {
    throw Object.assign(new Error('crm_operator_required'), { status: 403 });
  }
  return { token, userId };
}

async function requireArtistIntegrationCapability(operator, env, artistId) {
  const publishableKey = binding(env, 'SUPABASE_PUBLISHABLE_KEY');
  const url = new URL(`${PRODUCTION_SUPABASE_ORIGIN}/rest/v1/artist_memberships`);
  url.searchParams.set('profile_id', `eq.${operator.userId}`);
  url.searchParams.set('artist_id', `eq.${artistId}`);
  url.searchParams.set('select', 'profile_id,artist_id,access_level,can_manage_integrations,is_active');
  url.searchParams.set('limit', '2');
  const response = await noFollowFetch(url.toString(), {
    headers: { apikey: publishableKey, authorization: `Bearer ${operator.token}`, accept: 'application/json' },
  });
  if (!response.ok) throw Object.assign(new Error('crm_membership_check_failed'), { status: 503 });
  const rows = await responseJson(response);
  const membership = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!membership || membership.profile_id !== operator.userId || membership.artist_id !== artistId || membership.access_level === 'read_only' || membership.can_manage_integrations !== true || membership.is_active !== true) {
    throw Object.assign(new Error('crm_artist_integration_not_permitted'), { status: 403 });
  }
}

async function requireApprovedRoute(operator, env, artistId, approved) {
  const publishableKey = binding(env, 'SUPABASE_PUBLISHABLE_KEY');
  const url = new URL(`${PRODUCTION_SUPABASE_ORIGIN}/rest/v1/artist_integrations`);
  url.searchParams.set('artist_id', `eq.${artistId}`);
  url.searchParams.set('integration_type', 'eq.whatsapp');
  url.searchParams.set('select', 'artist_id,provider,integration_key,is_enabled,configuration');
  url.searchParams.set('limit', '2');
  const response = await noFollowFetch(url.toString(), {
    headers: { apikey: publishableKey, authorization: `Bearer ${operator.token}`, accept: 'application/json' },
  });
  if (!response.ok) throw Object.assign(new Error('crm_route_check_failed'), { status: 502 });
  const rows = await responseJson(response);
  const route = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const configuration = route?.configuration;
  const safeConfiguration = configuration && typeof configuration === 'object' && !Array.isArray(configuration) && Object.keys(configuration).length === 0;
  if (!route || route.artist_id !== artistId || route.provider !== 'meta_cloud_api' || route.integration_key !== approved.integrationKey || route.is_enabled !== true || !safeConfiguration) {
    throw Object.assign(new Error('crm_route_not_ready'), { status: 409 });
  }
}

async function graph(url, init = {}) {
  const response = await noFollowFetch(url, init);
  const payload = await responseJson(response);
  if (!response.ok) {
    throw Object.assign(new Error('meta_request_failed'), {
      status: 502,
      graphCode: Number.isInteger(payload?.error?.code) ? payload.error.code : null,
      graphSubcode: Number.isInteger(payload?.error?.error_subcode) ? payload.error.error_subcode : null,
      upstreamStatus: response.status,
    });
  }
  return payload;
}

async function verifyExistingTarget(accessToken, approved) {
  const wabaUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${approved.wabaId}`);
  wabaUrl.searchParams.set('fields', 'id,name');
  const waba = await graph(wabaUrl.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (String(waba.id || '') !== approved.wabaId) throw Object.assign(new Error('meta_waba_mismatch'), { status: 409 });

  const phoneUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${approved.phoneNumberId}`);
  phoneUrl.searchParams.set('fields', 'id,display_phone_number,verified_name');
  const phone = await graph(phoneUrl.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (String(phone.id || '') !== approved.phoneNumberId) throw Object.assign(new Error('meta_phone_mismatch'), { status: 409 });

  return {
    wabaName: typeof waba.name === 'string' ? waba.name : null,
    displayPhoneNumber: typeof phone.display_phone_number === 'string' ? phone.display_phone_number : null,
    verifiedName: typeof phone.verified_name === 'string' ? phone.verified_name : null,
  };
}

async function putWorkerSecret(env, worker, bindingName, envelope) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${binding(env, 'CLOUDFLARE_ACCOUNT_ID')}/workers/scripts/${worker}/secrets`;
  const response = await noFollowFetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${binding(env, 'CLOUDFLARE_WORKERS_EDIT_TOKEN')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ name: bindingName, text: envelope, type: 'secret_text' }),
  });
  const payload = await responseJson(response);
  if (!response.ok || payload.success !== true || payload?.result?.name !== bindingName) {
    throw Object.assign(new Error('cloudflare_binding_write_failed'), { status: 502 });
  }
}

async function subscribeWaba(accessToken, wabaId) {
  const payload = await graph(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (payload.success !== true) throw Object.assign(new Error('meta_waba_subscription_failed'), { status: 502 });
}

function requireServerConfiguration(env) {
  for (const name of ['META_APP_SECRET', 'SUPABASE_PUBLISHABLE_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKERS_EDIT_TOKEN']) {
    if (!binding(env, name)) throw Object.assign(new Error('server_not_configured'), { status: 503 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.origin !== PRODUCTION_CRM_ORIGIN || request.headers.get('origin') !== PRODUCTION_CRM_ORIGIN) return json({ ok: false, error: 'origin_not_allowed' }, 403);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json({ ok: false, error: 'json_required' }, 415);

  let stage = 'server_configuration';
  try {
    requireServerConfiguration(env);
    stage = 'crm_operator';
    const operator = await requireCrmOperator(request, env);
    stage = 'request_parse';
    const body = await boundedJson(request);
    const artistId = typeof body?.artist_id === 'string' ? body.artist_id : '';
    const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
    const approved = APPROVED_ARTISTS[artistId];
    if (!approved) return json({ ok: false, error: 'artist_scope_not_allowed' }, 403);
    if (accessToken.length < 40 || accessToken.length > 4096 || /\s/.test(accessToken)) return json({ ok: false, error: 'invalid_meta_access_token' }, 400);

    stage = 'artist_membership';
    await requireArtistIntegrationCapability(operator, env, artistId);
    stage = 'route_check';
    await requireApprovedRoute(operator, env, artistId, approved);
    stage = 'meta_selection';
    const safeMeta = await verifyExistingTarget(accessToken, approved);

    const envelope = JSON.stringify({
      phoneNumberId: approved.phoneNumberId,
      accessToken,
      wabaId: approved.wabaId,
      appSecret: binding(env, 'META_APP_SECRET'),
    });
    stage = 'drain_binding';
    await putWorkerSecret(env, DRAIN_WORKER, approved.bindingName, envelope);
    stage = 'webhook_binding';
    await putWorkerSecret(env, WEBHOOK_WORKER, approved.bindingName, envelope);
    stage = 'waba_subscription';
    await subscribeWaba(accessToken, approved.wabaId);

    return json({
      ok: true,
      integration_key: approved.integrationKey,
      waba_name: safeMeta.wabaName,
      display_phone_number: safeMeta.displayPhoneNumber,
      verified_name: safeMeta.verifiedName,
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const safeError = typeof error?.message === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
      ? error.message
      : `provisioning_failed_${stage}`;
    const body = { ok: false, error: safeError };
    if (safeError === 'meta_request_failed') {
      body.graph_code = Number.isInteger(error?.graphCode) ? error.graphCode : null;
      body.graph_subcode = Number.isInteger(error?.graphSubcode) ? error.graphSubcode : null;
      body.upstream_status = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : null;
    }
    return json(body, status >= 500 ? 500 : status);
  }
}

export function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

export const __testing = { APPROVED_ARTISTS };
