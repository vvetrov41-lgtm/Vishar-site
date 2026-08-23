import assert from 'node:assert/strict';
import {
  drainPersonalTelegramNotifications,
  drainTelegramOutboxById,
} from '../workers/lib/telegram-drain.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';
import worker, { __testing as workerTesting } from '../workers/telegram-drain-worker.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

const outboxId = 'fa110000-0000-4000-8000-000000000001';
const enquiryId = 'fa120000-0000-4000-8000-000000000001';
const artistId = 'fa130000-0000-4000-8000-000000000001';
const profileId = 'fa140000-0000-4000-8000-000000000001';
const deliveryId = 'fa150000-0000-4000-8000-000000000001';
const notificationId = 'fa160000-0000-4000-8000-000000000001';
const destinationId = 'fa170000-0000-4000-8000-000000000001';
const workerId = 'telegram-worker-self-service';
const legacyKey = 'vladimir-production';
const legacyToken = 'legacy-unit-token';
const legacyChat = '400001';
const sharedToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const registryChat = '-100500001';
const personalChat = '500002';
const webhookSecret = 'telegramWebhookSecret_1234567890';
const linkToken = '0123456789abcdef0123456789abcdef';
const webhookUrl = 'https://telegram.example.test/webhook';

const baseEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  [bindingNameFor('telegram', legacyKey)]: JSON.stringify({
    botToken: legacyToken,
    chatId: legacyChat,
  }),
};

function job() {
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind: 'telegram_notification',
    enquiry_id: enquiryId,
    attempt_count: 0,
    max_attempts: 8,
    reference_number: 'ENQ-2026-9901',
    file_count: 1,
    client_conflict: false,
    job_valid: true,
  };
}

function route() {
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind: 'telegram_notification',
    integration_type: 'telegram',
    provider: 'telegram',
    integration_key: legacyKey,
    external_account_label: 'Legacy Telegram',
    configuration: {},
  };
}

function makeFetch({
  destination = [],
  personalClaim = [],
  rpcFailure = null,
  telegramStatus = 200,
} = {}) {
  const rpcCalls = [];
  const telegramCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (rpcFailure === name) return Response.json({ code: 'PGRST500' }, { status: 500 });
      if (name === 'claim_telegram_outbox_by_id') return Response.json([job()]);
      if (name === 'resolve_outbox_route') return Response.json([route()]);
      if (name === 'service_resolve_telegram_destination') return Response.json(destination);
      if (name === 'record_telegram_outbox_result') return Response.json({ ok: true });
      if (name === 'service_claim_telegram_notifications') return Response.json(personalClaim);
      if (name === 'service_record_telegram_notification_result') return Response.json({ ok: true });
      if (name === 'service_complete_telegram_link') return Response.json({ connected: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith('https://api.telegram.org/bot')) {
      telegramCalls.push({ url: value, body: init.body ? JSON.parse(init.body) : null });
      return Response.json(
        telegramStatus >= 200 && telegramStatus < 300 ? { ok: true } : { ok: false },
        { status: telegramStatus },
      );
    }
    throw new Error(`unexpected URL ${value}`);
  };
  return { fetchImpl, rpcCalls, telegramCalls };
}

await test('shared bot prefers a private registry Artist destination and records registry success', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({
    destination: [{
      destination_id: destinationId,
      destination_kind: 'artist',
      chat_id: registryChat,
    }],
  });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), [
    'claim_telegram_outbox_by_id',
    'resolve_outbox_route',
    'service_resolve_telegram_destination',
    'service_record_telegram_notification_result',
    'record_telegram_outbox_result',
  ]);
  assert.deepEqual(mock.rpcCalls[3].args, {
    p_delivery_id: destinationId,
    p_worker_id: workerId,
    p_succeeded: true,
    p_error_code: null,
  });
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.telegramCalls[0].body.chat_id, registryChat);
  assert.ok(mock.telegramCalls[0].url.includes(sharedToken));
  assert.ok(!mock.telegramCalls[0].url.includes(legacyToken));
});

