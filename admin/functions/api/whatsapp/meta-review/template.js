const GRAPH_VERSION = 'v25.0';
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';
const OPERATOR_CRM_ORIGIN = 'https://app.vishartattoo.com';
const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const REVIEW_BUSINESS_ID = '692776505711216';
// Meta blocks new en_US content under a deleted template name for 4 weeks
// (graph_code 100, subcodes 2388025 and 2388023). A fixed name therefore broke
// the review flow after every Delete, so each create uses a server-generated
// name: the fixed prefix plus a UTC timestamp. Clients never choose the name.
const TEMPLATE_NAME_PREFIX = 'meta_review_permission_demo_';
const TEMPLATE_NAME_PATTERN = /^meta_review_permission_demo_[0-9]{14}$/;
const TEMPLATE_LANGUAGE = 'en_US';
const TEMPLATE_CATEGORY = 'MARKETING';
const TEMPLATE_BODY = 'Meta App Review permission demonstration. No customer data is used.';
// The messaging demo must never select a real artist WABA, even if misconfigured.
const LIVE_WABA_IDS = new Set(['341184815737145', '462106700328578']);
const TEST_RECIPIENT = /^[1-9][0-9]{7,14}$/;
const MAX_BODY_BYTES = 2048;
// Upstream (Meta/Supabase) failures must not use 502/504: Cloudflare replaces an
// origin 502/504 with its own branded HTML page, which hides stage and graph_code.
const UPSTREAM_FAILURE_STATUS = 424;
const GRAPH_MESSAGE_MAX_CHARS = 240;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-vishar-review-handler': 'template-v1',
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
    throw Object.assign(new Error('upstream_redirect_rejected'), { status: UPSTREAM_FAILURE_STATUS });
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
  if (LIVE_WABA_IDS.has(wabaId)) {
    throw Object.assign(new Error('live_waba_forbidden'), { status: 403 });
  }
  if (!/^[1-9][0-9]{5,30}$/.test(wabaId) || accessToken.length < 40 || accessToken.length > 4096 || /\s/.test(accessToken)) {
    throw Object.assign(new Error('server_not_configured'), { status: 500 });
  }
  return { wabaId, accessToken };
}

function safeGraphMessage(error) {
  const raw = typeof error?.error_user_msg === 'string' && error.error_user_msg
    ? error.error_user_msg
    : (typeof error?.message === 'string' ? error.message : '');
  if (!raw) return null;
  return raw
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, GRAPH_MESSAGE_MAX_CHARS);
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
      status: UPSTREAM_FAILURE_STATUS,
      graphCode: Number.isInteger(payload?.error?.code) ? payload.error.code : null,
      graphSubcode: Number.isInteger(payload?.error?.error_subcode) ? payload.error.error_subcode : null,
      upstreamStatus: response.status,
      graphMessage: safeGraphMessage(payload?.error),
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
  return rows.filter((row) => row && typeof row.name === 'string' && TEMPLATE_NAME_PATTERN.test(row.name));
}

// business_management evidence: read only the WABA fixed by server configuration.
// Never expose other business assets returned by the Graph edge to the browser.
async function readReviewBusiness(config) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${REVIEW_BUSINESS_ID}/owned_whatsapp_business_accounts`);
  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('limit', '100');
  const payload = await graph(url.toString(), config.accessToken);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const matches = rows.filter((row) => row && String(row.id) === config.wabaId);
  if (matches.length !== 1) {
    throw Object.assign(new Error('review_waba_not_owned_by_business'), { status: 409 });
  }
  return { business_id: REVIEW_BUSINESS_ID, waba_id: config.wabaId,
    waba_name: typeof matches[0].name === 'string' ? matches[0].name.slice(0, 100) : null };
}

function generateTemplateName(now = new Date()) {
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const name = `${TEMPLATE_NAME_PREFIX}${stamp}`;
  if (!TEMPLATE_NAME_PATTERN.test(name)) throw Object.assign(new Error('template_name_invalid'), { status: 500 });
  return name;
}

function safeTemplate(row) {
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    name: typeof row?.name === 'string' && TEMPLATE_NAME_PATTERN.test(row.name) ? row.name : null,
    status: typeof row?.status === 'string' ? row.status : null,
    language: typeof row?.language === 'string' ? row.language : TEMPLATE_LANGUAGE,
    category: typeof row?.category === 'string' ? row.category : TEMPLATE_CATEGORY,
  };
}

async function createReviewTemplate(config) {
  const before = await listReviewTemplates(config);
  if (before.length !== 0) throw Object.assign(new Error('meta_review_template_exists'), { status: 409 });
  const name = generateTemplateName();

  const payload = await graph(
    `https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`,
    config.accessToken,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        language: TEMPLATE_LANGUAGE,
        category: TEMPLATE_CATEGORY,
        components: [{ type: 'BODY', text: TEMPLATE_BODY }],
      }),
    },
  );
  if (typeof payload?.id !== 'string' || !payload.id) {
    throw Object.assign(new Error('meta_review_create_readback_failed'), { status: UPSTREAM_FAILURE_STATUS });
  }

  const after = await listReviewTemplates(config);
  const row = after.find((entry) => String(entry?.id || '') === payload.id) || null;
  if (!row) throw Object.assign(new Error('meta_review_create_readback_failed'), { status: UPSTREAM_FAILURE_STATUS });
  return safeTemplate(row);
}

async function deleteReviewTemplate(config) {
  const before = await listReviewTemplates(config);
  if (before.length === 0) return { deleted: false };
  if (before.length !== 1) throw Object.assign(new Error('meta_review_template_ambiguous'), { status: 409 });

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/message_templates`);
  const target = before[0];
  if (typeof target?.id !== 'string' || !/^[0-9]{1,30}$/.test(target.id)) {
    throw Object.assign(new Error('meta_review_template_ambiguous'), { status: 409 });
  }
  url.searchParams.set('name', target.name);
  url.searchParams.set('hsm_id', target.id);
  const payload = await graph(url.toString(), config.accessToken, { method: 'DELETE' });
  if (payload?.success !== true) throw Object.assign(new Error('meta_review_delete_failed'), { status: UPSTREAM_FAILURE_STATUS });

  const after = await listReviewTemplates(config);
  if (after.length !== 0) throw Object.assign(new Error('meta_review_delete_readback_failed'), { status: UPSTREAM_FAILURE_STATUS });
  return { deleted: true };
}

