// WhatsApp outbox drain tests.
//
// Meta is mocked at the transport boundary: one injected `fetchImpl` answers
// both Supabase RPCs and graph.facebook.com, records every call, and throws on
// any URL the drain was not supposed to touch. No network request is made and
// no credential exists — the fixtures are obviously-synthetic strings.

import assert from 'node:assert/strict';
import { bindingNameFor } from '../workers/lib/provider-routing.js';
import {
  drainWhatsappOutbox,
  drainWhatsappOutboxById,
  __testing,
} from '../workers/lib/whatsapp-drain.js';

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const VLADIMIR_KEY = 'vladimir-production';
const KRISTINA_KEY = 'kristina-production';

const vladimirPhoneNumberId = '100000000000001';
const vladimirToken = 'unit-test-vladimir-access-token';
const kristinaPhoneNumberId = '100000000000002';
const kristinaToken = 'unit-test-kristina-access-token';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  [bindingNameFor('whatsapp', VLADIMIR_KEY)]: JSON.stringify({
    phoneNumberId: vladimirPhoneNumberId,
    accessToken: vladimirToken,
    wabaId: 'unit-test-vladimir-waba',
    appSecret: 'unit-test-vladimir-app-secret',
  }),
  [bindingNameFor('whatsapp', KRISTINA_KEY)]: JSON.stringify({
    phoneNumberId: kristinaPhoneNumberId,
    accessToken: kristinaToken,
    wabaId: 'unit-test-kristina-waba',
    appSecret: 'unit-test-kristina-app-secret',
  }),
};

const VLADIMIR_OUTBOX = '9e111111-1111-4111-8111-111111111111';
const KRISTINA_OUTBOX = '9e222222-2222-4222-8222-222222222222';

function claimedJob(overrides = {}) {
  return {
    outbox_id: VLADIMIR_OUTBOX,
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    kind: 'whatsapp_message',
    whatsapp_message_id: '9d111111-1111-4111-8111-111111111111',
    conversation_id: '9c111111-1111-4111-8111-111111111111',
    integration_key: VLADIMIR_KEY,
    contact_wa_id: '447700900001',
    body: 'Thanks for getting in touch about your sleeve.',
    attempt_count: 0,
    max_attempts: 8,
    job_valid: true,
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    outbox_id: VLADIMIR_OUTBOX,
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    kind: 'whatsapp_message',
    integration_type: 'whatsapp',
    provider: 'meta_cloud_api',
    integration_key: VLADIMIR_KEY,
    external_account_label: 'Synthetic Vladimir WhatsApp',
    configuration: { coexistence: true },
    ...overrides,
  };
}

const kristinaJob = claimedJob({
  outbox_id: KRISTINA_OUTBOX,
  artist_id: 'a2222222-2222-4222-8222-222222222222',
  whatsapp_message_id: '9d222222-2222-4222-8222-222222222222',
  conversation_id: '9c222222-2222-4222-8222-222222222222',
  integration_key: KRISTINA_KEY,
  contact_wa_id: '447700900002',
});
const kristinaRoute = route({
  outbox_id: KRISTINA_OUTBOX,
  artist_id: 'a2222222-2222-4222-8222-222222222222',
  integration_key: KRISTINA_KEY,
  external_account_label: 'Synthetic Kristina WhatsApp',
});

function makeFetch({
  claim = [claimedJob()],
  automaticClaim = claim,
  resolvedRoute = [route()],
  routesByOutbox = {},
  graphStatus = 200,
  graphBody = { messages: [{ id: 'wamid.SYNTHETICSEND0001' }] },
  acknowledgementStatus = 200,
} = {}) {
  const rpcCalls = [];
  const graphCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_whatsapp_outbox_by_id') return Response.json(claim);
      if (name === 'claim_whatsapp_outbox') return Response.json(automaticClaim);
      if (name === 'resolve_outbox_route') {
        return Response.json(routesByOutbox[args.p_outbox_id] ?? resolvedRoute);
      }
      if (name === 'record_whatsapp_outbox_result') {
        return Response.json({
          outbox_id: args.p_outbox_id,
          status: args.p_succeeded ? 'succeeded' : 'failed',
        }, { status: acknowledgementStatus });
      }
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith('https://graph.facebook.com/')) {
      graphCalls.push({
        url: value,
        authorization: init.headers?.Authorization,
        body: JSON.parse(init.body || '{}'),
      });
      return Response.json(graphBody, { status: graphStatus });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  return { fetchImpl, rpcCalls, graphCalls };
}