await test('registry provider failure records registry failure before outbox failure', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({
    destination: [{
      destination_id: destinationId,
      destination_kind: 'artist',
      chat_id: registryChat,
    }],
    telegramStatus: 502,
  });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), [
    'claim_telegram_outbox_by_id',
    'resolve_outbox_route',
    'service_resolve_telegram_destination',
    'service_record_telegram_notification_result',
    'record_telegram_outbox_result',
  ]);
  assert.deepEqual(mock.rpcCalls[3].args, {
    p_delivery_id: destinationId,
    p_worker_id: workerId,
    p_succeeded: false,
    p_error_code: 'telegram_rejected',
  });
  assert.equal(mock.rpcCalls[4].args.p_succeeded, false);
});

await test('registry evidence failure never converts an accepted Telegram send into a retry', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({
    destination: [{
      destination_id: destinationId,
      destination_kind: 'artist',
      chat_id: registryChat,
    }],
    rpcFailure: 'service_record_telegram_notification_result',
  });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.rpcCalls.at(-1).name, 'record_telegram_outbox_result');
  assert.equal(mock.rpcCalls.at(-1).args.p_succeeded, true);
});

await test('no registry row keeps the exact legacy binding fallback', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({ destination: [] });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(mock.telegramCalls[0].body.chat_id, legacyChat);
  assert.ok(mock.telegramCalls[0].url.includes(legacyToken));
  assert.ok(!mock.rpcCalls.some((call) => call.name === 'service_record_telegram_notification_result'));
});

await test('registry lookup failure also preserves the rollout fallback', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({ rpcFailure: 'service_resolve_telegram_destination' });
  const result = await drainTelegramOutboxById(env, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(mock.telegramCalls[0].body.chat_id, legacyChat);
  assert.ok(mock.telegramCalls[0].url.includes(legacyToken));
  assert.ok(!mock.rpcCalls.some((call) => call.name === 'service_record_telegram_notification_result'));
});

