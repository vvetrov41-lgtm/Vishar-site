import assert from 'node:assert/strict';
import monzoGateway, { __testing } from '../workers/monzo-api-gateway.js';

class CountingRoutes {
  constructor() {
    this.getCalls = 0;
  }

  async get() {
    this.getCalls += 1;
    return null;
  }
}

function webhookRequest(key = 'w'.repeat(48)) {
  return new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transaction.created', data: { id: 'tx_synthetic1' } }),
  });
}

function env(overrides = {}) {
  return {
    MONZO_RECONCILIATION_ENABLED: 'true',
    MONZO_WEBHOOK_ROUTES: new CountingRoutes(),
    ...overrides,
  };
}

assert.equal(__testing.RATE_LIMIT_KEY, 'monzo-provider-webhook');
assert.ok(__testing.WEBHOOK_PATH.test(`/webhooks/monzo/${'a'.repeat(48)}`));
assert.equal(__testing.WEBHOOK_PATH.test('/webhooks/monzo/short'), false);

{
  const current = env();
  const response = await monzoGateway.fetch(webhookRequest(), current);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: 'webhook_rate_limit_unconfigured' });
  assert.equal(current.MONZO_WEBHOOK_ROUTES.getCalls, 0);
}

{
  let limiterCalls = 0;
  const current = env({
    MONZO_WEBHOOK_RATE_LIMIT: {
      async limit(input) {
        limiterCalls += 1;
        assert.deepEqual(input, { key: 'monzo-provider-webhook' });
        return { success: false };
      },
    },
  });
  const response = await monzoGateway.fetch(webhookRequest('r'.repeat(48)), current);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: 'rate_limited' });
  assert.equal(limiterCalls, 1);
  assert.equal(current.MONZO_WEBHOOK_ROUTES.getCalls, 0);
}

{
  const current = env({
    MONZO_WEBHOOK_RATE_LIMIT: {
      async limit() {
        throw new Error('synthetic limiter outage');
      },
    },
  });
  const response = await monzoGateway.fetch(webhookRequest('u'.repeat(48)), current);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: 'webhook_rate_limit_unavailable' });
  assert.equal(current.MONZO_WEBHOOK_ROUTES.getCalls, 0);
}

{
  let limiterCalls = 0;
  const current = env({
    MONZO_WEBHOOK_RATE_LIMIT: {
      async limit(input) {
        limiterCalls += 1;
        assert.deepEqual(input, { key: 'monzo-provider-webhook' });
        return { success: true };
      },
    },
  });
  const response = await monzoGateway.fetch(webhookRequest('s'.repeat(48)), current);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, code: 'not_found' });
  assert.equal(limiterCalls, 1);
  assert.equal(current.MONZO_WEBHOOK_ROUTES.getCalls, 1);
}

{
  let limiterCalls = 0;
  const current = env({
    MONZO_RECONCILIATION_ENABLED: 'false',
    MONZO_WEBHOOK_RATE_LIMIT: {
      async limit() {
        limiterCalls += 1;
        return { success: false };
      },
    },
  });
  const response = await monzoGateway.fetch(webhookRequest('d'.repeat(48)), current);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: 'reconciliation_disabled' });
  assert.equal(limiterCalls, 0);
  assert.equal(current.MONZO_WEBHOOK_ROUTES.getCalls, 0);
}

{
  let limiterCalls = 0;
  const current = env({
    MONZO_WEBHOOK_RATE_LIMIT: {
      async limit() {
        limiterCalls += 1;
        return { success: false };
      },
    },
  });
  const response = await monzoGateway.fetch(
    new Request('https://monzo-webhook.example.test/health'),
    current,
  );
  assert.equal(response.status, 200);
  assert.equal(limiterCalls, 0);
}

console.log('Monzo public webhook rate-limit regression: passed');
