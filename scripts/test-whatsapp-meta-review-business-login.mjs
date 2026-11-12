import assert from 'node:assert/strict';
import { onRequest } from '../admin/functions/api/whatsapp/meta-review/business-login.js';

const URL = 'https://crm.vishartattoo.com/api/whatsapp/meta-review/business-login';
const OPERATOR = 'https://app.vishartattoo.com';
const TEST_BUSINESS = '123456789012345';
const CONFIG = '987654321012345';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CODE = 'AQD-meta-business-review-only-once-123456';
const USER_TOKEN = 'temporary-meta-user-token-for-test-only';
const originalFetch = globalThis.fetch;
function env(overrides = {}) {
  return {
    META_REVIEW_BUSINESS_LOGIN_ENABLED: 'true',
    META_REVIEW_BUSINESS_CONFIG_ID: CONFIG,
    META_REVIEW_BUSINESS_ID: TEST_BUSINESS,
    META_APP_SECRET: 'dummy-meta-app-secret-for-tests',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_mock_only',
    ...overrides,
  };
}
function request(method = 'POST', overrides = {}) {
  return new Request(URL, {
    method,
    headers: { origin: overrides.origin ?? OPERATOR,
      authorization: overrides.authorization ?? 'Bearer owner-session-abcdefghijk-123',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(overrides.body ?? { code: CODE }) } : {}),
  });
}
function mockFetch(calls, { scopes = true, selected = true } = {}) {
  return async (url, init = {}) => {
    const target = String(url), method = init.method || 'GET';
    assert.equal(init.redirect, 'manual');
    calls.push({ target, method });
    if (target.includes('/auth/v1/user')) return Response.json({ id: OWNER });
    if (target.includes('/rest/v1/profiles')) return Response.json([{ id: OWNER, role: 'owner', is_active: true }]);
    if (target.includes('/oauth/access_token')) {
      assert.equal(method, 'POST');
      assert.equal(new URLSearchParams(init.body).get('redirect_uri'),
        'https://app.vishartattoo.com/?meta_business_review=1');
      return Response.json({ access_token: USER_TOKEN });
    }
    if (target.includes('/me/permissions')) {
      assert.equal(init.headers.authorization, `Bearer ${USER_TOKEN}`);
      return Response.json({ data: scopes
        ? [{ permission: 'business_management', status: 'granted' }]
        : [{ permission: 'whatsapp_business_management', status: 'granted' }] });
    }
    if (target.includes('/me/businesses')) {
      assert.equal(init.headers.authorization, `Bearer ${USER_TOKEN}`);
      return Response.json({ data: selected
        ? [{ id: '9999999999', name: 'Unrelated business' }, { id: TEST_BUSINESS, name: 'Isolated Review' }]
        : [{ id: '9999999999', name: 'Unrelated business' }] });
    }
    throw new Error('unexpected fetch path');
  };
}
try {
  // Entire functionality is off unless explicitly provisioned.
  globalThis.fetch = async () => { throw new Error('disabled request must not fetch'); };
  assert.equal((await onRequest({ request: request('GET'), env: env({ META_REVIEW_BUSINESS_LOGIN_ENABLED: 'false' }) })).status, 404);
  assert.equal((await onRequest({ request: request('GET'), env: env({ META_REVIEW_BUSINESS_ID: '692776505711216' }) })).status, 404);
  assert.equal((await onRequest({ request: request('GET', { origin: 'https://untrusted.invalid' }), env: env() })).status, 403);
  assert.equal((await onRequest({ request: request('OPTIONS'), env: env() })).status, 204);

  const calls = [];
  globalThis.fetch = mockFetch(calls);
  const configResponse = await onRequest({ request: request('GET'), env: env() });
  assert.equal(configResponse.status, 200);
  assert.deepEqual(await configResponse.json(), { ok: true, config_id: CONFIG });
  const success = await onRequest({ request: request(), env: env() });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true, business_id: TEST_BUSINESS,
    business_name: 'Isolated Review', permission: 'business_management' });
  assert(calls.every(x => x.method === 'GET' || x.target.includes('/oauth/access_token')));
  assert(calls.every(x => !/subscribed_apps|phone_numbers|messages|provision/.test(x.target)));
  assert(calls.some(x => x.target.includes('/me/businesses')));
  assert(!JSON.stringify(await success.clone().json()).includes(USER_TOKEN));

  const withoutScope = [];
  globalThis.fetch = mockFetch(withoutScope, { scopes: false });
  const permissionDenied = await onRequest({ request: request(), env: env() });
  assert.equal(permissionDenied.status, 409);
  assert.equal((await permissionDenied.json()).error, 'meta_business_management_not_granted');
  assert(!withoutScope.some(x => x.target.includes('/me/businesses')));

  globalThis.fetch = mockFetch([], { selected: false });
  const notSelected = await onRequest({ request: request(), env: env() });
  assert.equal(notSelected.status, 409);
  assert.equal((await notSelected.json()).error, 'meta_review_business_not_selected');

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: OWNER });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: OWNER, role: 'manager', is_active: true }]);
    throw new Error('not allowed');
  };
  assert.equal((await onRequest({ request: request(), env: env() })).status, 403);
  assert.equal((await onRequest({ request: request('GET', { authorization: 'Bearer short' }), env: env() })).status, 401);
  console.log('Meta business login boundary tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