await test('a successful send acknowledges with the provider message id', async () => {
  const { fetchImpl, rpcCalls, graphCalls } = makeFetch();
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });

  assert.deepEqual(result, { claimed: true, outboxId: VLADIMIR_OUTBOX, outcome: 'succeeded' });
  assert.equal(graphCalls.length, 1);
  assert.equal(
    graphCalls[0].url,
    `https://graph.facebook.com/v25.0/${vladimirPhoneNumberId}/messages`
  );
  assert.equal(graphCalls[0].body.messaging_product, 'whatsapp');
  assert.equal(graphCalls[0].body.to, '447700900001');
  assert.equal(graphCalls[0].body.text.body, 'Thanks for getting in touch about your sleeve.');
  assert.equal(graphCalls[0].body.text.preview_url, false);

  const ack = rpcCalls.find((call) => call.name === 'record_whatsapp_outbox_result');
  assert.equal(ack.args.p_succeeded, true);
  assert.equal(ack.args.p_provider_message_id, 'wamid.SYNTHETICSEND0001');
  assert.equal(ack.args.p_error_code, null);
});

await test('each artist sends through their own Meta phone number and token', async () => {
  const { fetchImpl, graphCalls } = makeFetch({
    automaticClaim: [claimedJob(), kristinaJob],
    routesByOutbox: {
      [VLADIMIR_OUTBOX]: [route()],
      [KRISTINA_OUTBOX]: [kristinaRoute],
    },
  });
  const result = await drainWhatsappOutbox(env, { fetchImpl });

  assert.deepEqual(result, { claimed: 2, succeeded: 2, failed: 0, unrecorded: 0 });
  assert.equal(graphCalls.length, 2);
  assert.ok(graphCalls[0].url.includes(vladimirPhoneNumberId));
  assert.equal(graphCalls[0].authorization, `Bearer ${vladimirToken}`);
  assert.ok(graphCalls[1].url.includes(kristinaPhoneNumberId));
  assert.equal(graphCalls[1].authorization, `Bearer ${kristinaToken}`);
  // Neither artist's credential may appear on the other's request.
  assert.ok(!graphCalls[0].url.includes(kristinaPhoneNumberId));
  assert.ok(!graphCalls[1].url.includes(vladimirPhoneNumberId));
});

await test('a missing artist binding fails closed without contacting Meta', async () => {
  const kristinaOnlyEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    [bindingNameFor('whatsapp', KRISTINA_KEY)]: env[bindingNameFor('whatsapp', KRISTINA_KEY)],
  };
  const { fetchImpl, rpcCalls, graphCalls } = makeFetch();
  const result = await drainWhatsappOutboxById(kristinaOnlyEnv, {
    outboxId: VLADIMIR_OUTBOX,
    fetchImpl,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_binding_missing');
  assert.equal(graphCalls.length, 0, 'no provider call may be attempted without a binding');
  const ack = rpcCalls.find((call) => call.name === 'record_whatsapp_outbox_result');
  assert.equal(ack.args.p_succeeded, false);
  assert.equal(ack.args.p_error_code, 'provider_binding_missing');
});

await test('a route naming a different artist is refused', async () => {
  const { fetchImpl, graphCalls } = makeFetch({
    resolvedRoute: [route({ artist_id: 'a2222222-2222-4222-8222-222222222222' })],
  });
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_route_invalid');
  assert.equal(graphCalls.length, 0);
});

await test('a route naming a different integration key is refused', async () => {
  const { fetchImpl, graphCalls } = makeFetch({
    resolvedRoute: [route({ integration_key: KRISTINA_KEY })],
  });
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_route_invalid');
  assert.equal(graphCalls.length, 0, 'a mismatched key must never reach the other artist');
});

await test('an invalid claimed job is failed without a provider call', async () => {
  for (const [label, overrides] of [
    ['job_valid false', { job_valid: false }],
    ['empty body', { body: '   ' }],
    ['bad contact', { contact_wa_id: 'not-a-number' }],
    ['bad integration key', { integration_key: 'Vladimir Production' }],
    ['wrong kind', { kind: 'telegram_notification' }],
  ]) {
    const { fetchImpl, graphCalls } = makeFetch({ claim: [claimedJob(overrides)] });
    const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
    assert.equal(result.outcome, 'failed', label);
    assert.equal(result.errorCode, 'whatsapp_job_invalid', label);
    assert.equal(graphCalls.length, 0, label);
  }
});

await test('provider failures are classified into safe codes', async () => {
  for (const [status, expected] of [
    [401, 'whatsapp_credentials_rejected'],
    [403, 'whatsapp_credentials_rejected'],
    [429, 'whatsapp_rate_limited'],
    [500, 'whatsapp_provider_unavailable'],
    [400, 'whatsapp_rejected'],
  ]) {
    const { fetchImpl, rpcCalls } = makeFetch({ graphStatus: status });
    const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
    assert.equal(result.outcome, 'failed', `status ${status}`);
    assert.equal(result.errorCode, expected, `status ${status}`);
    const ack = rpcCalls.find((call) => call.name === 'record_whatsapp_outbox_result');
    assert.match(ack.args.p_error_code, /^[a-z][a-z0-9_]{2,63}$/);
  }
});

await test('a response without a message id is not treated as delivered', async () => {
  const { fetchImpl } = makeFetch({ graphBody: { messages: [] } });
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'whatsapp_response_invalid');
});

