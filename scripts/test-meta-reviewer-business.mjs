import assert from 'node:assert/strict';
import { onRequest } from '../admin/functions/api/whatsapp/meta-review/reviewer-business.js';
const ID = '123e4567-e89b-42d3-a456-426614174000';
const URL = 'https://crm.vishartattoo.com/api/whatsapp/meta-review/reviewer-business';
const env = { META_REVIEWER_ACCESS_ENABLED: 'true', META_REVIEW_CRM_USER_ID: ID,
  META_REVIEW_ACCESS_EXPIRES_AT: '2099-01-01T00:00:00Z', SUPABASE_PUBLISHABLE_KEY: 'public-key',
  META_APP_SECRET: 'test-only-secret' };
const request = (method, origin = 'https://crm.vishartattoo.com', body) => new Request(URL, {
  method, headers: { ...(origin ? { origin } : {}), authorization: `Bearer ${'a'.repeat(32)}`,
    ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const original = globalThis.fetch;
try {
  assert.equal((await onRequest({ request: request('GET'), env: { ...env, META_REVIEWER_ACCESS_ENABLED: 'false' } })).status, 404);
  assert.equal((await onRequest({ request: request('GET'), env: { ...env, META_REVIEW_ACCESS_EXPIRES_AT: '2000-01-01' } })).status, 404);
  assert.equal((await onRequest({ request: request('GET', 'https://evil.example'), env })).status, 403);
  assert.equal((await onRequest({ request: request('POST', 'https://evil.example', { code: 'c'.repeat(32) }), env })).status, 403);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return Response.json({ id: ID });
    if (u.includes('/rest/v1/profiles')) return Response.json([]);
    throw new Error(`Unexpected fetch ${u}`);
  };
  assert.equal((await onRequest({ request: request('GET'), env })).status, 200);
  assert.equal((await onRequest({ request: request('GET', null), env })).status, 200);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return Response.json({ id: '223e4567-e89b-42d3-a456-426614174000' });
    throw new Error(`Unexpected fetch ${u}`);
  };
  assert.equal((await onRequest({ request: request('GET'), env })).status, 403);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return Response.json({ id: ID });
    if (u.includes('/rest/v1/profiles')) return Response.json([{ id: ID }]);
    throw new Error(`Unexpected fetch ${u}`);
  };
  assert.equal((await onRequest({ request: request('GET'), env })).status, 403);
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return Response.json({ id: ID });
    if (u.includes('/rest/v1/profiles')) return Response.json([]);
    if (u.includes('/oauth/access_token')) return Response.json({ access_token: 't'.repeat(32) });
    if (u.includes('/me/permissions')) return Response.json({ data: [{ permission: 'business_management', status: 'granted' }] });
    if (u.includes('/me/businesses')) return Response.json({ data: [
      { id: '692776505711216', name: 'Production' }, { id: '462106700328578', name: 'WABA' },
      { id: '775640614811667', name: 'Test' },
    ] });
    throw new Error(`Unexpected fetch ${u}`);
  };
  const res = await onRequest({ request: request('POST', undefined, { code: 'c'.repeat(32) }), env });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).businesses, [{ id: '775640614811667', name: 'Test' }]);
  console.log('Meta reviewer boundary checks passed');
} finally { globalThis.fetch = original; }
