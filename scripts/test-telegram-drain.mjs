import assert from 'node:assert/strict';
import { drainTelegramOutboxById } from '../workers/lib/telegram-drain.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';

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

const outboxId = 'd9111111-1111-4111-8111-111111111111';
const enquiryId = 'd9211111-1111-4111-8111-111111111111';
const vladimirId = 'a1111111-1111-4111-8111-111111111111';
const kristinaId = 'a2222222-2222-4222-8222-222222222222';
const workerId = 'telegram-worker-unit';
const botToken = 'unit-test-bot-token';
const chatId = 'unit-test-chat-id';

const vladimirKey = 'telegram_vladimir';
const kristinaKey = 'telegram_kristina';
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  [bindingNameFor('telegram', vladimirKey)]: JSON.stringify({ botToken, chatId }),
  [bindingNameFor('telegram', kristinaKey)]: JSON.stringify({
    botToken: 'unit-test-kristina-token',
    chatId: 'unit-test-kristina-chat',
  }),
};

function claimedJob(overrides = {}) {
  return {
    outbox_id: outboxId,
    artist_id: vladimirId,
    kind: 'telegram_notification',
    enquiry_id: enquiryId,
    attempt_count: 1,
    max_attempts: 8,
    reference_number: 'ENQ-2026-9001',
    file_count: 2,
    client_conflict: true,
    job_valid: true,
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    outbox_id: outboxId,
    artist_id: vladimirId,
    kind: 'telegram_notification',
    integration_type: 'telegram',
    provider: 'telegram',
    integration_key: vladimirKey,
    external_account_label: 'Vladimir staging Telegram',
    configuration: {},
    ...overrides,
  };
}

function makeFetch({ claim = [claimedJob()], resolvedRoute = [route()], telegramStatus = 200 } = {}) {
  const rpcCalls = [];
  const telegramCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_telegram_outbox_by_id') return Response.json(claim);
      if (name === 'resolve_outbox_route') return Response.json(resolvedRoute);
      if (name === 'record_telegram_outbox_result') {
        return Response.json({
          outbox_id: args.p_outbox_id,
          status: args.p_succeeded ? 'succeeded' : 'failed',
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith('https://api.telegram.org/bot')) {
      telegramCalls.push({ url: value, body: JSON.parse(init.body || '{}') });
      return Response.json({ ok: telegramStatus >= 200 && telegramStatus < 300 }, {
        status: telegramStatus,
      });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  return { fetchImpl, rpcCalls, telegramCalls };
}

await test('one explicit UUID is claimed, routed, sent and acknowledged by the same worker', async () => {
  const mock = makeFetch();
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    leaseSeconds: 120,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), [
    'claim_telegram_outbox_by_id',
    'resolve_outbox_route',
    'record_telegram_outbox_result',
  ]);
  assert.deepEqual(mock.rpcCalls[0].args, {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_lease_seconds: 120,
  });
  assert.equal(mock.rpcCalls[1].args.p_outbox_id, outboxId);
  assert.deepEqual(mock.rpcCalls[2].args, {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_succeeded: true,
    p_error_code: null,
  });
  assert.equal(mock.telegramCalls.length, 1);
  assert.match(mock.telegramCalls[0].body.text, /Reference: ENQ-2026-9001/);
  assert.match(mock.telegramCalls[0].body.text, /Reference images: 2/);
  assert.match(mock.telegramCalls[0].body.text, /matched two different client records/);
  assert.equal(mock.telegramCalls[0].body.chat_id, chatId);
});

await test('the module has no broad Telegram claim and a non-claimed job is never sent', async () => {
  const mock = makeFetch({ claim: [] });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'not_claimed');
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), ['claim_telegram_outbox_by_id']);
  assert.equal(mock.telegramCalls.length, 0);
  assert.ok(!mock.rpcCalls.some((call) => /claim_telegram_outbox$/.test(call.name)));
});

await test('a provider rejection is recorded through the lease-aware result RPC', async () => {
  const mock = makeFetch({ telegramStatus: 502 });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'telegram_rejected');
  const acknowledgement = mock.rpcCalls.at(-1);
  assert.equal(acknowledgement.name, 'record_telegram_outbox_result');
  assert.deepEqual(acknowledgement.args, {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_succeeded: false,
    p_error_code: 'telegram_rejected',
  });
});

await test('an artist mismatch fails closed without using another artist binding', async () => {
  const mock = makeFetch({
    resolvedRoute: [route({
      artist_id: kristinaId,
      integration_key: kristinaKey,
      external_account_label: 'Kristina staging Telegram',
    })],
  });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_route_invalid');
  assert.equal(mock.telegramCalls.length, 0);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'provider_route_invalid');
});

await test('a missing artist binding has no global credential fallback', async () => {
  const noBindingEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    TELEGRAM_BOT_TOKEN: ['forbidden', 'global', 'fallback'].join('-'),
    TELEGRAM_CHAT_ID: 'forbidden-global-chat',
  };
  const mock = makeFetch();
  const result = await drainTelegramOutboxById(noBindingEnv, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_binding_missing');
  assert.equal(mock.telegramCalls.length, 0);
});

await test('an invalid authoritative projection is acknowledged safely and never sent', async () => {
  const mock = makeFetch({ claim: [claimedJob({ job_valid: false })] });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'telegram_job_invalid');
  assert.equal(mock.telegramCalls.length, 0);
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), [
    'claim_telegram_outbox_by_id',
    'record_telegram_outbox_result',
  ]);
});

await test('credentials do not appear in the drain result or console output', async () => {
  const mock = makeFetch();
  const messages = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => messages.push(args.join(' '));
  console.warn = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  let result;
  try {
    result = await drainTelegramOutboxById(env, {
      outboxId,
      workerId,
      fetchImpl: mock.fetchImpl,
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const safeEvidence = JSON.stringify({ result, messages });
  assert.ok(!safeEvidence.includes(botToken));
  assert.ok(!safeEvidence.includes(chatId));
  assert.deepEqual(messages, []);
});

if (failures) {
  console.error(`\n${failures} Telegram drain test(s) failed, ${passes} passed.`);
  process.exit(1);
}

console.log(`Telegram drain tests passed: ${passes} exact-ID cases covering lease acknowledgement, existing sender use, route isolation, provider failure, invalid projection and secret-safe results.`);
