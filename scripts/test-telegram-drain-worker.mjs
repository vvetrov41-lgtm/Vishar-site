import assert from 'node:assert/strict';
import worker from '../workers/telegram-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');

// This Worker used to have no HTTP surface at all, and that assertion lived
// here. Telegram linking needs one, so the guarantee moved rather than
// disappeared: the handler exists, but under the tracked production
// configuration - linking disabled - every path including the exact webhook
// path is 404, and nothing reaches the network. The full webhook contract
// (secret header, path exactness, retry semantics) is covered in
// scripts/test-telegram-self-service-worker.mjs.
assert.equal(typeof worker.fetch, 'function');
for (const path of ['/', '/webhook', '/webhook?token=x', '/anything']) {
  const dormant = await worker.fetch(
    new Request(`https://telegram.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    { TELEGRAM_DRAIN_ENABLED: 'true' },
  );
  assert.equal(dormant.status, 404,
    `${path} must be dormant while Telegram linking is disabled`);
}

const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;
const messages = [];
console.log = (...args) => messages.push(args.join(' '));
console.error = (...args) => messages.push(args.join(' '));

try {
  let waited = false;
  worker.scheduled({}, { TELEGRAM_DRAIN_ENABLED: 'false' }, {
    waitUntil() { waited = true; },
  });
  assert.equal(waited, false);
  assert.deepEqual(messages, ['telegram outbox drain disabled']);

  messages.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    assert.ok(value.endsWith('/rest/v1/rpc/claim_telegram_outbox'));
    assert.deepEqual(JSON.parse(init.body), {
      p_worker_id: JSON.parse(init.body).p_worker_id,
      p_limit: 10,
      p_lease_seconds: 120,
    });
    assert.match(JSON.parse(init.body).p_worker_id, /^telegram-worker-[0-9a-f]{24}$/);
    return Response.json([]);
  };

  let scheduledPromise;
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  // The scheduled drain now does two jobs: the durable Artist outbox and
  // personal notification delivery. personalSkipped is true here because no
  // shared bot token is configured, which is the tracked production posture.
  assert.deepEqual(messages, [
    'telegram outbox drain {"claimed":0,"succeeded":0,"failed":0,"unrecorded":0,'
      + '"personalClaimed":0,"personalSucceeded":0,"personalFailed":0,'
      + '"personalUnrecorded":0,"personalSkipped":true}',
  ]);
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('Telegram drain Worker tests passed: drain disabled by default, linking dormant on every path, and aggregate-only logging.');
