import assert from 'node:assert/strict';
import { createSupabaseClient, SupabaseError } from '../workers/lib/supabase.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-key-with-no-production-access',
};
const rpcName = 'service_run_automation_tick';
const response = (status, body) => Response.json(body, { status });

async function expectUnknown(label, fetchImpl) {
  let calls = 0;
  const client = createSupabaseClient(env, async (...args) => {
    calls += 1;
    const options = args[1];
    assert.equal(options.method, 'POST', label);
    assert.equal(options.signal instanceof AbortSignal, true, label + ' must supply a timeout');
    assert.equal(options.signal.aborted, false);
    assert.equal(options.body, '{}');
    return fetchImpl(...args);
  });
  await assert.rejects(client.rpc(rpcName, {}), error =>
    error instanceof SupabaseError
    && error.code === 'database_result_unknown'
    && error.status === 504, label);
  assert.equal(calls, 1, label + ' must never replay an ambiguous write');
}

await expectUnknown('network abort after database may have committed', async () => {
  const error = new Error('private-message-body');
  error.name = 'AbortError';
  throw error;
});
await expectUnknown('transport network error', async () => {
  throw new TypeError('client-phone-number-in-exception');
});
await expectUnknown('invalid response JSON after HTTP 200', async () =>
  new Response('{partial', { status: 200, headers: { 'content-type': 'application/json' } })
);

let count = 0;
const flaky = createSupabaseClient(env, async (_url, opts) => {
  count += 1;
  assert.ok(opts.signal instanceof AbortSignal);
  return response(503, { code: 'unknown', message: 'sensitive client data' });
});
await assert.rejects(flaky.rpc(rpcName), error =>
  error instanceof SupabaseError && error.code === 'database_unavailable' && error.status === 503);
assert.equal(count, 1, 'HTTP 5xx cannot prove rollback, so automatic retry is forbidden');

const ok = createSupabaseClient(env, async (_url, opts) => {
  assert.ok(opts.signal instanceof AbortSignal);
  return response(200, { processed: 1 });
});
assert.deepEqual(await ok.rpc(rpcName), { processed: 1 });

const rejected = createSupabaseClient(env, async () => response(422, { code: 'foreign', message: 'private' }));
await assert.rejects(rejected.rpc(rpcName), error =>
  error instanceof SupabaseError && error.code === 'database_rejected' && error.status === 422);

console.log('Bounded Supabase RPC and ambiguous-send regression tests passed.');
