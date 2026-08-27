import assert from 'node:assert/strict';
import { drainTelegramOutbox, drainTelegramOutboxById } from '../workers/lib/telegram-drain.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';
import { checkTelegramDestination } from '../workers/lib/telegram.js';

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
const secondOutboxId = 'd9122222-2222-4222-8222-222222222222';
const enquiryId = 'd9211111-1111-4111-8111-111111111111';
const secondEnquiryId = 'd9222222-2222-4222-8222-222222222222';
const vladimirId = 'a1111111-1111-4111-8111-111111111111';
const kristinaId = 'a2222222-2222-4222-8222-222222222222';
const workerId = 'telegram-worker-unit';
const botToken = 'unit-test-bot-token';
const chatId = 'unit-test-chat-id';
const kristinaBotToken = 'unit-test-kristina-token';
const kristinaChatId = 'unit-test-kristina-chat';

const vladimirKey = 'vladimir-staging';
const kristinaKey = 'kristina-staging';
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  [bindingNameFor('telegram', vladimirKey)]: JSON.stringify({ botToken, chatId }),
  [bindingNameFor('telegram', kristinaKey)]: JSON.stringify({
    botToken: kristinaBotToken,
    chatId: kristinaChatId,
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

function makeFetch({
  claim = [claimedJob()],
  automaticClaim = claim,
  resolvedRoute = [route()],
  routesByOutbox = {},
  telegramStatus = 200,
  acknowledgementStatus = 200,
} = {}) {
  const rpcCalls = [];
  const telegramCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_telegram_outbox_by_id') return Response.json(claim);
      if (name === 'claim_telegram_outbox') return Response.json(automaticClaim);
      if (name === 'resolve_outbox_route') {
        return Response.json(routesByOutbox[args.p_outbox_id] ?? resolvedRoute);
      }
      if (name === 'record_telegram_outbox_result') {
        return Response.json({
          outbox_id: args.p_outbox_id,
          status: args.p_succeeded ? 'succeeded' : 'failed',
        }, { status: acknowledgementStatus });
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

function diagnosticFetch({ getMeStatus = 200, getChatStatus = 200, returnedChatId = kristinaChatId } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, body: init.body ? JSON.parse(init.body) : null });
    if (value.endsWith('/getMe')) {
      return Response.json({ ok: getMeStatus === 200, result: { id: 190 } }, { status: getMeStatus });
    }
    if (value.endsWith('/getChat')) {
      return Response.json({ ok: getChatStatus === 200, result: { id: returnedChatId } }, { status: getChatStatus });
    }
    throw new Error(`unexpected diagnostic URL ${value}`);
  };
  return { calls, fetchImpl };
}

await test('Kristina destination preflight validates bot and exact chat without sending', async () => {
  const mock = diagnosticFetch();
  const result = await checkTelegramDestination(env, route({
    artist_id: kristinaId,
    integration_key: kristinaKey,
    external_account_label: 'Kristina CRM Staging',
  }), mock.fetchImpl);
  assert.deepEqual(result, { reachable: true });
  assert.deepEqual(mock.calls.map((call) => new URL(call.url).pathname.split('/').pop()), ['getMe', 'getChat']);
  assert.deepEqual(mock.calls[1].body, { chat_id: kristinaChatId });
  assert.ok(!JSON.stringify(result).includes(kristinaChatId));
  assert.ok(!JSON.stringify(result).includes(kristinaBotToken));
});

await test('destination preflight classifies an invalid bot token without exposing it', async () => {
  const mock = diagnosticFetch({ getMeStatus: 401 });
  const result = await checkTelegramDestination(env, route({ integration_key: kristinaKey }), mock.fetchImpl);
  assert.deepEqual(result, {
    reachable: false,
    errorCode: 'telegram_bot_token_invalid',
    statusClass: '4xx',
  });
  assert.equal(mock.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes(kristinaBotToken));
});

await test('destination preflight keeps a non-auth bot rejection distinct from chat rejection', async () => {
  const mock = diagnosticFetch({ getMeStatus: 400 });
  const result = await checkTelegramDestination(env, route({ integration_key: kristinaKey }), mock.fetchImpl);
  assert.deepEqual(result, {
    reachable: false,
    errorCode: 'telegram_bot_preflight_rejected',
    statusClass: '4xx',
  });
  assert.equal(mock.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes(kristinaBotToken));
});

await test('destination preflight distinguishes an unavailable chat without sending', async () => {
  const mock = diagnosticFetch({ getChatStatus: 400 });
  const result = await checkTelegramDestination(env, route({ integration_key: kristinaKey }), mock.fetchImpl);
  assert.deepEqual(result, {
    reachable: false,
    errorCode: 'telegram_destination_unavailable',
    statusClass: '4xx',
  });
  assert.equal(mock.calls.length, 2);
  assert.ok(!mock.calls.some((call) => call.url.endsWith('/sendMessage')));
});

await test('destination preflight keeps an unclassified chat rejection distinct from bot rejection', async () => {
  const mock = diagnosticFetch({ getChatStatus: 404 });
  const result = await checkTelegramDestination(env, route({ integration_key: kristinaKey }), mock.fetchImpl);
  assert.deepEqual(result, {
    reachable: false,
    errorCode: 'telegram_destination_rejected',
    statusClass: '4xx',
  });
  assert.equal(mock.calls.length, 2);
  assert.ok(!mock.calls.some((call) => call.url.endsWith('/sendMessage')));
});

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

await test('Kristina staging uses a distinct encrypted binding and the existing sender', async () => {
  const vladimirBinding = bindingNameFor('telegram', vladimirKey);
  const kristinaBinding = bindingNameFor('telegram', kristinaKey);
  assert.equal(vladimirBinding, 'ARTIST_TELEGRAM_VLADIMIR_HSTAGING');
  assert.equal(kristinaBinding, 'ARTIST_TELEGRAM_KRISTINA_HSTAGING');
  assert.notEqual(kristinaBinding, vladimirBinding);

  const kristinaOnlyEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    [kristinaBinding]: env[kristinaBinding],
  };
  const mock = makeFetch({
    claim: [claimedJob({ artist_id: kristinaId })],
    resolvedRoute: [route({
      artist_id: kristinaId,
      integration_key: kristinaKey,
      external_account_label: 'Kristina CRM Staging',
    })],
  });
  const result = await drainTelegramOutboxById(kristinaOnlyEnv, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.telegramCalls[0].body.chat_id, kristinaChatId);
  assert.ok(!mock.telegramCalls[0].url.includes(botToken));
  assert.ok(mock.telegramCalls[0].url.includes(kristinaBotToken));
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

await test('a missing Kristina binding cannot fall back to Vladimir', async () => {
  const vladimirOnlyEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    [bindingNameFor('telegram', vladimirKey)]: env[bindingNameFor('telegram', vladimirKey)],
  };
  const mock = makeFetch({
    claim: [claimedJob({ artist_id: kristinaId })],
    resolvedRoute: [route({ artist_id: kristinaId, integration_key: kristinaKey })],
  });
  const result = await drainTelegramOutboxById(vladimirOnlyEnv, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'provider_binding_missing');
  assert.equal(mock.telegramCalls.length, 0);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'provider_binding_missing');
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

await test('automatic drain with zero jobs calls only the bounded claim RPC', async () => {
  const mock = makeFetch({ automaticClaim: [] });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 4,
    leaseSeconds: 90,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 0, succeeded: 0, failed: 0, unrecorded: 0 });
  assert.deepEqual(mock.rpcCalls, [{
    name: 'claim_telegram_outbox',
    args: { p_worker_id: workerId, p_limit: 4, p_lease_seconds: 90 },
  }]);
  assert.equal(mock.telegramCalls.length, 0);
});

