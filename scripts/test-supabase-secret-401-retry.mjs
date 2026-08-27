#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createSupabaseClient, SupabaseError } from '../workers/lib/supabase.js';

const secretEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only',
};
const legacyEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-test-jwt',
};

function makeFetch(responses, calls) {
  let index = 0;
  return async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body,
    });
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('unexpected extra Supabase request');
    return response;
  };
}

{
  const calls = [];
  const client = createSupabaseClient(secretEnv, makeFetch([
    Response.json({ message: 'private gateway body' }, { status: 401 }),
    Response.json([{ materialised: 0, withdrawn: 0, executed: 0, notified: 0 }]),
  ], calls));

  const result = await client.rpc('service_run_automation_tick', { p_limit: 100 });
  assert.deepEqual(result, [{ materialised: 0, withdrawn: 0, executed: 0, notified: 0 }]);
  assert.equal(calls.length, 2, 'secret-key 401 must receive exactly one retry');
  for (const call of calls) {
    assert.equal(call.url, 'https://example.supabase.co/rest/v1/rpc/service_run_automation_tick');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('apikey'), secretEnv.SUPABASE_SECRET_KEY);
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.body, JSON.stringify({ p_limit: 100 }));
  }
}

{
  const calls = [];
  const client = createSupabaseClient(secretEnv, makeFetch([
    Response.json({ message: 'first private body' }, { status: 401 }),
    Response.json({ message: 'second private body' }, { status: 401 }),
  ], calls));

  await assert.rejects(
    client.rpc('service_run_automation_tick', { p_limit: 100 }),
    (error) => {
      assert.ok(error instanceof SupabaseError);
      assert.equal(error.code, 'database_unavailable');
      assert.equal(error.status, 401);
      assert.match(error.message, /4xx/);
      assert.ok(!error.message.includes('private body'));
      return true;
    },
  );
  assert.equal(calls.length, 2, 'persistent secret-key 401 must fail after one retry');
}

{
  const calls = [];
  const client = createSupabaseClient(legacyEnv, makeFetch([
    Response.json({ message: 'legacy rejection' }, { status: 401 }),
    Response.json({ should_not_be_reached: true }),
  ], calls));

  await assert.rejects(
    client.rpc('service_run_automation_tick', { p_limit: 100 }),
    (error) => error instanceof SupabaseError && error.status === 401,
  );
  assert.equal(calls.length, 1, 'legacy service-role 401 must not be retried');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${legacyEnv.SUPABASE_SERVICE_ROLE_KEY}`);
}

for (const status of [400, 403, 404, 429, 500, 503]) {
  const calls = [];
  const client = createSupabaseClient(secretEnv, makeFetch([
    Response.json({ message: `private ${status} body` }, { status }),
    Response.json({ should_not_be_reached: true }),
  ], calls));

  await assert.rejects(
    client.rpc('service_run_automation_tick', { p_limit: 100 }),
    (error) => error instanceof SupabaseError && error.status === status,
  );
  assert.equal(calls.length, 1, `HTTP ${status} must not be retried`);
}

console.log('Supabase secret-key 401 retry tests passed.');
