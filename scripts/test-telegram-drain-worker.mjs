import assert from 'node:assert/strict';
import { assertAutomationTickSummary } from '../workers/lib/automation-tick.js';
import worker, { __testing } from '../workers/telegram-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');

// Telegram linking and appointment client actions are the only HTTP surfaces on
// this shared runtime. Ordinary paths remain dormant while Telegram linking is
// disabled, and a malformed appointment capability is owned locally without a
// backend call. The detailed action contract lives in test-appointment-client-actions.
assert.equal(typeof worker.fetch, 'function');
for (const path of ['/', '/webhook', '/webhook?token=x', '/anything', '/appointments/respond/not-a-token']) {
  const dormant = await worker.fetch(
    new Request(`https://telegram.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    { TELEGRAM_DRAIN_ENABLED: 'true' },
  );
  assert.equal(dormant.status, 404,
    `${path} must not become an unbounded HTTP surface`);
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
  // The production-like shared Worker secret can reach only the two exact
  // appointment-action RPCs. GET resolves without mutating; POST applies only
  // the server-bound action selected by the capability token.
  const actionToken = 'a'.repeat(64);
  const actionUrl = `https://telegram.example.test/appointments/respond/${actionToken}`;
  const actionEnv = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_unit_test',
  };
  const actionCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    actionCalls.push({ href, body, headers: new Headers(init.headers), method: init.method });
    if (href.endsWith('/rest/v1/rpc/service_resolve_appointment_client_action')) {
      return Response.json([{
        action: 'confirm_attendance',
        artist_display_name: 'Vladimir Vishar',
      }]);
    }
    if (href.endsWith('/rest/v1/rpc/service_apply_appointment_client_action')) {
      return Response.json({
        action: 'confirm_attendance',
        outcome: 'attendance_confirmed',
        artist_display_name: 'Vladimir Vishar',
      });
    }
    throw new Error(`unexpected appointment action backend call: ${href}`);
  };

  const resolveResponse = await worker.fetch(new Request(actionUrl), actionEnv);
  assert.equal(resolveResponse.status, 200);
  assert.match(resolveResponse.headers.get('content-type') || '', /text\/html/);
  assert.match(await resolveResponse.text(), /Confirm attendance/);
  assert.equal(actionCalls.length, 1);
  assert.match(actionCalls[0].href, /service_resolve_appointment_client_action$/);
  assert.deepEqual(actionCalls[0].body, { p_token: actionToken });
  assert.equal(actionCalls[0].headers.get('apikey'), actionEnv.SUPABASE_SECRET_KEY);
  assert.equal(actionCalls[0].headers.get('authorization'), null);

  actionCalls.length = 0;
  const applyResponse = await worker.fetch(new Request(actionUrl, { method: 'POST' }), actionEnv);
  assert.equal(applyResponse.status, 200);
  assert.match(await applyResponse.text(), /Attendance confirmed/);
  assert.equal(actionCalls.length, 1);
  assert.match(actionCalls[0].href, /service_apply_appointment_client_action$/);
  assert.deepEqual(actionCalls[0].body, { p_token: actionToken });

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
  let automationTickCalls = 0;
  let automationHeartbeatCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith('/rest/v1/rpc/service_run_automation_tick')) {
      assert.deepEqual(JSON.parse(init.body), { p_limit: 100 });
      automationTickCalls += 1;
      return Response.json([{
        materialised: 0,
        withdrawn: 0,
        executed: 0,
        notified: 0,
      }]);
    }
    if (value.endsWith('/rest/v1/rpc/service_record_automation_scheduler_heartbeat')) {
      assert.deepEqual(JSON.parse(init.body), {});
      automationHeartbeatCalls += 1;
      return Response.json('2026-08-27T09:55:00Z');
    }
    throw new Error(`unexpected automation backend call: ${value}`);
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
  assert.equal(automationTickCalls, 1);
  assert.equal(automationHeartbeatCalls, 1);
  assert.deepEqual(messages, [
    'telegram outbox drain disabled',
    'gmail outbox shared drain disabled',
    'automation tick {"materialised":0,"withdrawn":0,"executed":0,"notified":0}',
  ]);

  messages.length = 0;
  scheduledPromise = null;
  automationHeartbeatCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/rest/v1/rpc/service_run_automation_tick')) {
      return Response.json([{ materialised: 101, withdrawn: 0, executed: 0, notified: 0 }]);
    }
    if (value.endsWith('/rest/v1/rpc/service_record_automation_scheduler_heartbeat')) {
      automationHeartbeatCalls += 1;
      return Response.json('should-not-be-written');
    }
    throw new Error(`unexpected automation backend call: ${value}`);
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
  await assert.rejects(
    scheduledPromise,
    (error) => error?.code === 'automation_tick_summary_invalid',
  );
  assert.equal(automationHeartbeatCalls, 0);
  assert.ok(messages.some((line) => line.includes('automation_tick_summary_invalid')));
  assert.ok(messages.every((line) => !line.includes('materialised\":101')));

  // A fast failure must not let waitUntil settle while another responsibility
  // is still running. All shared-cron tasks retain their full execution window.
  messages.length = 0;
  scheduledPromise = null;
  let releaseAutomation;
  let automationFinished = false;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/rest/v1/rpc/service_run_automation_tick')) {
      await new Promise((resolve) => { releaseAutomation = resolve; });
      return Response.json([{
        materialised: 0,
        withdrawn: 0,
        executed: 0,
        notified: 0,
      }]);
    }
    if (value.endsWith('/rest/v1/rpc/service_record_automation_scheduler_heartbeat')) {
      automationFinished = true;
      return Response.json('2026-08-27T09:55:00Z');
    }
    throw new Error(`unexpected automation backend call: ${value}`);
  };
  worker.scheduled({}, {
    TELEGRAM_DRAIN_ENABLED: 'false',
    GMAIL_SHARED_DRAIN_ENABLED: 'true',
    AUTOMATION_TICK_ENABLED: 'true',
    GMAIL_SERVICE: {
      async drainApprovedEmailOutbox() {
        throw Object.assign(new Error('unit test Gmail failure'), {
          code: 'gmail_unit_test_failure',
        });
      },
    },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  while (!releaseAutomation) await Promise.resolve();
  let sharedCronSettled = false;
  scheduledPromise.then(
    () => { sharedCronSettled = true; },
    () => { sharedCronSettled = true; },
  );
  await Promise.resolve();
  assert.equal(sharedCronSettled, false);
  assert.equal(automationFinished, false);
  releaseAutomation();
  await assert.rejects(
    scheduledPromise,
    (error) => error?.code === 'gmail_unit_test_failure',
  );
  assert.equal(automationFinished, true);
  assert.ok(messages.includes(
    'automation tick {"materialised":0,"withdrawn":0,"executed":0,"notified":0}',
  ));
  assert.ok(messages.some((line) => line.includes('gmail_unit_test_failure')));
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('Telegram drain Worker tests passed: appointment actions share the bounded HTTP runtime while Telegram, Gmail and automation keep one isolated cron.');
