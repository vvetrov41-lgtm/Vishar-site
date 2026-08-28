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
      redirect: init.redirect,
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

// The existing retry is observed, not evidence that the auth failure is fixed.
const { createBackendResponseObserver, readSafeSupabaseError, sanitizeBackendDiagnostic } =
  await import('../workers/lib/supabase-diagnostics.js');
const { createGmailSupabase } = await import('../workers/lib/gmail-supabase.js');
const messages = [];
const log = console.log;
console.log = line => messages.push(line);
try {
  const calls = [];
  const privateText = 'private-client@example.test private-message';
  const id = '12345678-abcd-4abc-8abc-123456789012';
  const client = createSupabaseClient(secretEnv, makeFetch([
    Response.json({ code: 'PGRST303', message: 'JWT expired', details: privateText, credential: secretEnv.SUPABASE_SECRET_KEY },
      { status: 401, headers: {
        'sb-request-id': id,
        'cf-ray': '1234567890abcdef-LHR',
        'x-request-id': privateText,
        'sb-gateway-version': '2',
        'x-sb-error-code': 'bad_jwt',
      } }),
    Response.json([{ ok: true, privateText }], { headers: { 'sb-gateway-version': '1' } }),
  ], calls));
  assert.deepEqual(await client.rpc('service_run_automation_tick', { customer: privateText }), [{ ok: true, privateText }]);
  assert.equal(calls.length, 2);
  const rows = messages.map(x => JSON.parse(x));
  assert.deepEqual(rows.map(x => [x.status, x.attempt]), [[401, 1], [200, 2]]);
  assert.equal(rows[0].supabase_code, 'PGRST303');
  assert.equal(rows[0].auth_reason, 'jwt_expired');
  assert.equal(rows[0].sb_gateway_version, '2');
  assert.equal(rows[0].x_sb_error_code, 'bad_jwt');
  assert.equal(rows[0].sb_request_id, id);
  assert.equal(rows[0].request_id, null);
  assert.equal(rows[0].cf_ray, '1234567890abcdef-lhr');
  assert.equal(rows[0].classification, 'unauthorized');
  assert.equal(rows[1].body_state, 'not_read');
  assert.equal(rows[1].sb_gateway_version, '1');
  assert.equal(rows[1].x_sb_error_code, null);
  for (const forbidden of [privateText, secretEnv.SUPABASE_SECRET_KEY, 'authorization', 'apikey', 'credential']) {
    assert.ok(!messages.join('').toLowerCase().includes(forbidden.toLowerCase()));
  }
  assert.equal(sanitizeBackendDiagnostic({ ...rows[0], rpc: 'toString' }), null);
  const projected = sanitizeBackendDiagnostic({ ...rows[0], task: privateText, classification: privateText,
    request_id: secretEnv.SUPABASE_SECRET_KEY, supabase_code: privateText, auth_reason: privateText,
    sb_gateway_version: privateText, x_sb_error_code: privateText, payload: privateText });
  assert.equal(projected.task, 'automation_tick');
  assert.equal(projected.supabase_code, null);
  assert.equal(projected.sb_gateway_version, null);
  assert.equal(projected.x_sb_error_code, null);
  assert.ok(!JSON.stringify(projected).includes(privateText));
  assert.equal((await readSafeSupabaseError(Response.json({ code: privateText, message: privateText }, { status: 401 }))).supabase_code, null);
  assert.equal((await readSafeSupabaseError(new Response('<html>private</html>', { status: 401 }))).body_state, 'not_json');
  assert.equal((await readSafeSupabaseError(new Response('{broken', { status: 401, headers: { 'content-type': 'application/json' } }))).body_state, 'unavailable');
  assert.equal((await readSafeSupabaseError(Response.json({ message: 'x'.repeat(5000) }, { status: 401 }))).body_state, 'too_large');
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401, headers: { 'content-type': 'application/json' } });
  assert.equal((await readSafeSupabaseError(stalled)).body_state, 'timeout');
  assert.equal(cancelled, true);
  const capped = [];
  const observer = createBackendResponseObserver('shared_backend', 'legacy_service_role', x => capped.push(x));
  for (let i = 0; i < 20; i++) await observer('claim_telegram_outbox', Response.json([]), Date.now());
  assert.equal(capped.length, 16);
  assert.equal(JSON.parse(capped[0]).key_kind, 'legacy_service_role');
  await createBackendResponseObserver('shared_backend', 'secret', () => { throw Error('sink'); })('claim_telegram_outbox', Response.json([]), Date.now());

  const gmailEnv = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SECRET_KEY: secretEnv.SUPABASE_SECRET_KEY,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
  };
  const gmail = createGmailSupabase(gmailEnv,
    async () => Response.json({ code: '42501', message: privateText }, { status: 403 }));
  const before = messages.length;
  await assert.rejects(gmail.backendRpc('claim_email_outbox', {}), e => e.status === 403 && e.code === '42501');
  assert.equal(messages.length, before + 1);
  assert.equal(JSON.parse(messages.at(-1)).client, 'gmail_backend');
  assert.equal(JSON.parse(messages.at(-1)).classification, 'forbidden');
  await assert.rejects(gmail.userRpc('gpt_authorize_gmail_enquiry', {}, 'test-user-bearer-token'), e => e.status === 403);
  assert.equal(messages.length, before + 1, 'user RPC must never emit backend telemetry');

  const gmailRetryCalls = [];
  const retryBefore = messages.length;
  const gmailRetry = createGmailSupabase(gmailEnv, makeFetch([
    Response.json({ code: 'PGRST303', message: 'JWT expired', details: privateText }, { status: 401 }),
    Response.json([{ id: 'email-outbox-synthetic' }]),
  ], gmailRetryCalls));
  assert.deepEqual(await gmailRetry.backendRpc('claim_email_outbox', { p_limit: 5 }), [{ id: 'email-outbox-synthetic' }]);
  assert.equal(gmailRetryCalls.length, 2, 'Gmail backend secret-key 401 must receive exactly one retry');
  for (const call of gmailRetryCalls) {
    assert.equal(call.url, `${gmailEnv.SUPABASE_URL}/rest/v1/rpc/claim_email_outbox`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('apikey'), gmailEnv.SUPABASE_SECRET_KEY);
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.body, JSON.stringify({ p_limit: 5 }));
    assert.equal(call.redirect, 'manual');
  }
  const gmailRetryRows = messages.slice(retryBefore).map(x => JSON.parse(x));
  assert.deepEqual(gmailRetryRows.map(x => [x.client, x.status, x.attempt]), [
    ['gmail_backend', 401, 1],
    ['gmail_backend', 200, 2],
  ]);

  const persistentCalls = [];
  const persistentBefore = messages.length;
  const gmailPersistent = createGmailSupabase(gmailEnv, makeFetch([
    Response.json({ code: 'PGRST303', message: 'JWT expired' }, { status: 401 }),
    Response.json({ code: 'PGRST303', message: 'JWT expired' }, { status: 401 }),
  ], persistentCalls));
  await assert.rejects(
    gmailPersistent.backendRpc('claim_email_outbox', { p_limit: 5 }),
    e => e.message === 'gmail_rpc_forbidden' && e.status === 401 && e.code === 'PGRST303',
  );
  assert.equal(persistentCalls.length, 2, 'persistent Gmail backend 401 must fail after one retry');
  const persistentRows = messages.slice(persistentBefore).map(x => JSON.parse(x));
  assert.deepEqual(persistentRows.map(x => [x.status, x.attempt]), [[401, 1], [401, 2]]);

  for (const status of [403, 429, 500]) {
    const non401Calls = [];
    const non401 = createGmailSupabase(gmailEnv, makeFetch([
      Response.json({ code: '42501', message: privateText }, { status }),
      Response.json({ should_not_be_reached: true }),
    ], non401Calls));
    await assert.rejects(non401.backendRpc('claim_email_outbox', {}), e => e.status === status);
    assert.equal(non401Calls.length, 1, `Gmail backend HTTP ${status} must not be retried`);
  }

  let networkCalls = 0;
  const gmailNetwork = createGmailSupabase(gmailEnv, async () => {
    networkCalls += 1;
    throw new Error('synthetic network failure');
  });
  await assert.rejects(gmailNetwork.backendRpc('claim_email_outbox', {}), /synthetic network failure/);
  assert.equal(networkCalls, 1, 'ambiguous Gmail backend network failure must not be retried');

  const user401Calls = [];
  const user401Before = messages.length;
  const gmailUser401 = createGmailSupabase(gmailEnv, makeFetch([
    Response.json({ code: 'PGRST303', message: privateText }, { status: 401 }),
    Response.json({ should_not_be_reached: true }),
  ], user401Calls));
  await assert.rejects(
    gmailUser401.userRpc('gpt_authorize_gmail_enquiry', {}, 'test-user-bearer-token'),
    e => e.status === 401 && e.message === 'gmail_rpc_forbidden',
  );
  assert.equal(user401Calls.length, 1, 'Gmail user RPC 401 must not be retried');
  assert.equal(messages.length, user401Before, 'Gmail user RPC must not emit backend telemetry');
  assert.ok(!messages.join('').includes(privateText));
} finally { console.log = log; }
console.log('Backend auth diagnostics privacy, attempt, body-limit and Gmail tests passed.');
