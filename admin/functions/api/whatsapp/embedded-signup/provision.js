const APP_ID = '1481226093843982';
const GRAPH_VERSION = 'v25.0';
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';
const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const VLADIMIR_ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const INTEGRATION_KEY = 'vladimir-production';
const BINDING_NAME = 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION';
const WEBHOOK_WORKER = 'vishar-whatsapp-webhook-production';
const DRAIN_WORKER = 'vishar-whatsapp-drain-production';
const MAX_BODY_BYTES = 4096;
const PROVIDER_ID = /^[0-9]{5,32}$/;

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
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  return JSON.parse(text);
}

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([^\s]{20,4096})$/.exec(value);
  return match ? match[1] : null;
}

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

async function requireOwner(request, env) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error('crm_auth_required'), { status: 401 });
  if (!env.SUPABASE_PUBLISHABLE_KEY) throw Object.assign(new Error('server_not_configured'), { status: 503 });

  const authResponse = await fetch(`${PRODUCTION_SUPABASE_ORIGIN}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    redirect: 'error',
  });
  if (!authResponse.ok) throw Object.assign(new Error('crm_auth_rejected'), { status: 401 });
  const user = await responseJson(authResponse);
  const userId = typeof user.id === 'string' ? user.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw Object.assign(new Error('crm_auth_rejected'), { status: 401 });

  const profileUrl = new URL(`${PRODUCTION_SUPABASE_ORIGIN}/rest/v1/profiles`);
  profileUrl.searchParams.set('id', `eq.${userId}`);
  profileUrl.searchParams.set('select', 'id,role,is_active');
  profileUrl.searchParams.set('limit', '1');
  const profileResponse = await fetch(profileUrl.toString(), {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    redirect: 'error',
  });
  if (!profileResponse.ok) throw Object.assign(new Error('crm_owner_check_failed'), { status: 403 });
  const profiles = await responseJson(profileResponse);
  const profile = Array.isArray(profiles) && profiles.length === 1 ? profiles[0] : null;
  if (!profile || profile.id !== userId || profile.role !== 'owner' || profile.is_active !== true) {
    throw Object.assign(new Error('crm_owner_required'), { status: 403 });
  }
  return userId;
}

async function graph(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'error' });
  const payload = await responseJson(response);
  if (!response.ok) {
    const graphCode = Number.isInteger(payload?.error?.code) ? payload.error.code : null;
    throw Object.assign(new Error('meta_request_failed'), {
      status: 502,
      graphCode,
      upstreamStatus: response.status,
    });
  }
  return payload;
}

async function exchangeCode(code, appSecret) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', APP_ID);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);
  const payload = await graph(url.toString(), { method: 'GET' });
  const token = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!token) throw Object.assign(new Error('meta_token_exchange_failed'), { status: 502 });
  return token;
}

async function verifyMetaSelection(accessToken, wabaId, requestedPhoneNumberId) {
  const wabaUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}`);
  wabaUrl.searchParams.set('fields', 'id,name');
  const waba = await graph(wabaUrl.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (String(waba.id || '') !== wabaId) throw Object.assign(new Error('meta_waba_mismatch'), { status: 409 });

  const phonesUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/phone_numbers`);
  phonesUrl.searchParams.set('fields', 'id,display_phone_number,verified_name');
  const phones = await graph(phonesUrl.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const available = Array.isArray(phones.data)
    ? phones.data.filter((item) => PROVIDER_ID.test(String(item?.id || '')))
    : [];

  let selected = null;
  if (requestedPhoneNumberId) {
    selected = available.find((item) => String(item.id) === requestedPhoneNumberId) || null;
    if (!selected) throw Object.assign(new Error('meta_phone_not_in_waba'), { status: 409 });
  } else {
    if (available.length === 0) throw Object.assign(new Error('meta_phone_not_found'), { status: 409 });
    if (available.length !== 1) throw Object.assign(new Error('meta_phone_selection_ambiguous'), { status: 409 });
    [selected] = available;
  }

  return {
    phoneNumberId: String(selected.id),
    wabaName: typeof waba.name === 'string' ? waba.name : null,
    displayPhoneNumber: typeof selected.display_phone_number === 'string' ? selected.display_phone_number : null,
    verifiedName: typeof selected.verified_name === 'string' ? selected.verified_name : null,
  };
}

async function putWorkerSecret(env, worker, envelope) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/secrets`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_WORKERS_EDIT_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ name: BINDING_NAME, text: envelope, type: 'secret_text' }),
    redirect: 'error',
  });
  const payload = await responseJson(response);
  if (!response.ok || payload.success !== true || payload?.result?.name !== BINDING_NAME) {
    throw Object.assign(new Error('cloudflare_binding_write_failed'), { status: 502 });
  }
}

