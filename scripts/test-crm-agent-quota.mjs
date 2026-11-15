#!/usr/bin/env node
// Resilience: a spent daily AI allocation defers CRM agent jobs instead of
// burning their retry budget. Failure injection only: the model binding is a
// stub, no provider is contacted and no quota is spent.
import assert from 'node:assert/strict';
import { drainCrmAgent, processCrmAgentJob } from '../workers/lib/crm-agent.js';
import { isDailyQuotaFailure } from '../workers/lib/ai/router.js';

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; }
  catch (error) { console.error(`FAIL ${name}\n${error.stack ?? error.message}`); process.exitCode = 1; }
}

const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const attention = {
  last_speaker: 'client', reply_state: 'unknown', workflow_stage: 'booked', deposit_state: 'paid',
  has_future_tattoo_session: true, has_future_consultation: false, next_session_at: '2026-12-05T10:00:00Z',
  sla_state: 'ok', sla_reason: 'studio_reply_owed', waiting_on_candidate: 'artist',
  allowed_actions: ['artist_review', 'follow_up', 'no_action'], conflicts: [],
};
const job = (n) => ({
  job_id: uuid(n), lease_token: uuid(n + 1), job_type: 'refresh_client_ai_state',
  input: {
    client: { full_name: 'Synthetic Client' }, artist: { display_name: 'Studio' }, enquiries: [],
    crm_facts: { projects: [], sessions: [] },
    timeline: [{ source: 'communication', direction: 'inbound', text: 'Is Friday still fine?', occurred_at: '2026-11-14T10:00:00Z' }],
    reference_images: [], previous_brief: null, attention,
  },
});

/** A Workers AI binding that fails the way the real one does. */
function aiBinding(failure) {
  const calls = [];
  return { calls, AI: { run: async (model) => { calls.push(model); throw failure(); } } };
}
const quotaError = () => new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons');
const outageError = () => new Error('AiError: 5007: upstream model is temporarily unavailable');

function database(claimed = []) {
  const calls = [];
  return {
    calls,
    failed: () => calls.filter((call) => call.name === 'service_fail_crm_agent_job'),
    rpc: async (name, args) => {
      if (name === 'service_record_ai_run') return { status: 'recorded' };
      calls.push({ name, args });
      if (name === 'service_claim_crm_agent_jobs') return claimed;
      return { status: 'pending' };
    },
  };
}
const forbiddenFetch = async () => { throw new Error('no network call is allowed in this test'); };

await test('the router result identifies the daily allocation and nothing else', () => {
  const failed = (attempts) => ({ ok: false, errorCode: 'all_providers_failed', attempts });
  assert.equal(isDailyQuotaFailure(failed([{ errorCode: 'provider_rate_limited', errorDetail: 'cf_4006_quota' }])), true);
  assert.equal(isDailyQuotaFailure(failed([{ errorCode: 'provider_rate_limited', errorDetail: 'cf_3036' }])), true);
  assert.equal(isDailyQuotaFailure(failed([{ errorCode: 'provider_rate_limited', errorDetail: 'http_429' }])), false);
  assert.equal(isDailyQuotaFailure(failed([{ errorCode: 'provider_timeout', errorDetail: 'cf_4006_quota' }])), false);
  assert.equal(isDailyQuotaFailure(failed([{ errorCode: 'provider_unavailable' }])), false);
  assert.equal(isDailyQuotaFailure(failed([])), false);
  assert.equal(isDailyQuotaFailure({ ok: true, attempts: [{ errorCode: 'provider_rate_limited', errorDetail: 'cf_4006_quota' }] }), false);
  assert.equal(isDailyQuotaFailure(null), false);
});

for (const contract of ['v1', 'v2']) {
  await test(`contract ${contract}: a spent allocation releases the job as ai_quota_exhausted through the real router`, async () => {
    const stub = aiBinding(quotaError);
    const db = database();
    const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: contract, AI: stub.AI };
    const outcome = await processCrmAgentJob(env, job(1), { supabase: db, fetchImpl: forbiddenFetch });
    assert.deepEqual(outcome, { outcome: 'failed', errorCode: 'ai_quota_exhausted' });
    assert.equal(stub.calls.length, 1, 'no second model is tried on the same allocation');
    assert.deepEqual(db.failed().map((call) => call.args), [
      { p_job_id: uuid(1), p_lease_token: uuid(2), p_error_code: 'ai_quota_exhausted' },
    ]);
    assert.equal(db.calls.some((call) => call.name.startsWith('service_complete')), false);
  });

  await test(`contract ${contract}: an ordinary provider outage is still ai_unavailable`, async () => {
    const stub = aiBinding(outageError);
    const db = database();
    const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: contract, AI: stub.AI };
    const outcome = await processCrmAgentJob(env, job(1), { supabase: db, fetchImpl: forbiddenFetch });
    assert.equal(outcome.errorCode, 'ai_unavailable');
    assert.deepEqual(db.failed().map((call) => call.args.p_error_code), ['ai_unavailable']);
  });
}

await test('one drain makes one doomed call: the other claimed jobs are handed back without a model call', async () => {
  const stub = aiBinding(quotaError);
  const db = database([job(1), job(3), job(5)]);
  const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: 'v2', AI: stub.AI };
  const result = await drainCrmAgent(env, { supabase: db, limit: 3, fetchImpl: forbiddenFetch });
  assert.equal(result.processed, 3);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.errorCode),
    ['ai_quota_exhausted', 'ai_quota_exhausted', 'ai_quota_exhausted']);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(db.failed().map((call) => call.args.p_job_id), [uuid(1), uuid(3), uuid(5)]);
});

await test('an outage on one job does not hand the next job back', async () => {
  const stub = aiBinding(outageError);
  const db = database([job(1), job(3)]);
  const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: 'v2', AI: stub.AI };
  const result = await drainCrmAgent(env, { supabase: db, limit: 2, fetchImpl: forbiddenFetch });
  assert.deepEqual(result.outcomes.map((outcome) => outcome.errorCode), ['ai_unavailable', 'ai_unavailable']);
  assert.ok(stub.calls.length >= 2, 'each job gets its own model attempt');
});

await test('a release that cannot reach the database never throws: the lease expires instead', async () => {
  const stub = aiBinding(quotaError);
  const db = { rpc: async () => { throw new Error('database down'); } };
  const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: 'v2', AI: stub.AI };
  const outcome = await processCrmAgentJob(env, job(1), { supabase: db, fetchImpl: forbiddenFetch });
  assert.deepEqual(outcome, { outcome: 'failed', errorCode: 'ai_quota_exhausted' });
});

if (process.exitCode) {
  console.error('CRM agent quota deferral tests failed.');
} else {
  console.log(`CRM agent quota deferral tests passed: ${passes} cases, no provider contacted.`);
}
