import assert from 'node:assert/strict';
import { handleGptCloudflareControlRequest } from '../workers/lib/gpt-cloudflare-control.js';

const oauth = 'header.payload.signature';
const envBase = {
  GPT_ACTIONS_ENABLED: 'true',
  CLOUDFLARE_CONTROL_ENABLED: 'true',
  CLOUDFLARE_CONTROL_READ_ENABLED: 'true',
  CLOUDFLARE_CONTROL_WRITE_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};

function request(path, body, method = body === undefined ? 'GET' : 'POST', auth = true) {
  return new Request(`https://gpt-operations.vishartattoo.com${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${oauth}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authFetch(url, init) {
  assert.equal(String(url), 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_authorize_cloudflare_control');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${oauth}`);
  return Promise.resolve(new Response(JSON.stringify({ allowed: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

{
  const result = await handleGptCloudflareControlRequest(request('/v1/appointments'), envBase, async () => { throw new Error('not called'); });
  assert.equal(result, null);
}

{
  let authCalled = false;
  let serviceCalled = false;
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/workers'), {
    ...envBase,
    CLOUDFLARE_CONTROL_ENABLED: 'false',
    CLOUDFLARE_GATEWAY: { async fetch() { serviceCalled = true; } },
  }, async () => { authCalled = true; });
  assert.equal(response.status, 404);
  assert.equal(authCalled, false);
  assert.equal(serviceCalled, false);
}

{
  let called = false;
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/workers', undefined, 'GET', false), envBase, async () => { called = true; });
  assert.equal(response.status, 401);
  assert.equal(called, false);
}

{
  let called = false;
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/worker', { script_name: 'crm-worker', account_id: 'a'.repeat(32) }), envBase, async () => { called = true; });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'account_id' });
  assert.equal(called, false);
}

{
  let serviceRequest;
  const env = {
    ...envBase,
    CLOUDFLARE_GATEWAY: {
      async fetch(url, init) {
        serviceRequest = { url: String(url), init };
        return new Response(JSON.stringify({ workers: [{ name: 'crm-worker' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/workers'), env, authFetch);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).workers[0].name, 'crm-worker');
  assert.equal(serviceRequest.url, 'https://cloudflare-gateway.internal/internal/cloudflare/workers');
  assert.equal(new Headers(serviceRequest.init.headers).has('authorization'), false, 'caller OAuth must not cross the service binding');
}

{
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/worker/deploy', { script_name: 'crm-worker', code: 'export default {}' }), {
    ...envBase,
    CLOUDFLARE_CONTROL_WRITE_ENABLED: 'false',
  }, async () => { throw new Error('not called'); });
  assert.equal(response.status, 404);
}

{
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/workers'), envBase, authFetch);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'cloudflare_gateway_unavailable' });
}

{
  const response = await handleGptCloudflareControlRequest(request('/v1/cloudflare/workers'), {
    ...envBase,
    CLOUDFLARE_GATEWAY: { async fetch() { throw new Error('binding failed'); } },
  }, authFetch);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'cloudflare_gateway_transport_error' });
}

console.log('GPT Cloudflare control tests passed');
