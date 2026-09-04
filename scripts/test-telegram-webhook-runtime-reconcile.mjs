import assert from 'node:assert/strict';
import {
  __testing,
  productionWebhookReconcileConfigured,
  reconcileProductionTelegramWebhook,
} from '../workers/lib/telegram-webhook-reconcile.js';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const secret = 'telegramWebhookSecret_1234567890';
const expectedUrl = __testing.EXPECTED_PRODUCTION_WEBHOOK_URL;
const env = {
  VISHAR_ENVIRONMENT: 'production',
  TELEGRAM_LINKING_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_WEBHOOK_SECRET: secret,
};

function mockTelegram(initialUrl) {
  let liveUrl = initialUrl;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body, url: String(url) });
    if (method === 'getWebhookInfo') {
      return Response.json({
        ok: true,
        result: {
          url: liveUrl,
          pending_update_count: 1,
          last_error_date: null,
        },
      });
    }
    if (method === 'setWebhook') {
      liveUrl = body.url;
      return Response.json({ ok: true, result: true });
    }
    throw new Error(`unexpected Telegram method ${method}`);
  };
  return { fetchImpl, calls };
}

assert.equal(productionWebhookReconcileConfigured(env), true);
assert.equal(productionWebhookReconcileConfigured({ ...env, VISHAR_ENVIRONMENT: 'staging' }), false);
assert.equal(productionWebhookReconcileConfigured({ ...env, TELEGRAM_LINKING_ENABLED: 'false' }), false);

{
  const mock = mockTelegram(expectedUrl);
  const result = await reconcileProductionTelegramWebhook(env, mock.fetchImpl);
  assert.deepEqual(mock.calls.map((call) => call.method), ['getWebhookInfo']);
  assert.equal(result.changed, false);
  assert.equal(result.matchesExpected, true);
}

{
  const mock = mockTelegram('');
  const result = await reconcileProductionTelegramWebhook(env, mock.fetchImpl);
  assert.deepEqual(mock.calls.map((call) => call.method), [
    'getWebhookInfo',
    'setWebhook',
    'getWebhookInfo',
  ]);
  const mutation = mock.calls[1];
  assert.deepEqual(mutation.body, {
    url: expectedUrl,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  assert.equal(result.changed, true);
  assert.equal(result.matchesExpected, true);
  assert.equal(result.pendingUpdateCount, 1);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(token));
}

{
  const calls = [];
  const result = await reconcileProductionTelegramWebhook(
    { ...env, VISHAR_ENVIRONMENT: 'staging' },
    async (...args) => { calls.push(args); throw new Error('must not call'); },
  );
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 0);
}

await assert.rejects(
  reconcileProductionTelegramWebhook({ ...env, TELEGRAM_WEBHOOK_SECRET: '' }),
  (error) => error?.code === 'telegram_webhook_reconcile_not_configured',
);

{
  const fetchImpl = async () => Response.json({ ok: false, description: secret }, { status: 401 });
  await assert.rejects(
    reconcileProductionTelegramWebhook(env, fetchImpl),
    (error) => {
      assert.equal(error?.code, 'telegram_webhook_bot_token_invalid');
      assert.ok(!String(error?.message).includes(secret));
      assert.ok(!String(error?.message).includes(token));
      return true;
    },
  );
}

console.log('Telegram runtime webhook reconciliation tests passed.');
