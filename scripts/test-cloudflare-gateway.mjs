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
  if (u.pathname.endsWith(`/client/v4/accounts/${accountId}/workers/scripts/gpt-sandbox-demo/content`)) {
    assert.equal(init.method, 'PUT');
    return cf({ id: 'gpt-sandbox-demo', modified_on: '2026-09-22' });
  }
  if (u.pathname.endsWith(`/client/v4/zones/${zoneId}/dns_records/${recordId}`)) {
    assert.ok(!init.method || init.method === 'GET', 'a protected record must be inspected, never mutated');
    return cf({ id: recordId, type: 'A', name: 'crm.vishartattoo.com', content: '203.0.113.10' });
  }
  if (u.pathname.endsWith(`/client/v4/zones/${zoneId}/workers/routes/${routeId}`)) {
    assert.ok(!init.method || init.method === 'GET', 'a production route must be inspected, never mutated');
    return cf({ id: routeId, pattern: 'vishartattoo.com/*', script: 'crm-worker' });
  }
  if (u.pathname.endsWith(`/client/v4/zones/${zoneId}/dns_records`) && init.method === 'POST') {
    const payload = JSON.parse(init.body);
    return cf({ id: 'ffffffffffffffffffffffffffffffff', ...payload });
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
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker/deploy', { script_name: 'gpt-sandbox-demo', code: 'export default { fetch(){ return new Response("ok") } };' }), env, mockFetch);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployed, true);
  assert.ok(calls.some((call) => call.url.endsWith(`/workers/scripts/gpt-sandbox-demo/content`) && call.init.method === 'PUT'));
}

// Audit H-6: production Workers, routes and DNS are never writable by the GPT.
for (const scriptName of ['crm-worker', 'tattooai', 'vishar-gpt-actions-production', 'vishar-telegram-drain-production']) {
  const before = calls.length;
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker/deploy', { script_name: scriptName, code: 'export default {};' }), env, mockFetch);
  assert.equal(response.status, 409, `deploy over ${scriptName} must be refused`);
  assert.deepEqual(await response.json(), { error: 'protected_worker' });
  assert.equal(calls.length, before, 'a refused deploy makes no provider call');
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/worker/delete', { script_name: 'tattooai', confirm: 'tattooai' }), env, mockFetch);
  assert.equal(response.status, 409);
}

for (const record of [
  { type: 'A', name: 'crm.vishartattoo.com', content: '203.0.113.9' },
  { type: 'A', name: 'vishartattoo.com', content: '203.0.113.9' },
  { type: 'MX', name: 'gpt-sandbox-mail.vishartattoo.com', content: 'mx.attacker.example' },
  { type: 'TXT', name: 'gpt-sandbox-x.vishartattoo.com', content: 'v=spf1 include:attacker.example' },
  { type: 'CNAME', name: 'www.gpt-sandbox-x.vishartattoo.com', content: 'attacker.example' },
]) {
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/dns/upsert', { zone: 'vishartattoo.com', ...record }), env, mockFetch);
  assert.equal(response.status, 409, `DNS write ${record.type} ${record.name} must be refused`);
  assert.deepEqual(await response.json(), { error: 'protected_dns_record' });
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/dns/upsert', { zone: 'vishartattoo.com', type: 'CNAME', name: 'gpt-sandbox-demo.vishartattoo.com', content: 'gpt-sandbox-demo.workers.dev' }), env, mockFetch);
  assert.equal(response.status, 200);
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/dns/delete', { zone: 'vishartattoo.com', record_id: recordId, confirm: recordId }), env, mockFetch);
  assert.equal(response.status, 409, 'deleting an existing production record is refused');
  assert.ok(!calls.some((call) => call.init.method === 'DELETE'));
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/routes/delete', { zone: 'vishartattoo.com', route_id: routeId, confirm: routeId }), env, mockFetch);
  assert.equal(response.status, 409, 'deleting a production route is refused');
}

{
  const response = await handleCloudflareGatewayRequest(req('/internal/cloudflare/routes/upsert', { zone: 'vishartattoo.com', pattern: 'vishartattoo.com/book/*', script_name: 'gpt-sandbox-demo', route_id: routeId }), env, mockFetch);
  assert.equal(response.status, 409, 'repointing a production route is refused');
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
