import assert from 'node:assert/strict';
import {
  assertEnquiryAiSummary,
  createProductionScheduler,
  runSharedEnquiryAiDrain,
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
assert.deepEqual(await runSharedEnquiryAiDrain({
  TATTOOAI_SERVICE: {
    async drainEnquiryAiJobs() {
      calls += 1;
      return { ok: true, processed: 2 };
    },
  },
}), { processed: 2 });
assert.equal(calls, 1);

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
  TATTOOAI_SERVICE: {
    async drainEnquiryAiJobs() {
      previewCalls += 1;
      return { ok: true, processed: 0 };
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
  TATTOOAI_SERVICE: {
    async drainEnquiryAiJobs() {
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

console.log('Enquiry AI shared scheduler tests passed: production-only AI work shares the existing scheduler and cannot suppress sibling work.');
