#!/usr/bin/env node
// Phase 0 AI telemetry: records are bounded, content-free and fail-open.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAiRunRecord, recordAiRun } from '../workers/lib/ai/telemetry.js';
import {
  CLIENT_STATE_PROMPT_VERSION, CLIENT_STATE_SYSTEM, diagnoseClientStateAnalysis,
} from '../workers/lib/ai/client-state-schema.js';
import {
  REFERENCE_IMAGE_PROMPT_VERSION, REFERENCE_IMAGE_SYSTEM, diagnoseReferenceImageAnalysis,
} from '../workers/lib/ai/reference-image-schema.js';
import { ENQUIRY_AI_PROMPT_VERSION, ENQUIRY_AI_SYSTEM } from '../workers/lib/ai/enquiry-schema.js';
import { convergeClientAiBriefs, processCrmAgentJob, recordAttentionShadow } from '../workers/lib/crm-agent.js';
import { processEnquiryAiJob } from '../workers/lib/enquiry-ai.js';
import { runModelTask } from '../workers/lib/ai/router.js';

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const SECRET_NAME = 'Donovan Hale';
const SECRET_TEXT = 'Would 19 October work for the dragon on my ribs?';

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; }
  catch (error) { console.error(`FAIL ${name}\n${error.stack ?? error.message}`); process.exitCode = 1; }
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

const recorder = (results = {}) => {
  const calls = [];
  const telemetry = [];
  return {
    calls,
    telemetry,
    rpc: async (name, args) => {
      if (name === 'service_record_ai_run') { telemetry.push(args.p_run); return { status: 'recorded' }; }
      calls.push({ name, args });
      return results[name] ?? { status: 'succeeded' };
    },
  };
};

const validBrief = {
  project_summary: 'Dragon on the ribs.', stage: 'gathering_information', placement: 'Ribs',
  style: null, colour: null, size: null, cover_up_context: null, constraints: [],
  decisions_made: [], open_questions: ['Size'], promises_to_client: [], waiting_on: 'artist',
  last_interaction: 'Client asked about a date.',
  discussed: {
    session_estimate: { value: null, status: 'not_discussed' },
    price: { value: null, status: 'not_discussed' },
    deposit: { value: null, status: 'not_discussed' },
    candidate_dates: { value: '19 October', status: 'mentioned_by_client' },
    confirmed_dates: { value: null, status: 'not_discussed' },
  },
};
const validAnalysis = {
  summary: `${SECRET_NAME} wants a dragon on the ribs.`,
  brief: validBrief,
  next_action: {
    action_type: 'artist_review', reason: 'A date was floated.', priority: 'normal',
    draft_reply: null, missing_information: ['size'],
  },
};

const clientJob = {
  job_id: JOB_ID,
  lease_token: LEASE,
  job_type: 'refresh_client_ai_state',
  input: {
    client: { full_name: SECRET_NAME },
    artist: { display_name: 'Vishar' },
    enquiries: [],
    crm_facts: { projects: [], sessions: [] },
    timeline: [{ source: 'communication', direction: 'inbound', text: SECRET_TEXT, occurred_at: '2026-09-20T10:00:00Z' }],
    reference_images: [],
    previous_brief: null,
  },
};

