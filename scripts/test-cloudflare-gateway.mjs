import assert from 'node:assert/strict';
import { handleCloudflareGatewayRequest } from '../workers/cloudflare-gateway.js';

const token = 'cf-test-token-not-a-real-secret-123456789';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const recordId = 'c'.repeat(32);
const routeId = 'd'.repeat(32);
const env = { VISHAR_ENVIRONMENT: 'production', CLOUDFLARE_API_TOKEN: token };

function cf(result, status = 200, errors = []) {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result, errors }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function req(path, body, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://cloudflare-gateway.internal${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

{
  let called = false;
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/account'), { VISHAR_ENVIRONMENT: 'production' }, async () => { called = true; });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'cloudflare_not_configured' });
  assert.equal(called, false);
}

const calls = [];
const mockFetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
  const u = new URL(String(url));
  if (u.pathname.endsWith('/client/v4/accounts')) return cf([{ id: accountId, name: 'Vishar Account' }]);
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/workers/scripts`)) {
    return cf([{ id: 'crm-worker', created_on: '2026-01-01', modified_on: '2026-02-01', compatibility_date: '2026-01-01' }]);
  }
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/workers/scripts/crm-worker/deployments`)) {
    return cf([{ id: '11111111-1111-4111-8111-111111111111', created_on: '2026-01-01', source: 'api', strategy: 'percentage', versions: [] }]);
  }
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/workers/scripts/crm-worker/content`)) {
    assert.equal(init.method, 'PUT');
    assert.ok(init.body instanceof FormData);
    assert.ok(init.body.get('metadata'));
    assert.ok(init.body.get('worker.js'));
    return cf({ id: 'crm-worker', modified_on: '2026-09-01' });
  }
  if (u.pathname.endsWith('/client/v4/zones')) {
    assert.equal(u.searchParams.get('account.id'), accountId);
    return cf([{ id: zoneId, name: 'vishartattoo.com', account: { id: accountId }, status: 'active' }]);
  }
  if (u.pathname.endsWith(`/client/v4/zones/${zoneId}/dns_records`)) {
    return cf([{ id: recordId, type: 'A', name: 'crm.vishartattoo.com', content: '203.0.113.10', ttl: 1, proxied: true }]);
  }
  if (u.pathname.endsWith(`/client/v4/zones/${zoneId}/workers/routes`)) {
    return cf([{ id: routeId, pattern: 'vishartattoo.com/*', script: 'crm-worker' }]);
  }
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/pages/projects`)) return cf([]);
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/d1/database`)) return cf([]);
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/storage/kv/namespaces`)) return cf([]);
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/r2/buckets`)) return cf({ buckets: [] });
  throw new Error(`unexpected mock URL ${u}`);
};

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/account'), env, mockFetch);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { account: { name: 'Vishar Account' } });
  assert.equal(JSON.stringify(body).includes(token), false);
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/workers'), env, mockFetch);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).workers[0].name, 'crm-worker');
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker', { script_name: 'crm-worker', account_id: accountId }), env, mockFetch);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'account_id' });
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker/deploy', { script_name: 'crm-worker', code: 'export default { fetch(){ return new Response("ok") } };' }), env, mockFetch);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployed, true);
  assert.ok(calls.some((call) => call.url.endsWith(`/workers/scripts/crm-worker/content`) && call.init.method === 'PUT'));
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker/delete', { script_name: 'vishar-cloudflare-gateway', confirm: 'vishar-cloudflare-gateway' }), env, mockFetch);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'protected_worker' });
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/dns/list', { zone: 'vishartattoo.com' }), env, mockFetch);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.zone, 'vishartattoo.com');
  assert.equal(body.records[0].id, recordId);
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/routes/list', { zone: 'vishartattoo.com' }), env, mockFetch);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).routes[0].id, routeId);
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/cache/purge', { zone: 'vishartattoo.com', urls: ['https://evil.example/'] }), env, mockFetch);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_field', field: 'urls' });
}

console.log('Cloudflare gateway tests passed');