await test('without a shared bot token the legacy path makes no registry call', async () => {
  const mock = makeFetch({ destination: [{
    destination_id: destinationId,
    destination_kind: 'artist',
    chat_id: registryChat,
  }] });
  const result = await drainTelegramOutboxById(baseEnv, {
    outboxId,
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.outcome, 'succeeded');
  assert.ok(!mock.rpcCalls.some((call) => call.name === 'service_resolve_telegram_destination'));
  assert.ok(!mock.rpcCalls.some((call) => call.name === 'service_record_telegram_notification_result'));
  assert.equal(mock.telegramCalls[0].body.chat_id, legacyChat);
});

await test('personal notification delivery requires the one shared bot token', async () => {
  const mock = makeFetch({ personalClaim: [{
    delivery_id: deliveryId,
    notification_id: notificationId,
    profile_id: profileId,
    chat_id: personalChat,
    title: 'Consultation reminder',
    body: 'Tomorrow at 10:00',
    priority: 'normal',
    artist_id: artistId,
    workspace_id: null,
  }] });
  const skipped = await drainPersonalTelegramNotifications(baseEnv, {
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.claimed, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

await test('personal notification is leased, sent and acknowledged through narrow RPCs', async () => {
  const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: sharedToken };
  const mock = makeFetch({ personalClaim: [{
    delivery_id: deliveryId,
    notification_id: notificationId,
    profile_id: profileId,
    chat_id: personalChat,
    title: 'Consultation reminder',
    body: 'Tomorrow at 10:00',
    priority: 'normal',
    artist_id: artistId,
    workspace_id: null,
  }] });
  const result = await drainPersonalTelegramNotifications(env, {
    workerId,
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, {
    claimed: 1,
    succeeded: 1,
    failed: 0,
    unrecorded: 0,
    skipped: false,
  });
  assert.deepEqual(mock.rpcCalls.map((call) => call.name), [
    'service_claim_telegram_notifications',
    'service_record_telegram_notification_result',
  ]);
  assert.equal(mock.telegramCalls.length, 1);
  assert.equal(mock.telegramCalls[0].body.chat_id, personalChat);
  assert.equal(mock.telegramCalls[0].body.text, 'Consultation reminder\n\nTomorrow at 10:00');
  assert.ok(mock.telegramCalls[0].url.includes(sharedToken));
  assert.deepEqual(mock.rpcCalls[1].args, {
    p_delivery_id: deliveryId,
    p_worker_id: workerId,
    p_succeeded: true,
    p_error_code: null,
  });
});

await test('linking parser and route accept only bounded Telegram input', async () => {
  assert.equal(workerTesting.isWebhookPath(new Request(webhookUrl)), true);
  assert.equal(workerTesting.isWebhookPath(new Request('https://telegram.example.test/')), false);
  assert.equal(workerTesting.isWebhookPath(new Request(`${webhookUrl}?x=1`)), false);
  assert.deepEqual(workerTesting.linkingMessage({
    message: { text: `/start ${linkToken}`, chat: { id: 600001, type: 'private' } },
  }), { token: linkToken, chatId: '600001', chatType: 'private' });
  assert.deepEqual(workerTesting.linkingMessage({
    message: { text: `/start@VisharBot ${linkToken}`, chat: { id: -100600002, type: 'supergroup' } },
  }), { token: linkToken, chatId: '-100600002', chatType: 'supergroup' });
  assert.equal(workerTesting.linkingMessage({
    message: { text: '/start short', chat: { id: 1, type: 'private' } },
  }), null);
  assert.equal(workerTesting.linkingMessage({
    message: { text: `/start ${linkToken}`, chat: { id: 1, type: 'channel' } },
  }), null);
});

await test('dormant linking endpoint is 404 even on the exact webhook path', async () => {
  const response = await worker.fetch(new Request(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }), baseEnv);
  assert.equal(response.status, 404);
});

await test('enabled linking still refuses every path except exact /webhook', async () => {
  const env = {
    ...baseEnv,
    TELEGRAM_LINKING_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_BOT_TOKEN: sharedToken,
  };
  const response = await worker.fetch(new Request('https://telegram.example.test/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': webhookSecret,
    },
    body: JSON.stringify({
      message: { text: `/start ${linkToken}`, chat: { id: 600001, type: 'private' } },
    }),
  }), env);
  assert.equal(response.status, 404);
});

await test('linking webhook rejects a request without the Telegram secret header', async () => {
  const env = {
    ...baseEnv,
    TELEGRAM_LINKING_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_BOT_TOKEN: sharedToken,
  };
  const response = await worker.fetch(new Request(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { text: `/start ${linkToken}`, chat: { id: 600001, type: 'private' } },
    }),
  }), env);
  assert.equal(response.status, 401);
});

await test('verified webhook completes one link and sends only a safe confirmation', async () => {
  const env = {
    ...baseEnv,
    TELEGRAM_LINKING_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_BOT_TOKEN: sharedToken,
  };
  const mock = makeFetch();
  const response = await workerTesting.handleLinkingWebhook(new Request(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': webhookSecret,
    },
    body: JSON.stringify({
      update_id: 123,
      message: { text: `/start ${linkToken}`, chat: { id: 600001, type: 'private' } },
    }),
  }), env, mock.fetchImpl);
  assert.equal(response.status, 200);
  assert.deepEqual(mock.rpcCalls, [{
    name: 'service_complete_telegram_link',
    args: { p_token: linkToken, p_chat_id: '600001', p_chat_type: 'private' },
  }]);
  assert.equal(mock.telegramCalls.length, 1);
  assert.deepEqual(mock.telegramCalls[0].body, {
    chat_id: '600001',
    text: 'Vishar CRM: Telegram connected.',
    disable_web_page_preview: true,
  });
});

await test('unrelated Telegram updates are acknowledged without database access', async () => {
  const env = {
    ...baseEnv,
    TELEGRAM_LINKING_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_BOT_TOKEN: sharedToken,
  };
  const mock = makeFetch();
  const response = await workerTesting.handleLinkingWebhook(new Request(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': webhookSecret,
    },
    body: JSON.stringify({ message: { text: 'hello', chat: { id: 600001, type: 'private' } } }),
  }), env, mock.fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(mock.rpcCalls.length, 0);
  assert.equal(mock.telegramCalls.length, 0);
});

console.log(`Telegram self-service Worker tests: ${passed} passed`);
