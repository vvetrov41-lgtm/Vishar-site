const GRAPH_VERSION = 'v25.0';
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';
const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const TEMPLATE_NAME = 'meta_review_permission_demo';
const TEMPLATE_LANGUAGE = 'en_US';
const TEMPLATE_CATEGORY = 'UTILITY';
const TEMPLATE_BODY = 'Meta App Review permission demonstration. No customer data is used.';
const MAX_BODY_BYTES = 2048;

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

function binding(env, name) {
  return typeof env?.[name] === 'string' ? env[name].trim() : '';
}

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([^\s]{20,4096})$/.exec(value);
  return match ? match[1] : null;
}

async function boundedJson(request) {
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('body_too_large'), { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('body_too_large'), { status: 413 });
  }
  return JSON.parse(text);
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

async function requireOwner(request, env) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error('crm_auth_required'), { status: 401 });
  const publishableKey = binding(env, 'SUPABASE_PUBLISHABLE_KEY');
  if (!publishableKey) throw Object.assign(new Error('server_not_configured'), { status: 500 });

  const authResponse = await noFollowFetch(`${PRODUCTION_SUPABASE_ORIGIN}/auth/v1/user`, {
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
    headers: { apikey: publishableKey, authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!profileResponse.ok) throw Object.assign(new Error('crm_profile_check_failed'), { status: 503 });
  const profiles = await responseJson(profileResponse);
  const profile = Array.isArray(profiles) && profiles.length === 1 ? profiles[0] : null;
  if (!profile || profile.id !== userId || profile.role !== 'owner' || profile.is_active !== true) {
    throw Object.assign(new Error('crm_owner_required'), { status: 403 });
  }
}

function requireReviewConfiguration(env) {
  if (binding(env, 'META_REVIEW_TEMPLATE_ENABLED') !== 'true') {
    throw Object.assign(new Error('meta_review_disabled'), { status: 404 });
  }
  const wabaId = binding(env, 'META_REVIEW_WABA_ID');
  const accessToken = binding(env, 'META_REVIEW_ACCESS_TOKEN');
  if (!/^[1-9][0-9]{5,30}$/.test(wabaId) || accessToken.length < 40 || accessToken.length > 4096 || /\s/.test(accessToken)) {
    throw Object.assign(new Error('server_not_configured'), { status: 500 });
  }
  return { wabaId, accessToken };
}

async function graph(url, accessToken, init = {}) {
  const response = await noFollowFetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });
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

async function listReviewTemplates(config) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`);
  url.searchParams.set('fields', 'id,name,status,language,category');
  url.searchParams.set('limit', '100');
  const payload = await graph(url.toString(), config.accessToken);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter((row) => row && row.name === TEMPLATE_NAME);
}

function safeTemplate(row) {
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    name: TEMPLATE_NAME,
    status: typeof row?.status === 'string' ? row.status : null,
    language: typeof row?.language === 'string' ? row.language : TEMPLATE_LANGUAGE,
    category: typeof row?.category === 'string' ? row.category : TEMPLATE_CATEGORY,
  };
}

async function createReviewTemplate(config) {
  const before = await listReviewTemplates(config);
  if (before.length !== 0) throw Object.assign(new Error('meta_review_template_exists'), { status: 409 });

  const payload = await graph(
    `https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`,
    config.accessToken,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: TEMPLATE_NAME,
        language: TEMPLATE_LANGUAGE,
        category: TEMPLATE_CATEGORY,
        components: [{ type: 'BODY', text: TEMPLATE_BODY }],
      }),
    },
  );
  if (typeof payload?.id !== 'string' || !payload.id) {
    throw Object.assign(new Error('meta_review_create_readback_failed'), { status: 502 });
  }

  const after = await listReviewTemplates(config);
  const row = after.find((entry) => String(entry?.id || '') === payload.id) || null;
  if (!row) throw Object.assign(new Error('meta_review_create_readback_failed'), { status: 502 });
  return safeTemplate(row);
}

async function deleteReviewTemplate(config) {
  const before = await listReviewTemplates(config);
  if (before.length === 0) return { deleted: false };
  if (before.length !== 1) throw Object.assign(new Error('meta_review_template_ambiguous'), { status: 409 });

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`);
  url.searchParams.set('name', TEMPLATE_NAME);
  const payload = await graph(url.toString(), config.accessToken, { method: 'DELETE' });
  if (payload?.success !== true) throw Object.assign(new Error('meta_review_delete_failed'), { status: 502 });

  const after = await listReviewTemplates(config);
  if (after.length !== 0) throw Object.assign(new Error('meta_review_delete_readback_failed'), { status: 502 });
  return { deleted: true };
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

  let stage = 'review_gate';
  try {
    const config = requireReviewConfiguration(env);
    stage = 'crm_owner';
    await requireOwner(request, env);
    stage = 'request_parse';
    const body = await boundedJson(request);
    const action = body?.action;
    if (action !== 'create' && action !== 'delete' && action !== 'status') {
      return json({ ok: false, error: 'action_not_allowed' }, 400);
    }

    stage = `meta_${action}`;
    if (action === 'create') {
      const template = await createReviewTemplate(config);
      return json({ ok: true, action, template });
    }
    if (action === 'delete') {
      const result = await deleteReviewTemplate(config);
      return json({ ok: true, action, ...result });
    }
    const rows = await listReviewTemplates(config);
    if (rows.length > 1) throw Object.assign(new Error('meta_review_template_ambiguous'), { status: 409 });
    return json({ ok: true, action, template: rows.length === 1 ? safeTemplate(rows[0]) : null });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const body = {
      ok: false,
      error: typeof error?.message === 'string' ? error.message : 'meta_review_failed',
      stage,
    };
    if (error?.message === 'meta_request_failed') {
      if (Number.isInteger(error.graphCode)) body.graph_code = error.graphCode;
      if (Number.isInteger(error.graphSubcode)) body.graph_subcode = error.graphSubcode;
      if (Number.isInteger(error.upstreamStatus)) body.upstream_status = error.upstreamStatus;
    }
    return json(body, status);
  }
}

export const __testing = Object.freeze({
  TEMPLATE_NAME,
  TEMPLATE_LANGUAGE,
  TEMPLATE_CATEGORY,
  TEMPLATE_BODY,
  listReviewTemplates,
  safeTemplate,
});
