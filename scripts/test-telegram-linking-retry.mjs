import assert from 'node:assert/strict';
import { __testing as workerTesting } from '../workers/telegram-drain-worker.js';

const linkToken = '0123456789abcdef0123456789abcdef';
const webhookSecret = 'telegramWebhookSecret_1234567890';
const sharedToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const requestBody = JSON.stringify({
  update_id: 991,
  message: {
    text: `/start ${linkToken}`,
    chat: { id: 600001, type: 'private' },
  },
});

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  TELEGRAM_LINKING_ENABLED: 'true',
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  TELEGRAM_BOT_TOKEN: sharedToken,
};

function request() {
  return new Request('https://telegram.example.test/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': webhookSecret,
    },
    body: requestBody,
  });
}

assert.equal(
  workerTesting.linkingConfigured({ ...env, TELEGRAM_BOT_TOKEN: '' }),
  false,
  'linking cannot be enabled without the shared bot token',
);

{
  const calls = [];
  const response = await workerTesting.handleLinkingWebhook(request(), env, async (url) => {
    calls.push(String(url));
    return Response.json({ code: 'PGRST500' }, { status: 503 });
  });
  assert.equal(response.status, 503, 'a transient backend failure must ask Telegram to retry');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /service_complete_telegram_link$/);
}

{
  const calls = [];
  const response = await workerTesting.handleLinkingWebhook(request(), env, async (url) => {
    calls.push(String(url));
    return Response.json({ code: '22023' }, { status: 400 });
  });
  assert.equal(response.status, 200, 'an invalid challenge must not reveal whether the token existed');
  assert.equal(calls.length, 1);
}

{
  const calls = [];
  const response = await workerTesting.handleLinkingWebhook(request(), env, async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/rest/v1/rpc/service_complete_telegram_link')) {
      return Response.json({ connected: true });
    }
    if (value.includes('/sendMessage')) {
      return Response.json({ ok: false }, { status: 502 });
    }
    throw new Error(`unexpected URL ${value}`);
  });
  assert.equal(response.status, 200, 'confirmation failure after durable completion must not replay /start');
  assert.equal(calls.length, 2);
}

console.log('Telegram linking retry semantics: passed');