await test('automatic drain rejects a database batch larger than the requested limit', async () => {
  const mock = makeFetch({
    automaticClaim: [
      claimedJob(),
      claimedJob({ outbox_id: secondOutboxId, enquiry_id: secondEnquiryId }),
    ],
  });
  await assert.rejects(
    drainTelegramOutbox(env, { workerId, limit: 1, fetchImpl: mock.fetchImpl }),
    (error) => error.code === 'telegram_claim_invalid',
  );
  assert.equal(mock.telegramCalls.length, 0);
});

await test('automatic Vladimir job uses only the Vladimir binding', async () => {
  const mock = makeFetch();
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, unrecorded: 0 });
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.telegramCalls[0].body.chat_id, chatId);
  assert.ok(mock.telegramCalls[0].url.includes(botToken));
  assert.ok(!mock.telegramCalls[0].url.includes(kristinaBotToken));
});

await test('automatic Kristina job uses only the Kristina binding', async () => {
  const mock = makeFetch({
    automaticClaim: [claimedJob({ artist_id: kristinaId })],
    resolvedRoute: [route({ artist_id: kristinaId, integration_key: kristinaKey })],
  });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, unrecorded: 0 });
  assert.equal(mock.telegramCalls[0].body.chat_id, kristinaChatId);
  assert.ok(mock.telegramCalls[0].url.includes(kristinaBotToken));
  assert.ok(!mock.telegramCalls[0].url.includes(botToken));
});

