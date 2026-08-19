import assert from 'node:assert/strict';
import worker, { __testing } from '../workers/telegram-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');
assert.equal('fetch' in worker, false, 'the dedicated drain Worker has no public HTTP handler');
assert.deepEqual(__testing.assertGmailSummary({
  skipped: false,
  processed: 3,
  sent: 1,
  deduplicated: 1,
  failed: 1,
}), {
  skipped: false,
  processed: 3,
  sent: 1,
  deduplicated: 1,
  failed: 1,
});
assert.throws(
  () => __testing.assertGmailSummary({ processed: 1, sent: 1, deduplicated: 1, failed: 0 }),
  (error) => error?.code === 'gmail_shared_drain_summary_invalid',
);

const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;
const messages = [];
console.log = (...args) => messages.push(args.join(' '));
console.error = (...args) => messages.push(args.join(' '));

try {
  let waited = false;
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'false',
  }, {
    waitUntil() { waited = true; },
  });
  assert.equal(waited, false);
  assert.deepEqual(messages, [
    'telegram outbox drain disabled',
    'gmail outbox shared drain disabled',
  ]);

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
    GMAIL_SHARED_DRAIN_ENABLED: 'false',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  assert.ok(messages.includes('gmail outbox shared drain disabled'));
  assert.ok(messages.includes('telegram outbox drain {"claimed":0,"succeeded":0,"failed":0,"unrecorded":0}'));

  messages.length = 0;
  let gmailCalls = 0;
  scheduledPromise = null;
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'true',
    GMAIL_SERVICE: {
      async drainApprovedEmailOutbox() {
        gmailCalls += 1;
        return { skipped: false, processed: 2, sent: 1, deduplicated: 1, failed: 0 };
      },
    },
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  assert.equal(gmailCalls, 1);
  assert.deepEqual(messages, [
    'telegram outbox drain disabled',
    'gmail outbox shared drain {"skipped":false,"processed":2,"sent":1,"deduplicated":1,"failed":0}',
  ]);
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('Telegram drain Worker tests passed: one scheduled Worker can dispatch Telegram and bounded Gmail RPC drains without a public HTTP handler.');
