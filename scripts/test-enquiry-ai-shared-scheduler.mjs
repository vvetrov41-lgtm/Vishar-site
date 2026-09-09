import assert from 'node:assert/strict';
import {
  assertEnquiryAiSummary,
  createProductionScheduler,
  runSharedEnquiryAiDrain,
  __testing,
} from '../workers/telegram-production-scheduler.js';

assert.deepEqual(assertEnquiryAiSummary({ ok: true, processed: 0 }), { processed: 0 });
assert.deepEqual(assertEnquiryAiSummary({ ok: true, processed: 3 }), { processed: 3 });
for (const invalid of [null, {}, { ok: true, processed: -1 }, { ok: true, processed: 4 }]) {
  assert.throws(() => assertEnquiryAiSummary(invalid),
    (error) => error?.code === 'enquiry_ai_shared_drain_summary_invalid');
}
assert.throws(() => assertEnquiryAiSummary({ ok: false, processed: 0, errorCode: 'queue_unavailable' }),
  (error) => error?.code === 'queue_unavailable');

let calls = 0;
const backendSecret = 'unit-test-backend-secret';
assert.deepEqual(await runSharedEnquiryAiDrain({
  SUPABASE_SECRET_KEY: backendSecret,
  TATTOOAI_SERVICE: {
    async fetch(url, init = {}) {
      calls += 1;
      assert.equal(String(url), __testing.AI_DRAIN_URL);
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${backendSecret}`);
      return Response.json({ ok: true, processed: 2 });
    },
  },
}), { processed: 2 });
assert.equal(calls, 1);

await assert.rejects(
  runSharedEnquiryAiDrain({
    TATTOOAI_SERVICE: { async fetch() { return Response.json({ ok: true, processed: 0 }); } },
  }),
  (error) => error?.code === 'tattooai_service_auth_unavailable',
);

const quietBase = {
  fetch() { return new Response('base', { status: 200 }); },
  scheduled() {},
};
const previewScheduler = createProductionScheduler(quietBase);
let waited = false;
let previewCalls = 0;
previewScheduler.scheduled({}, {
  VISHAR_ENVIRONMENT: 'preview',
  ENQUIRY_AI_SHARED_DRAIN_ENABLED: 'true',
  SUPABASE_SECRET_KEY: backendSecret,
  TATTOOAI_SERVICE: {
    async fetch() {
      previewCalls += 1;
      return Response.json({ ok: true, processed: 0 });
    },
  },
}, { waitUntil() { waited = true; } });
assert.equal(waited, false);
assert.equal(previewCalls, 0, 'preview must never invoke the production TattooAI binding');

let releaseBase;
let baseFinished = false;
const slowBase = {
  fetch: quietBase.fetch,
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil((async () => {
      await new Promise((resolve) => { releaseBase = resolve; });
      baseFinished = true;
    })());
  },
};
const scheduler = createProductionScheduler(slowBase);
let scheduledPromise;
scheduler.scheduled({}, {
  VISHAR_ENVIRONMENT: 'production',
  ENQUIRY_AI_SHARED_DRAIN_ENABLED: 'true',
  SUPABASE_SECRET_KEY: backendSecret,
  TATTOOAI_SERVICE: {
    async fetch() {
      throw Object.assign(new Error('synthetic AI failure'), { code: 'synthetic_ai_failure' });
    },
  },
}, {
  waitUntil(promise) { scheduledPromise = promise; },
});
assert.ok(scheduledPromise instanceof Promise);
while (!releaseBase) await Promise.resolve();
let settled = false;
scheduledPromise.then(() => { settled = true; }, () => { settled = true; });
await Promise.resolve();
assert.equal(settled, false, 'AI failure must not release the shared scheduler while base work is running');
assert.equal(baseFinished, false);
releaseBase();
await assert.rejects(scheduledPromise, (error) => error?.code === 'synthetic_ai_failure');
assert.equal(baseFinished, true, 'base Telegram/Gmail/lifecycle work must finish despite AI failure');

const response = await scheduler.fetch(new Request('https://telegram.example.test/'), {}, {});
assert.equal(response.status, 200);
assert.equal(await response.text(), 'base');

console.log('Enquiry AI shared scheduler tests passed: production-only authenticated service fetch shares the existing scheduler and cannot suppress sibling work.');
