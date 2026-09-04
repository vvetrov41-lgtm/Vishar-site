import assert from 'node:assert/strict';
import { __testing, onRequestPost } from '../admin/functions/api/whatsapp/meta-review/template.js';

const ENDPOINT = 'https://crm.vishartattoo.com/api/whatsapp/meta-review/template';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REVIEW_WABA = '123456789012345';
const REVIEW_TOKEN = 'meta-review-access-token-for-unit-test-only-1234567890';

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

function authorizedFetch(calls, { templates = [], createId = '987654321001234' } = {}) {
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
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload, {
        name: __testing.TEMPLATE_NAME,
        language: __testing.TEMPLATE_LANGUAGE,
        category: __testing.TEMPLATE_CATEGORY,
        components: [{ type: 'BODY', text: __testing.TEMPLATE_BODY }],
      });
      rows.push({
        id: createId,
        name: __testing.TEMPLATE_NAME,
        status: 'PENDING',
        language: __testing.TEMPLATE_LANGUAGE,
        category: __testing.TEMPLATE_CATEGORY,
      });
      return Response.json({ id: createId, status: 'PENDING', category: __testing.TEMPLATE_CATEGORY });
    }
    if (target.includes(`/${REVIEW_WABA}/message_templates?name=${__testing.TEMPLATE_NAME}`) && method === 'DELETE') {
      assert.equal(init.headers.authorization, `Bearer ${REVIEW_TOKEN}`);
      rows = rows.filter((row) => row.name !== __testing.TEMPLATE_NAME);
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
    const response = await onRequestPost({ request: request('create'), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      action: 'create',
      template: {
        id: '987654321001234',
        name: __testing.TEMPLATE_NAME,
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
      name: __testing.TEMPLATE_NAME,
      status: 'PENDING',
      language: __testing.TEMPLATE_LANGUAGE,
      category: __testing.TEMPLATE_CATEGORY,
    }],
  });
  try {
    const response = await onRequestPost({ request: request('delete'), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, action: 'delete', deleted: true });
    assert.equal(calls.some((call) => String(call.target).includes(`message_templates?name=${__testing.TEMPLATE_NAME}`)), true);
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
      name: __testing.TEMPLATE_NAME,
      status: 'APPROVED',
      language: __testing.TEMPLATE_LANGUAGE,
      category: __testing.TEMPLATE_CATEGORY,
    }],
  });
  try {
    const response = await onRequestPost({ request: request('status'), env: env() });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.template.name, __testing.TEMPLATE_NAME);
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
    const response = await onRequestPost({
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
  const response = await onRequestPost({
    request: request('status'),
    env: env({ META_REVIEW_WABA_ID: '341184815737145', META_REVIEW_ACCESS_TOKEN: '' }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'server_not_configured', stage: 'review_gate' });
}

{
  const response = await onRequestPost({
    request: request('status', { origin: 'https://evil.example' }),
    env: env(),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'origin_not_allowed' });
}

console.log('WhatsApp Meta review template probe checks passed.');
