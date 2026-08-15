import assert from 'node:assert/strict';
import worker from '../workers/whatsapp-drain-worker.js';

assert.equal(typeof worker.scheduled, 'function');
assert.equal('fetch' in worker, false, 'the dedicated drain Worker has no public HTTP handler');

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

console.log('WhatsApp drain Worker tests passed: scheduled-only, disabled by default and aggregate-only logging.');
