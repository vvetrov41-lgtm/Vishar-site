import assert from 'node:assert/strict';
import * as reviewRoute from '../admin/functions/api/whatsapp/meta-review/template.js';

const { __testing, onRequest } = reviewRoute;
assert.equal('onRequestPost' in reviewRoute, false, 'Pages must dispatch POST through the CORS wrapper');

const ENDPOINT = 'https://crm.vishartattoo.com/api/whatsapp/meta-review/template';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REVIEW_WABA = '123456789012345';
const REVIEW_TOKEN = 'meta-review-access-token-for-unit-test-only-1234567890';
const EXISTING_NAME = 'meta_review_permission_demo_20261110082926';

function request(action, overrides = {}) {
  return new Request(overrides.url ?? ENDPOINT, {
    method: 'POST',
    headers: {
      origin: overrides.origin ?? 'https://crm.vishartattoo.com',
      authorization: overrides.authorization ?? 'Bearer crm-owner-session-token-for-test',
      'content-type': overrides.contentType ?? 'application/json',
    },
    body: JSON.stringify({ action }),
  });
}

function env(overrides = {}) {
  return {
    META_REVIEW_TEMPLATE_ENABLED: 'true',
    META_REVIEW_WABA_ID: REVIEW_WABA,
    META_REVIEW_ACCESS_TOKEN: REVIEW_TOKEN,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_value',
    ...overrides,
  };
}