// A Workers AI binding that answers per model: Qwen breaks the contract, Llama keeps it.
const fakeEnv = (qwenAnswer, llamaAnswer) => ({
  CRM_AGENT_ENABLED: 'true',
  AI_ROUTE_CRM_CLIENT_STATE: 'qwen,workers_ai',
  AI: {
    run: async (model) => {
      if (model.includes('/qwen/')) {
        if (qwenAnswer instanceof Error) throw qwenAnswer;
        return { choices: [{ message: { content: JSON.stringify(qwenAnswer) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2100, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 400 } } };
      }
      return { response: JSON.stringify(llamaAnswer), usage: { prompt_tokens: 2000, completion_tokens: 600 } };
    },
  },
});

await test('prompt versions are pinned to the exact prompt text', () => {
  // Changing a system prompt without bumping its version would make telemetry
  // compare two different prompts as one. Update the hash AND the version.
  assert.equal(sha(CLIENT_STATE_SYSTEM), '187aca8ec79c7648dac0671a52fe6e0b6d6049f58622f78be8c5e9228fbe55d8',
    `client-state prompt changed: bump CLIENT_STATE_PROMPT_VERSION (${CLIENT_STATE_PROMPT_VERSION})`);
  assert.equal(sha(REFERENCE_IMAGE_SYSTEM), 'cae30414491ba4bd8093dd0b7a342c155e1ab465cc082651ef56cdc5323ac7a7',
    `reference-image prompt changed: bump REFERENCE_IMAGE_PROMPT_VERSION (${REFERENCE_IMAGE_PROMPT_VERSION})`);
  assert.equal(sha(ENQUIRY_AI_SYSTEM), '7f3ea9716c59ea7ee99f0a474ae6db835eaf119f3de75d056b9393561e9d1478',
    `enquiry prompt changed: bump ENQUIRY_AI_PROMPT_VERSION (${ENQUIRY_AI_PROMPT_VERSION})`);
});

await test('the builder drops any attempt field outside the contract', () => {
  const record = buildAiRunRecord({
    task: 'crm_client_state', jobKind: 'client_state', jobId: JOB_ID,
    promptVersion: 'client-state.x', schemaVersion: 'client-state.v1', outcome: 'failed',
    errorCode: 'provider said: client wrote hello', validationFailure: 'brief.stage was booked',
    routed: {
      ok: false, routeSource: 'env', durationMs: 31000,
      attempts: [
        { provider: 'qwen', model: 'model with spaces', outcome: 'failed', errorCode: 'provider_timeout',
          durationMs: 30000, text: SECRET_TEXT, raw: { body: SECRET_TEXT } },
        { provider: 'someone_else', outcome: 'succeeded', durationMs: 5 },
      ],
    },
  });
  assert.deepEqual(Object.keys(record.attempts[0]).sort(), [
    'completion_tokens', 'duration_ms', 'error_code', 'finish_reason', 'model', 'outcome',
    'output_chars', 'prompt_tokens', 'provider', 'reasoning_tokens', 'validation_failure',
  ]);
  assert.equal(record.attempts.length, 1, 'an unknown provider is dropped');
  assert.equal(record.attempts[0].model, null, 'a free-text model token is dropped');
  assert.equal(record.error_code, null, 'a free-text error code is dropped');
  assert.equal(record.validation_failure, null, 'a free-text validation failure is dropped');
  assert.ok(!JSON.stringify(record).includes('ribs'), 'no content reaches the record');
});

await test('an unusable record is skipped, never thrown', async () => {
  assert.equal(buildAiRunRecord({ task: 'bad task', jobKind: 'client_state', outcome: 'failed',
    promptVersion: 'v', schemaVersion: 'v' }), null);
  assert.equal(await recordAiRun(recorder(), null), 'skipped');
  assert.equal(await recordAiRun({ rpc: async () => { throw new Error(SECRET_TEXT); } },
    buildAiRunRecord({ task: 'crm_client_state', jobKind: 'client_state', outcome: 'failed',
      promptVersion: 'v', schemaVersion: 'v' })), 'failed');
});

await test('client state: fallback run records per-attempt facts without content', async () => {
  const db = recorder();
  const env = fakeEnv({ ...validAnalysis, brief: { ...validBrief, stage: 'confirmed' } }, validAnalysis);
  const outcome = await processCrmAgentJob(env, clientJob, { supabase: db, runTask: runModelTask });
  assert.equal(outcome.outcome, 'succeeded');
  assert.deepEqual(db.calls.map((c) => c.name), ['service_complete_client_ai_state_job']);
  assert.equal(db.telemetry.length, 1);
  const run = db.telemetry[0];
  assert.equal(run.task, 'crm_client_state');
  assert.equal(run.job_kind, 'client_state');
  assert.equal(run.job_id, JOB_ID);
  assert.equal(run.route_source, 'env');
  assert.equal(run.fallback_used, true);
  assert.equal(run.final_provider, 'workers_ai');
  assert.equal(run.quality_tier, 'fallback');
  assert.equal(run.outcome, 'succeeded');
  assert.equal(run.attempts.length, 2);
  assert.equal(run.attempts[0].provider, 'qwen');
  assert.equal(run.attempts[0].error_code, 'output_invalid');
  assert.equal(run.attempts[0].validation_failure, 'brief.stage');
  assert.equal(run.attempts[0].finish_reason, 'stop');
  assert.equal(run.attempts[0].reasoning_tokens, 400);
  assert.equal(run.attempts[1].outcome, 'succeeded');
  assert.equal(run.attempts[1].completion_tokens, 600);
  assert.ok(run.input_chars > 0);
  const serialized = JSON.stringify(run);
  for (const secret of [SECRET_NAME, SECRET_TEXT, 'dragon', 'Ribs', 'October', 'You maintain']) {
    assert.ok(!serialized.includes(secret), `telemetry must not contain "${secret}"`);
  }
  // No key could carry a sentence.
  for (const [key, value] of Object.entries(run)) {
    if (typeof value === 'string') assert.ok(!/\s/.test(value), `${key} must be a bounded token`);
  }
});

await test('client state: provider outage records both failed attempts and releases the job first', async () => {
  const db = recorder();
  const env = { ...fakeEnv(new Error(`binding failed for ${SECRET_NAME}`), null) };
  env.AI.run = async () => { throw new Error(`binding failed for ${SECRET_NAME}`); };
  const outcome = await processCrmAgentJob(env, clientJob, { supabase: db, runTask: runModelTask });
  assert.equal(outcome.errorCode, 'ai_unavailable');
  assert.deepEqual(db.calls.map((c) => c.name), ['service_fail_crm_agent_job']);
  const run = db.telemetry[0];
  assert.equal(run.outcome, 'failed');
  assert.equal(run.error_code, 'all_providers_failed');
  assert.deepEqual(run.attempts.map((a) => a.error_code), ['provider_unavailable', 'provider_unavailable']);
  assert.equal(run.final_provider, null);
  assert.equal(run.quality_tier, 'none');
  assert.ok(!JSON.stringify(run).includes(SECRET_NAME));
});

await test('client state: a stale completion is recorded as stale', async () => {
  const db = recorder({ service_complete_client_ai_state_job: { status: 'stale' } });
  const outcome = await processCrmAgentJob(fakeEnv(validAnalysis, validAnalysis), clientJob,
    { supabase: db, runTask: runModelTask });
  assert.equal(outcome.outcome, 'stale');
  assert.equal(db.telemetry[0].outcome, 'stale');
  assert.equal(db.telemetry[0].quality_tier, 'primary');
});

await test('client state: telemetry failure never changes the job outcome', async () => {
  const calls = [];
  const db = {
    rpc: async (name) => {
      if (name === 'service_record_ai_run') throw new Error('database down');
      calls.push(name);
      return { status: 'succeeded' };
    },
  };
  const outcome = await processCrmAgentJob(fakeEnv(validAnalysis, validAnalysis), clientJob,
    { supabase: db, runTask: runModelTask });
  assert.equal(outcome.outcome, 'succeeded');
  assert.deepEqual(calls, ['service_complete_client_ai_state_job']);
});

await test('client state: refused input is recorded with zero attempts', async () => {
  const db = recorder();
  const outcome = await processCrmAgentJob({ CRM_AGENT_ENABLED: 'true' }, { ...clientJob, input: null },
    { supabase: db, runTask: async () => { throw new Error('must not be called'); } });
  assert.equal(outcome.errorCode, 'input_invalid');
  assert.equal(db.telemetry[0].attempts.length, 0);
  assert.equal(db.telemetry[0].error_code, 'input_invalid');
});

await test('diagnosers name the location of a contract break, never its value', () => {
  assert.equal(diagnoseClientStateAnalysis(validAnalysis), null);
  assert.equal(diagnoseClientStateAnalysis({ ...validAnalysis, extra: 1 }), 'top_level.keys');
  assert.equal(diagnoseClientStateAnalysis({ ...validAnalysis, next_action: {
    ...validAnalysis.next_action, action_type: 'request_deposit', draft_reply: 'Please could you confirm the size?' } }),
  'next_action.draft_not_allowed');
  assert.equal(diagnoseClientStateAnalysis({ ...validAnalysis, next_action: {
    ...validAnalysis.next_action, action_type: 'follow_up', draft_reply: 'Your slot is booked, pay here' } }),
  'next_action.draft_unsafe');
  assert.equal(diagnoseReferenceImageAnalysis({ image_kind: 'selfie' }), 'top_level.keys');
});

await test('enquiry intake: records a run after the job completes', async () => {
  const db = recorder();
  const outcome = await processEnquiryAiJob({ CRM_AI_INTAKE_ENABLED: 'true' }, {
    job_id: JOB_ID, lease_token: LEASE,
    input: { client: { full_name: SECRET_NAME }, enquiry: { idea: SECRET_TEXT } },
  }, {
    supabase: db,
    runTask: async () => ({ ok: false, errorCode: 'all_providers_failed', routeSource: 'env', durationMs: 480,
      attempts: [{ provider: 'qwen', model: 'cf-qwen-qwen3.8-27b', outcome: 'failed',
        errorCode: 'provider_unavailable', durationMs: 477 }] }),
  });
  assert.equal(outcome.errorCode, 'ai_unavailable');
  assert.deepEqual(db.calls.map((c) => c.name), ['service_fail_enquiry_ai_job']);
  const run = db.telemetry[0];
  assert.equal(run.task, 'enquiry_intake');
  assert.equal(run.attempts[0].error_code, 'provider_unavailable');
  assert.equal(run.attempts[0].duration_ms, 477);
  assert.ok(!JSON.stringify(run).includes(SECRET_NAME));
});


await test('attention shadow recording is fail-open and gated', async () => {
  const calls = [];
  const ok = { rpc: async (name) => { calls.push(name); return { status: 'throttled' }; } };
  assert.equal(await recordAttentionShadow({ CRM_AGENT_ENABLED: 'true' }, { supabase: ok }), 'throttled');
  assert.deepEqual(calls, ['service_record_attention_shadow']);
  assert.equal(await recordAttentionShadow({}, { supabase: ok }), 'disabled');
  const broken = { rpc: async () => { throw new Error('down'); } };
  assert.equal(await recordAttentionShadow({ CRM_AGENT_ENABLED: 'true' }, { supabase: broken }), 'failed');
});

await test('brief convergence asks the database with a small budget and is fail-open', async () => {
  const calls = [];
  const ok = { rpc: async (name, args) => { calls.push({ name, args }); return { status: 'ok', queued: 2 }; } };
  assert.equal(await convergeClientAiBriefs({ CRM_AGENT_ENABLED: 'true' }, { supabase: ok }), 'off',
    'the sweep is opt-in because it spends the shared daily AI allocation');
  assert.deepEqual(calls, []);
  assert.equal(await convergeClientAiBriefs({ CRM_AGENT_ENABLED: 'true', CRM_BRIEF_CONVERGE_PER_HOUR: '4' }, { supabase: ok }), 'ok');
  assert.deepEqual(calls, [{ name: 'service_converge_client_ai_briefs', args: { p_limit: 4 } }]);
  assert.equal(await convergeClientAiBriefs({}, { supabase: ok }), 'disabled');
  const broken = { rpc: async () => { throw new Error('down'); } };
  assert.equal(await convergeClientAiBriefs({ CRM_AGENT_ENABLED: 'true', CRM_BRIEF_CONVERGE_PER_HOUR: '4' }, { supabase: broken }), 'failed');
});

console.log(`ai telemetry: ${passes} tests passed`);