await test('one automatic batch routes Vladimir and Kristina independently', async () => {
  const mock = makeFetch({
    automaticClaim: [
      claimedJob(),
      claimedJob({
        outbox_id: secondOutboxId,
        enquiry_id: secondEnquiryId,
        artist_id: kristinaId,
        reference_number: 'ENQ-2026-9002',
      }),
    ],
    routesByOutbox: {
      [outboxId]: [route()],
      [secondOutboxId]: [route({
        outbox_id: secondOutboxId,
        artist_id: kristinaId,
        integration_key: kristinaKey,
      })],
    },
  });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 2,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 2, succeeded: 2, failed: 0, unrecorded: 0 });
  assert.deepEqual(mock.telegramCalls.map((call) => call.body.chat_id), [chatId, kristinaChatId]);
  assert.deepEqual(
    mock.rpcCalls.filter((call) => call.name === 'record_telegram_outbox_result')
      .map((call) => [call.args.p_outbox_id, call.args.p_succeeded]),
    [[outboxId, true], [secondOutboxId, true]],
  );
});

await test('automatic Kristina job cannot fall back to a Vladimir binding', async () => {
  const vladimirOnlyEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    [bindingNameFor('telegram', vladimirKey)]: env[bindingNameFor('telegram', vladimirKey)],
  };
  const mock = makeFetch({
    automaticClaim: [claimedJob({ artist_id: kristinaId })],
    resolvedRoute: [route({ artist_id: kristinaId, integration_key: kristinaKey })],
  });
  const result = await drainTelegramOutbox(vladimirOnlyEnv, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, unrecorded: 0 });
  assert.equal(mock.telegramCalls.length, 0);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'provider_binding_missing');
});

await test('automatic Vladimir job cannot fall back to a Kristina binding', async () => {
  const kristinaOnlyEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    [bindingNameFor('telegram', kristinaKey)]: env[bindingNameFor('telegram', kristinaKey)],
  };
  const mock = makeFetch();
  const result = await drainTelegramOutbox(kristinaOnlyEnv, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, unrecorded: 0 });
  assert.equal(mock.telegramCalls.length, 0);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'provider_binding_missing');
});

await test('automatic artist mismatch fails closed and is acknowledged false', async () => {
  const mock = makeFetch({
    resolvedRoute: [route({ artist_id: kristinaId, integration_key: kristinaKey })],
  });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, unrecorded: 0 });
  assert.equal(mock.telegramCalls.length, 0);
  assert.deepEqual(mock.rpcCalls.at(-1).args, {
    p_outbox_id: outboxId,
    p_worker_id: workerId,
    p_succeeded: false,
    p_error_code: 'provider_route_invalid',
  });
});

await test('automatic invalid projection never sends and is acknowledged false', async () => {
  const mock = makeFetch({ automaticClaim: [claimedJob({ job_valid: false })] });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, unrecorded: 0 });
  assert.equal(mock.telegramCalls.length, 0);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'telegram_job_invalid');
});

await test('automatic provider failure is acknowledged false', async () => {
  const mock = makeFetch({ telegramStatus: 502 });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, unrecorded: 0 });
  assert.equal(mock.rpcCalls.at(-1).args.p_succeeded, false);
  assert.equal(mock.rpcCalls.at(-1).args.p_error_code, 'telegram_rejected');
});

await test('provider success with acknowledgement failure is reported unrecorded', async () => {
  const mock = makeFetch({ acknowledgementStatus: 503 });
  const result = await drainTelegramOutbox(env, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 0, unrecorded: 1 });
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.rpcCalls.at(-1).args.p_succeeded, true);
});

await test('automatic aggregate and console output contain no provider credentials', async () => {
  const mock = makeFetch();
  const messages = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => messages.push(args.join(' '));
  console.warn = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  let result;
  try {
    result = await drainTelegramOutbox(env, {
      workerId,
      limit: 1,
      fetchImpl: mock.fetchImpl,
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const evidence = JSON.stringify({ result, messages });
  assert.ok(!evidence.includes(botToken));
  assert.ok(!evidence.includes(chatId));
  assert.ok(!evidence.includes(kristinaBotToken));
  assert.ok(!evidence.includes(kristinaChatId));
  assert.equal(messages.length, 1);
  const diagnostic = JSON.parse(messages[0]);
  assert.equal(diagnostic.event, 'supabase_backend_response');
  assert.equal(diagnostic.rpc, 'claim_telegram_outbox');
  assert.equal(diagnostic.status, 200);
});

if (failures) {
  console.error(`\n${failures} Telegram drain test(s) failed, ${passes} passed.`);
  process.exit(1);
}

console.log(`Telegram drain tests passed: ${passes} exact-ID and automatic cases covering bounded claims, lease acknowledgement, existing sender use, two-artist route isolation, provider failure, invalid projection and secret-safe results.`);