async function sendReviewMessage(config, env, body) {
  if (binding(env, 'META_REVIEW_SEND_ENABLED') !== 'true') {
    throw Object.assign(new Error('meta_review_send_disabled'), { status: 404 });
  }
  // A test recipient must be entered explicitly. The Meta test number itself
  // additionally restricts delivery to registered test recipients.
  const to = typeof body?.recipient === 'string' ? body.recipient.replace(/^\+/, '') : '';
  if (!TEST_RECIPIENT.test(to) || body.recipient !== to && body.recipient !== `+${to}`) {
    throw Object.assign(new Error('invalid_test_recipient'), { status: 400 });
  }
  const name = body?.template_name;
  if (typeof name !== 'string' || !TEMPLATE_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('invalid_review_template'), { status: 400 });
  }
  const rows = await listReviewTemplates(config);
  if (rows.length !== 1 || rows[0].name !== name || rows[0].status !== 'APPROVED'
    || rows[0].language !== TEMPLATE_LANGUAGE) {
    throw Object.assign(new Error('review_template_not_approved'), { status: 409 });
  }
  const phoneUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${config.wabaId}/phone_numbers`);
  phoneUrl.searchParams.set('fields', 'id,platform_type');
  phoneUrl.searchParams.set('limit', '100');
  const phoneData = await graph(phoneUrl.toString(), config.accessToken);
  const numbers = Array.isArray(phoneData?.data) ? phoneData.data : [];
  if (numbers.length !== 1 || !/^[1-9][0-9]{5,30}$/.test(String(numbers[0]?.id || ''))) {
    throw Object.assign(new Error('review_phone_ambiguous'), { status: 409 });
  }
  // Never retry this POST: an ambiguous provider response may mean it was sent.
  const payload = await graph(
    `https://graph.facebook.com/${GRAPH_VERSION}/${numbers[0].id}/messages`,
    config.accessToken,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: TEMPLATE_LANGUAGE } } }) },
  );
  const messageId = payload?.messages?.[0]?.id;
  if (typeof messageId !== 'string' || !/^wamid\.[A-Za-z0-9_.=-]{8,256}$/.test(messageId)) {
    throw Object.assign(new Error('meta_send_acknowledgement_ambiguous'), { status: UPSTREAM_FAILURE_STATUS });
  }
  return { ok: true, action: 'send', accepted: true, message_id: messageId };
}

async function handlePost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.origin !== PRODUCTION_CRM_ORIGIN
    || ![PRODUCTION_CRM_ORIGIN, OPERATOR_CRM_ORIGIN].includes(request.headers.get('origin'))) {
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
    if (action !== 'create' && action !== 'delete' && action !== 'status' && action !== 'send' && action !== 'business') {
      return json({ ok: false, error: 'action_not_allowed' }, 400);
    }

    stage = `meta_${action}`;
    if (action === 'business') return json({ ok: true, action, business: await readReviewBusiness(config) });
    if (action === 'send') return json(await sendReviewMessage(config, env, body));
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
      if (typeof error.graphMessage === 'string' && error.graphMessage) body.graph_message = error.graphMessage;
    }
    return json(body, status);
  }
}

export async function onRequest(context) {
  const { request } = context;
  const operator = new URL(request.url).origin === PRODUCTION_CRM_ORIGIN
    && request.headers.get('origin') === OPERATOR_CRM_ORIGIN;
  if (request.method === 'OPTIONS') {
    if (!operator) return json({ ok: false, error: 'origin_not_allowed' }, 403);
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': OPERATOR_CRM_ORIGIN,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '300',
      vary: 'Origin',
    } });
  }
  const response = request.method === 'POST' ? await handlePost(context)
    : json({ ok: false, error: 'method_not_allowed' }, 405);
  if (operator) {
    response.headers.set('access-control-allow-origin', OPERATOR_CRM_ORIGIN);
    response.headers.set('access-control-expose-headers', 'x-vishar-review-handler');
    response.headers.set('vary', 'Origin');
  }
  return response;
}

export const __testing = Object.freeze({
  TEMPLATE_NAME_PREFIX,
  TEMPLATE_NAME_PATTERN,
  generateTemplateName,
  TEMPLATE_LANGUAGE,
  TEMPLATE_CATEGORY,
  TEMPLATE_BODY,
  UPSTREAM_FAILURE_STATUS,
  listReviewTemplates,
  safeGraphMessage,
  safeTemplate,
  sendReviewMessage,
});