await test('a failed acknowledgement is reported as unrecorded, not as success', async () => {
  const { fetchImpl } = makeFetch({ acknowledgementStatus: 500 });
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
  assert.equal(result.outcome, 'unrecorded');
  assert.equal(result.errorCode, 'whatsapp_acknowledgement_failed');
});

await test('an unclaimed job performs no provider call', async () => {
  const { fetchImpl, graphCalls } = makeFetch({ claim: [] });
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
  assert.deepEqual(result, { claimed: false, outboxId: VLADIMIR_OUTBOX, outcome: 'not_claimed' });
  assert.equal(graphCalls.length, 0);
});

await test('exactly one message is sent per claimed job', async () => {
  const { fetchImpl, graphCalls } = makeFetch();
  await drainWhatsappOutbox(env, { fetchImpl });
  assert.equal(graphCalls.length, 1, 'a single drain pass must not duplicate a send');
});

await test('the claim batch is bounded and server-honoured', async () => {
  await assert.rejects(
    () => drainWhatsappOutbox(env, { limit: 21, fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_limit_invalid'
  );
  await assert.rejects(
    () => drainWhatsappOutbox(env, { limit: 0, fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_limit_invalid'
  );
  // A server returning more rows than requested is a protocol violation.
  const { fetchImpl } = makeFetch({ automaticClaim: [claimedJob(), kristinaJob] });
  await assert.rejects(
    () => drainWhatsappOutbox(env, { limit: 1, fetchImpl }),
    (error) => error.code === 'whatsapp_claim_invalid'
  );
});

await test('lease and worker id bounds are enforced before any claim', async () => {
  await assert.rejects(
    () => drainWhatsappOutbox(env, { leaseSeconds: 29, fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_lease_invalid'
  );
  await assert.rejects(
    () => drainWhatsappOutbox(env, { leaseSeconds: 601, fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_lease_invalid'
  );
  await assert.rejects(
    () => drainWhatsappOutbox(env, { workerId: 'BAD ID', fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_worker_id_invalid'
  );
  await assert.rejects(
    () => drainWhatsappOutboxById(env, { outboxId: 'not-a-uuid', fetchImpl: makeFetch().fetchImpl }),
    (error) => error.code === 'whatsapp_outbox_id_invalid'
  );
});

await test('the claim carries the lease the worker asked for', async () => {
  const { fetchImpl, rpcCalls } = makeFetch();
  await drainWhatsappOutbox(env, { workerId: 'whatsapp-worker-fixed', limit: 5, leaseSeconds: 90, fetchImpl });
  const claim = rpcCalls.find((call) => call.name === 'claim_whatsapp_outbox');
  assert.deepEqual(claim.args, {
    p_worker_id: 'whatsapp-worker-fixed',
    p_limit: 5,
    p_lease_seconds: 90,
  });
});

await test('no result ever carries a token, phone number id or message body', async () => {
  const { fetchImpl } = makeFetch();
  const result = await drainWhatsappOutboxById(env, { outboxId: VLADIMIR_OUTBOX, fetchImpl });
  const serialised = JSON.stringify(result);
  for (const secret of [vladimirToken, kristinaToken, vladimirPhoneNumberId, kristinaPhoneNumberId]) {
    assert.ok(!serialised.includes(secret), `result leaked ${secret}`);
  }
  assert.ok(!serialised.includes('447700900001'), 'result leaked the contact number');
  assert.ok(!serialised.includes('sleeve'), 'result leaked the message body');
});

await test('unknown errors collapse to one generic connector code', () => {
  assert.equal(__testing.safeErrorCode(new Error('boom')), 'whatsapp_connector_error');
  assert.equal(__testing.safeErrorCode({ code: 'Not A Code' }), 'whatsapp_connector_error');
  assert.equal(__testing.safeErrorCode({ code: 'whatsapp_rate_limited' }), 'whatsapp_rate_limited');
});

if (failures > 0) {
  console.error(`WhatsApp drain tests failed: ${failures} of ${passes + failures}`);
  process.exit(1);
}

console.log(
  `WhatsApp drain tests passed: ${passes} cases covering bounded claims, two-artist route isolation, `
  + 'fail-closed bindings, provider error classification, idempotent acknowledgement and secret-safe results.'
);
