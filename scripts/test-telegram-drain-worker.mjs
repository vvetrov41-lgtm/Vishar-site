import assert from 'node:assert/strict';
import worker from '../workers/telegram-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');
assert.equal('fetch' in worker, false, 'the dedicated drain Worker has no public HTTP handler');

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
  assert.deepEqual(messages, [
    'telegram outbox drain {"claimed":0,"succeeded":0,"failed":0,"unrecorded":0}',
  ]);
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('Telegram drain Worker tests passed: scheduled-only, disabled by default and aggregate-only logging.');
