import assert from 'node:assert/strict';
import worker from '../workers/whatsapp-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');
// The only HTTP surface is the exact synthetic Service Binding host.
{
  const env = { VISHAR_ENVIRONMENT: 'production', WHATSAPP_DRAIN_ENABLED: 'true' };
  for (const [url, method] of [
    ['https://vishar-whatsapp-drain-production.vvetrov41.workers.dev/internal/whatsapp/drain', 'POST'],
    ['https://whatsapp.internal/internal/whatsapp/drain', 'GET'],
    ['https://whatsapp.internal/internal/whatsapp/drain?x=1', 'POST'],
    ['https://whatsapp.internal/', 'POST'],
    ['http://whatsapp.internal/internal/whatsapp/drain', 'POST'],
  ]) {
    const response = await worker.fetch(new Request(url, { method }), env);
    assert.equal(response.status, 404, `${method} ${url} is not a drain surface`);
  }
  const { handleInternalDrain } = await import('../workers/whatsapp-drain-worker.js');
  const disabled = await (await handleInternalDrain({ VISHAR_ENVIRONMENT: 'production', WHATSAPP_DRAIN_ENABLED: 'false' },
    async () => { throw new Error('must not drain'); })).json();
  assert.deepEqual(disabled, { ok: true, skipped: true, claimed: 0, succeeded: 0, failed: 0, unrecorded: 0 });
  const preview = await (await handleInternalDrain({ VISHAR_ENVIRONMENT: 'preview', WHATSAPP_DRAIN_ENABLED: 'true' },
    async () => { throw new Error('must not drain'); })).json();
  assert.equal(preview.skipped, true, 'only production drains');
  let templateMaintenanceCalls = 0;
  const ran = await (await handleInternalDrain(
    { ...env, WHATSAPP_BOOKING_TEMPLATE_MAINTENANCE_ENABLED: 'true' },
    async () => ({ claimed: 2, succeeded: 1, failed: 1, unrecorded: 0 }),
    async () => {
      templateMaintenanceCalls += 1;
      return { targets: 1, checked: 1, created: 0, approved: 1, failed: 0 };
    },
  )).json();
  assert.deepEqual(ran, { ok: true, skipped: false, claimed: 2, succeeded: 1, failed: 1, unrecorded: 0 });
  assert.equal(templateMaintenanceCalls, 1);
  const quiet = console.error; console.error = () => {};
  const failed = await (await handleInternalDrain(env, async () => { throw Object.assign(new Error('x'), { code: 'database_unavailable' }); })).json();
  console.error = quiet;
  assert.deepEqual(failed, { ok: false, errorCode: 'database_unavailable' }, 'failures return a safe code, never details');
}

const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;
const messages = [];
console.log = (...args) => messages.push(args.join(' '));
console.error = (...args) => messages.push(args.join(' '));

try {
  // Disabled is the tracked default and must do nothing at all.
  let waited = false;
  worker.scheduled({}, { WHATSAPP_DRAIN_ENABLED: 'false' }, {
    waitUntil() { waited = true; },
  });
  assert.equal(waited, false);
  assert.deepEqual(messages, ['whatsapp outbox drain disabled']);

  // Anything other than the exact string "true" stays disabled.
  for (const value of [undefined, '', 'TRUE', '1', 'yes']) {
    messages.length = 0;
    let touched = false;
    worker.scheduled({}, { WHATSAPP_DRAIN_ENABLED: value }, {
      waitUntil() { touched = true; },
    });
    assert.equal(touched, false, `WHATSAPP_DRAIN_ENABLED=${String(value)} must not run`);
    assert.deepEqual(messages, ['whatsapp outbox drain disabled']);
  }

  messages.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    assert.ok(value.endsWith('/rest/v1/rpc/claim_whatsapp_outbox'));
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      p_worker_id: body.p_worker_id,
      p_limit: 10,
      p_lease_seconds: 120,
    });
    assert.match(body.p_worker_id, /^whatsapp-worker-[0-9a-f]{24}$/);
    return Response.json([]);
  };

  let scheduledPromise;
  worker.scheduled({}, {
    WHATSAPP_DRAIN_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  }, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  // Asserted byte-for-byte: adding a field to this log line must be a
  // deliberate, reviewed change, because the drain handles message content.
  assert.deepEqual(messages, [
    'whatsapp outbox drain {"claimed":0,"succeeded":0,"failed":0,"unrecorded":0}',
  ]);
} finally {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
}

console.log('WhatsApp drain Worker tests passed: Service-Binding-only internal drain, disabled by default, production-only and aggregate-only logging.');