async function subscribeWaba(accessToken, wabaId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`;
  const payload = await graph(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (payload.success !== true) throw Object.assign(new Error('meta_waba_subscription_failed'), { status: 502 });
}

function requireServerConfiguration(env) {
  for (const name of [
    'META_APP_SECRET',
    'SUPABASE_PUBLISHABLE_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_WORKERS_EDIT_TOKEN',
  ]) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      throw Object.assign(new Error('server_not_configured'), { status: 503 });
    }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.origin !== PRODUCTION_CRM_ORIGIN || request.headers.get('origin') !== PRODUCTION_CRM_ORIGIN) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403);
  }
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'json_required' }, 415);
  }

  try {
    requireServerConfiguration(env);
    await requireOwner(request, env);

    const body = await boundedJson(request);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const artistId = typeof body?.artist_id === 'string' ? body.artist_id : '';
    const integrationKey = typeof body?.integration_key === 'string' ? body.integration_key : '';
    const wabaId = typeof body?.session?.waba_id === 'string' ? body.session.waba_id.trim() : '';
    const phoneNumberId = typeof body?.session?.phone_number_id === 'string' ? body.session.phone_number_id.trim() : '';

    if (artistId !== VLADIMIR_ARTIST_ID || integrationKey !== INTEGRATION_KEY) {
      return json({ ok: false, error: 'artist_scope_not_allowed' }, 403);
    }
    if (
      code.length < 10
      || code.length > 2048
      || !PROVIDER_ID.test(wabaId)
      || (phoneNumberId && !PROVIDER_ID.test(phoneNumberId))
    ) {
      return json({ ok: false, error: 'invalid_signup_session' }, 400);
    }

    const accessToken = await exchangeCode(code, env.META_APP_SECRET);
    const safeMeta = await verifyMetaSelection(accessToken, wabaId, phoneNumberId || null);
    const envelope = JSON.stringify({
      phoneNumberId: safeMeta.phoneNumberId,
      accessToken,
      wabaId,
      appSecret: env.META_APP_SECRET,
    });

    // Both exact production Workers receive the same Vladimir-owned encrypted
    // envelope before the Meta WABA subscription is activated. No secret value
    // is returned, logged or persisted in Supabase.
    await putWorkerSecret(env, WEBHOOK_WORKER, envelope);
    await putWorkerSecret(env, DRAIN_WORKER, envelope);
    await subscribeWaba(accessToken, wabaId);

    return json({
      ok: true,
      integration_key: INTEGRATION_KEY,
      waba_name: safeMeta.wabaName,
      display_phone_number: safeMeta.displayPhoneNumber,
      verified_name: safeMeta.verifiedName,
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const safeError = typeof error?.message === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.message)
      ? error.message
      : 'provisioning_failed';
    const body = { ok: false, error: safeError };
    if (safeError === 'meta_request_failed') {
      body.graph_code = Number.isInteger(error?.graphCode) ? error.graphCode : null;
      body.upstream_status = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : null;
    }
    return json(body, status >= 400 && status <= 599 ? status : 500);
  }
}

export function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

export const __testing = {
  bearerToken,
  requireServerConfiguration,
};