function authorizedFetch(calls, { templates = [], createId = '987654321001234', createError = null } = {}) {
  let rows = structuredClone(templates);
  return async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ target, init });
    assert.equal(init.redirect, 'manual');

    if (target.includes('/auth/v1/user')) return Response.json({ id: OWNER_ID });
    if (target.includes('/rest/v1/profiles')) {
      return Response.json([{ id: OWNER_ID, role: 'owner', is_active: true }]);
    }
    if (target.includes(`/${REVIEW_WABA}/message_templates`) && method === 'GET') {
      const parsed = new URL(target);
      assert.equal(parsed.searchParams.get('fields'), 'id,name,status,language,category');
      assert.equal(parsed.searchParams.get('limit'), '100');
      assert.equal(init.headers.authorization, `Bearer ${REVIEW_TOKEN}`);
      return Response.json({ data: structuredClone(rows) });
    }
    if (target === `https://graph.facebook.com/v25.0/${REVIEW_WABA}/message_templates` && method === 'POST') {
      assert.equal(init.headers.authorization, `Bearer ${REVIEW_TOKEN}`);
      if (createError) return Response.json({ error: createError }, { status: 400 });
      const payload = JSON.parse(String(init.body));
      assert.match(payload.name, __testing.TEMPLATE_NAME_PATTERN);
      assert.equal(rows.some((row) => row.name === payload.name), false);
      assert.deepEqual(payload, {
        name: payload.name,
        language: __testing.TEMPLATE_LANGUAGE,
        category: __testing.TEMPLATE_CATEGORY,
        components: [{ type: 'BODY', text: __testing.TEMPLATE_BODY }],
      });
      rows.push({
        id: createId,
        name: payload.name,
        status: 'PENDING',
        language: __testing.TEMPLATE_LANGUAGE,
        category: __testing.TEMPLATE_CATEGORY,
      });
      return Response.json({ id: createId, status: 'PENDING', category: __testing.TEMPLATE_CATEGORY });
    }
    if (target.includes(`/${REVIEW_WABA}/message_templates?`) && method === 'DELETE') {
      assert.equal(init.headers.authorization, `Bearer ${REVIEW_TOKEN}`);
      const parsed = new URL(target);
      const name = parsed.searchParams.get('name');
      const hsmId = parsed.searchParams.get('hsm_id');
      assert.match(name, __testing.TEMPLATE_NAME_PATTERN);
      assert.equal(rows.some((row) => row.name === name && row.id === hsmId), true);
      rows = rows.filter((row) => !(row.name === name && row.id === hsmId));
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected network call: ${method} ${target}`);
  };
}

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authorizedFetch(calls);
  try {
    const response = await onRequest({ request: request('create'), env: env() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-vishar-review-handler'), 'template-v1');
    const created = await response.json();
    assert.match(created.template.name, __testing.TEMPLATE_NAME_PATTERN);
    assert.deepEqual(created, {
      ok: true,
      action: 'create',
      template: {
        id: '987654321001234',
        name: created.template.name,
        status: 'PENDING',
        language: __testing.TEMPLATE_LANGUAGE,
        category: __testing.TEMPLATE_CATEGORY,
      },
    });
    assert.equal(calls.filter((call) => String(call.target).includes('/message_templates')).length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authorizedFetch(calls, {
    templates: [{
      id: '987654321001234',
      name: EXISTING_NAME,
      status: 'PENDING',
      language: __testing.TEMPLATE_LANGUAGE,
      category: __testing.TEMPLATE_CATEGORY,
    }],
  });
  try {
    const response = await onRequest({ request: request('delete'), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, action: 'delete', deleted: true });
    assert.equal(calls.some((call) => String(call.target).includes(`message_templates?name=${EXISTING_NAME}&hsm_id=987654321001234`)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authorizedFetch(calls, {
    templates: [{
      id: '987654321001234',
      name: EXISTING_NAME,
      status: 'APPROVED',
      language: __testing.TEMPLATE_LANGUAGE,
      category: __testing.TEMPLATE_CATEGORY,
    }],
  });
  try {
    const response = await onRequest({ request: request('status'), env: env() });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.template.name, EXISTING_NAME);
    assert.equal(JSON.stringify(payload).includes(REVIEW_TOKEN), false);
    assert.equal(JSON.stringify(payload).includes(REVIEW_WABA), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('network must stay untouched while review gate is off');
  };
  try {
    const response = await onRequest({
      request: request('status'),
      env: env({ META_REVIEW_TEMPLATE_ENABLED: 'false' }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'meta_review_disabled', stage: 'review_gate' });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const response = await onRequest({
    request: request('status'),
    env: env({ META_REVIEW_WABA_ID: '341184815737145', META_REVIEW_ACCESS_TOKEN: '' }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'server_not_configured', stage: 'review_gate' });
}

{
  const response = await onRequest({
    request: new Request(ENDPOINT, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.vishartattoo.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type' },
    }),
    env: env(),
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.vishartattoo.com');
  assert.equal(response.headers.get('access-control-allow-headers'), 'authorization, content-type');
}

{
  const response = await onRequest({
    request: request('status', { origin: 'https://app.vishartattoo.com', authorization: 'Bearer invalid' }),
    env: env(),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.vishartattoo.com');
  assert.deepEqual(await response.json(), { ok: false, error: 'crm_auth_required', stage: 'crm_owner' });
}

{
  const response = await onRequest({
    request: request('status', { origin: 'https://evil.example' }),
    env: env(),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'origin_not_allowed' });
}

// Meta create failure must surface as 424 JSON, never 502: Cloudflare replaces an
// origin 502 with its own HTML page, which hid stage/graph_code in production.
for (const origin of ['https://crm.vishartattoo.com', 'https://app.vishartattoo.com']) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authorizedFetch(calls, {
    createError: {
      code: 100,
      error_subcode: 2388024,
      message: `Invalid parameter ${REVIEW_TOKEN}`,
      error_user_msg: `Template language or category is not supported. ref ${REVIEW_TOKEN}`,
    },
  });
  try {
    const response = await onRequest({ request: request('create', { origin }), env: env() });
    assert.equal(response.status, 424);
    assert.notEqual(response.status, 502);
    assert.equal(response.headers.get('x-vishar-review-handler'), 'template-v1');
    if (origin === 'https://app.vishartattoo.com') {
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-expose-headers'), 'x-vishar-review-handler');
    }
    const payload = await response.json();
    assert.deepEqual(payload, {
      ok: false,
      error: 'meta_request_failed',
      stage: 'meta_create',
      graph_code: 100,
      graph_subcode: 2388024,
      upstream_status: 400,
      graph_message: 'Template language or category is not supported. ref [redacted]',
    });
    assert.equal(JSON.stringify(payload).includes(REVIEW_TOKEN), false);
    assert.equal(calls.filter((call) => String(call.target).includes('/message_templates')).length, 2,
      'a failed create must not retry or create a duplicate');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  assert.equal(__testing.UPSTREAM_FAILURE_STATUS, 424);
  assert.equal(__testing.safeGraphMessage(null), null);
  assert.equal(__testing.safeGraphMessage({ message: 'a\nb' }), 'a b');
  assert.equal(__testing.safeGraphMessage({ message: 'x'.repeat(500) }).length <= 240, true);
}

{
  // Regression: Meta blocks new en_US content under a deleted name for 4 weeks
  // (graph_code 100, subcodes 2388025/2388023), so every create needs a fresh name.
  assert.equal(__testing.TEMPLATE_NAME_PREFIX, 'meta_review_permission_demo_');
  assert.equal(__testing.generateTemplateName(new Date('2026-11-11T05:52:10.123Z')),
    'meta_review_permission_demo_20261111055210');
  assert.equal(__testing.TEMPLATE_NAME_PATTERN.test('meta_review_permission_demo_v2'), false);
  assert.equal(__testing.TEMPLATE_NAME_PATTERN.test('meta_review_permission_demo'), false);
  assert.equal(__testing.TEMPLATE_NAME_PATTERN.test('hello_world'), false);
  assert.equal(__testing.TEMPLATE_LANGUAGE, 'en_US');
  assert.equal(__testing.TEMPLATE_CATEGORY, 'MARKETING');
}

// Delete followed by create must work: the new create uses a different name, and
// legacy fixed-name or sample templates are never treated as the review template.
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authorizedFetch(calls, {
    templates: [
      { id: '1', name: 'hello_world', status: 'APPROVED', language: 'en_US', category: 'UTILITY' },
      { id: '2', name: 'meta_review_permission_demo_v2', status: 'PENDING', language: 'en_US', category: 'MARKETING' },
      { id: '987654321001234', name: EXISTING_NAME, status: 'PENDING', language: 'en_US', category: 'MARKETING' },
    ],
    createId: '987654321009999',
  });
  try {
    const deleted = await onRequest({ request: request('delete'), env: env() });
    assert.deepEqual(await deleted.json(), { ok: true, action: 'delete', deleted: true });
    const created = await onRequest({ request: request('create'), env: env() });
    assert.equal(created.status, 200);
    const payload = await created.json();
    assert.equal(payload.template.id, '987654321009999');
    assert.notEqual(payload.template.name, EXISTING_NAME);
    assert.match(payload.template.name, __testing.TEMPLATE_NAME_PATTERN);
    const posts = calls.filter((call) => String(call.init.method || 'GET').toUpperCase() === 'POST'
      && String(call.target).includes('/message_templates'));
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('WhatsApp Meta review template probe checks passed.');
