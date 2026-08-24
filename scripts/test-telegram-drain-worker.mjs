import assert from 'node:assert/strict';
import { assertAutomationTickSummary } from '../workers/lib/automation-tick.js';
import worker, { __testing } from '../workers/telegram-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');

// This Worker used to have no HTTP surface at all. Telegram linking needs one,
// so the guarantee moved rather than disappeared: under the tracked production
// configuration linking is disabled, every path is 404, and nothing reaches the
// network. The full webhook contract lives in test-telegram-self-service-worker.
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
assert.throws(
  () => __testing.assertGmailSummary({ processed: 21, sent: 0, deduplicated: 0, failed: 0 }),
  (error) => error?.code === 'gmail_shared_drain_summary_invalid',
);

assert.deepEqual(assertAutomationTickSummary([{
  materialised: 2,
  withdrawn: 600,
  executed: 150,
  notified: 300,
}]), {
  materialised: 2,
  withdrawn: 600,
  executed: 150,
  notified: 300,
});
for (const invalid of [
  [],
  [{ materialised: 101, withdrawn: 0, executed: 0, notified: 0 }],
  [{ materialised: 0, withdrawn: -1, executed: 0, notified: 0 }],
  [{ materialised: 0, withdrawn: 0, executed: 0 }],
]) {
  assert.throws(
    () => assertAutomationTickSummary(invalid),
    (error) => error?.code === 'automation_tick_summary_invalid',
  );
}

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
    AUTOMATION_TICK_ENABLED: 'false',
  }, {
    waitUntil() { waited = true; },
  });
  assert.equal(waited, false);
  assert.deepEqual(messages, [
    'telegram outbox drain disabled',
    'gmail outbox shared drain disabled',
    'automation tick disabled',
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
    AUTOMATION_TICK_ENABLED: 'false',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  // The scheduled Telegram drain does two Telegram jobs: the durable Artist
  // outbox and personal delivery. Personal delivery is skipped without the
  // shared bot token. Gmail and automation remain independently disabled.
  assert.ok(messages.includes('gmail outbox shared drain disabled'));
  assert.ok(messages.includes('automation tick disabled'));
  assert.ok(messages.includes(
    'telegram outbox drain {"claimed":0,"succeeded":0,"failed":0,"unrecorded":0,'
      + '"personalClaimed":0,"personalSucceeded":0,"personalFailed":0,'
      + '"personalUnrecorded":0,"personalSkipped":true}',
  ));

  messages.length = 0;
  let gmailCalls = 0;
  scheduledPromise = null;
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'true',
    AUTOMATION_TICK_ENABLED: 'false',
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
  assert.equal(messages.length, 3);
  assert.ok(messages.includes('telegram outbox drain disabled'));
  assert.ok(messages.includes('automation tick disabled'));
  assert.ok(messages.includes(
    'gmail outbox shared drain {"skipped":false,"processed":2,"sent":1,"deduplicated":1,"failed":0}',
  ));

  messages.length = 0;
  scheduledPromise = null;
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'true',
    AUTOMATION_TICK_ENABLED: 'false',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await assert.rejects(
    scheduledPromise,
    (error) => error?.code === 'gmail_service_binding_unavailable',
  );
  assert.ok(messages.some((line) => line.includes('gmail_shared_drain_summary_invalid')) === false);
  assert.ok(messages.some((line) => line.includes('gmail_service_binding_unavailable')));
  assert.ok(messages.includes('automation tick disabled'));

  messages.length = 0;
  scheduledPromise = null;
  let automationCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    assert.ok(value.endsWith('/rest/v1/rpc/service_run_automation_tick'));
    assert.deepEqual(JSON.parse(init.body), { p_limit: 100 });
    automationCalls += 1;
    return Response.json([{
      materialised: 0,
      withdrawn: 0,
      executed: 0,
      notified: 0,
    }]);
  };
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'false',
    AUTOMATION_TICK_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  assert.equal(automationCalls, 1);
  assert.deepEqual(messages, [
    'telegram outbox drain disabled',
    'gmail outbox shared drain disabled',
    'automation tick {"materialised":0,"withdrawn":0,"executed":0,"notified":0}',
  ]);

  messages.length = 0;
  scheduledPromise = null;
  globalThis.fetch = async () => Response.json([{ materialised: 101, withdrawn: 0, executed: 0, notified: 0 }]);
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'false',
    AUTOMATION_TICK_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  await assert.rejects(
    scheduledPromise,
    (error) => error?.code === 'automation_tick_summary_invalid',
  );
  assert.ok(messages.some((line) => line.includes('automation_tick_summary_invalid')));
  assert.ok(messages.every((line) => !line.includes('materialised":101')));
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('Telegram drain Worker tests passed: Telegram, Gmail and automation share one cron behind independent bounded switches; linking remains dormant by default.');
