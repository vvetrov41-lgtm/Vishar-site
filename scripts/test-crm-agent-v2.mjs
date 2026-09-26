#!/usr/bin/env node
// Phase 3 narrow client-state contract (CRM_AGENT_CONTRACT=v2).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processCrmAgentJob, projectClientStateInput, contractVersion } from '../workers/lib/crm-agent.js';
import {
  CLIENT_DRAFT_PROMPT_VERSION, CLIENT_DRAFT_SYSTEM, CLIENT_STATE_V2_PROMPT_VERSION, CLIENT_STATE_V2_SYSTEM,
  diagnoseClientStateV2, normalizeClientStateV2,
} from '../workers/lib/ai/client-state-schema.js';

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const env = { CRM_AGENT_ENABLED: 'true', CRM_AGENT_CONTRACT: 'v2' };

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; }
  catch (error) { console.error(`FAIL ${name}\n${error.stack ?? error.message}`); process.exitCode = 1; }
}

const attention = {
  last_speaker: 'client', reply_state: 'unknown', workflow_stage: 'booked', deposit_state: 'paid',
  has_future_tattoo_session: true, has_future_consultation: false, next_session_at: '2026-10-05T10:00:00Z',
  sla_state: 'ok', sla_reason: 'studio_reply_owed', waiting_on_candidate: 'artist',
  allowed_actions: ['artist_review', 'follow_up', 'no_action'], conflicts: [], client_id: 'must-not-leak',
};
const job = (overrides = {}) => ({
  job_id: JOB_ID, lease_token: LEASE, job_type: 'refresh_client_ai_state',
  input: {
    client: { full_name: 'Tia Example' }, artist: { display_name: 'Studio' }, enquiries: [],
    crm_facts: { projects: [], sessions: [] },
    timeline: [{ source: 'communication', direction: 'inbound', text: 'Can I bring a friend on the day?', occurred_at: '2026-09-23T10:00:00Z' }],
    reference_images: [], previous_brief: null, attention, ...overrides,
  },
});
const discussed = Object.fromEntries(['session_estimate', 'price', 'deposit', 'candidate_dates', 'confirmed_dates']
  .map((k) => [k, { value: null, status: 'not_discussed' }]));
const answer = (overrides = {}) => ({
  summary: 'Booked client asking about bringing a friend.',
  brief: {
    project_summary: 'Booked session.', placement: null, style: null, colour: null, size: null,
    cover_up_context: null, constraints: [], decisions_made: [], open_questions: [], promises_to_client: [],
    last_interaction: 'Asked about bringing a friend.', discussed,
  },
  reply_state: 'reply_required',
  next_action: { action_type: 'follow_up', reason: 'Answer the question about the friend.', priority: 'normal', missing_information: [] },
  ...overrides,
});
const recorder = () => {
  const calls = [];
  const telemetry = [];
  return {
    calls, telemetry,
    rpc: async (name, args) => {
      if (name === 'service_record_ai_run') { telemetry.push(args.p_run); return { status: 'recorded' }; }
      calls.push({ name, args });
      return { status: 'succeeded' };
    },
  };
};
const runTaskWith = (stateAnswer, draftAnswer = { draft_reply: 'Of course, a friend is welcome to come along.' }) =>
  async (_env, task, request, deps) => {
    const json = task === 'crm_draft_reply' ? draftAnswer : stateAnswer;
    const verdict = deps.validateJson(json);
    if (verdict !== true) return { ok: false, errorCode: 'all_providers_failed', attempts: [], routeSource: 'default', durationMs: 5 };
    return { ok: true, json, provider: 'qwen', model: '@cf/qwen/qwen3.8-27b', attempts: [], routeSource: 'default', durationMs: 5, request };
  };

await test('the contract switch defaults to v1', () => {
  assert.equal(contractVersion({}), 'v1');
  assert.equal(contractVersion({ CRM_AGENT_CONTRACT: 'V2' }), 'v1');
  assert.equal(contractVersion({ CRM_AGENT_CONTRACT: 'v2' }), 'v2');
});

await test('the v2 projection carries named workflow facts and never an identifier', () => {
  const projected = projectClientStateInput(job().input, { contract: 'v2' });
  const parsed = JSON.parse(projected);
  assert.deepEqual(parsed.untrusted_crm_data.crm_workflow_facts.allowed_actions, attention.allowed_actions);
  assert.ok(!projected.includes('must-not-leak'));
  assert.equal(projectClientStateInput({ ...job().input, attention: null }, { contract: 'v2' }), null);
  assert.ok(!projectClientStateInput(job().input).includes('crm_workflow_facts'), 'v1 prompts are unchanged');
});

await test('v2 stores deterministic stage and waiting side, a separate draft and a reply mark', async () => {
  const db = recorder();
  const outcome = await processCrmAgentJob(env, job(), { supabase: db, runTask: runTaskWith(answer()) });
  assert.equal(outcome.outcome, 'succeeded');
  const complete = db.calls.find((c) => c.name === 'service_complete_client_ai_state_job').args;
  assert.equal(complete.p_brief.stage, 'booked');
  assert.equal(complete.p_brief.waiting_on, 'artist');
  assert.equal(complete.p_next_action.draft_reply, 'Of course, a friend is welcome to come along.');
  assert.deepEqual(db.calls.map((c) => c.name), ['service_complete_client_ai_state_job', 'service_record_client_reply_state']);
  assert.equal(db.calls[1].args.p_reply_state, 'reply_required');
  assert.deepEqual(db.telemetry.map((r) => [r.task, r.schema_version]),
    [['crm_client_state', 'client-state.v2'], ['crm_draft_reply', 'client-draft.v1']]);
});

await test('an action outside allowed_actions is rejected before anything is stored', async () => {
  const db = recorder();
  const outcome = await processCrmAgentJob(env, job(), { supabase: db,
    runTask: runTaskWith(answer({ next_action: { ...answer().next_action, action_type: 'request_deposit' } })) });
  assert.equal(outcome.errorCode, 'ai_unavailable');
  assert.deepEqual(db.calls.map((c) => c.name), ['service_fail_crm_agent_job']);
  assert.equal(diagnoseClientStateV2(answer({ next_action: { ...answer().next_action, action_type: 'request_deposit' } }),
    attention.allowed_actions), 'next_action.not_allowed');
});

await test('an unsafe draft becomes null while the analysis is kept', async () => {
  const db = recorder();
  const outcome = await processCrmAgentJob(env, job(), { supabase: db,
    runTask: runTaskWith(answer(), { draft_reply: 'Your booking is confirmed, pay here: https://x.example' }) });
  assert.equal(outcome.outcome, 'succeeded');
  const complete = db.calls.find((c) => c.name === 'service_complete_client_ai_state_job').args;
  assert.equal(complete.p_next_action.draft_reply, null);
  assert.equal(db.telemetry[1].outcome, 'failed');
});

await test('no draft is requested for a non-draftable action; no mark for unclear', async () => {
  const db = recorder();
  const calledTasks = [];
  const base = runTaskWith(answer({ reply_state: 'unclear', next_action: { ...answer().next_action, action_type: 'no_action' } }));
  await processCrmAgentJob(env, job(), { supabase: db, runTask: async (...args) => { calledTasks.push(args[1]); return base(...args); } });
  assert.deepEqual(calledTasks, ['crm_client_state']);
  assert.deepEqual(db.calls.map((c) => c.name), ['service_complete_client_ai_state_job']);
});

await test('v2 refuses a job without deterministic facts', async () => {
  const db = recorder();
  const outcome = await processCrmAgentJob(env, job({ attention: undefined }), { supabase: db,
    runTask: async () => { throw new Error('must not be called'); } });
  assert.equal(outcome.errorCode, 'input_invalid');
});

await test('the v2 prompt never asks the model for stage, waiting side or a draft', () => {
  assert.ok(!/\bstage is one of\b/.test(CLIENT_STATE_V2_SYSTEM));
  assert.ok(!/draft_reply/.test(CLIENT_STATE_V2_SYSTEM));
  assert.ok(/allowed_actions/.test(CLIENT_STATE_V2_SYSTEM));
});

await test('v2 and draft prompt versions are pinned to the prompt text', () => {
  const sha = (t) => createHash('sha256').update(t).digest('hex');
  assert.equal(sha(CLIENT_STATE_V2_SYSTEM), 'aa62dfd4b6ebbf64088803042ba9a245e6400549a806b0760d6fe62de1b15433',
    `v2 prompt changed: bump CLIENT_STATE_V2_PROMPT_VERSION (${CLIENT_STATE_V2_PROMPT_VERSION})`);
  assert.equal(sha(CLIENT_DRAFT_SYSTEM), '3eef5743c982374f5a1b8619ae08c8caea199cf54661e62a7d14673790079e0b',
    `draft prompt changed: bump CLIENT_DRAFT_PROMPT_VERSION (${CLIENT_DRAFT_PROMPT_VERSION})`);
});

await test('container repair fixes blanks and bare strings, never content', () => {
  const allowed = attention.allowed_actions;
  const base = answer();
  const broken = { ...base, brief: { ...base.brief, size: '  ', open_questions: ['Which arm?', '', ' '], constraints: 'No red ink' },
    next_action: { ...base.next_action, missing_information: ['', 'placement'] } };
  assert.equal(diagnoseClientStateV2(broken, allowed), 'brief.size.empty');
  const fixed = normalizeClientStateV2(broken);
  assert.equal(diagnoseClientStateV2(fixed, allowed), null);
  assert.equal(fixed.brief.size, null);
  assert.deepEqual(fixed.brief.open_questions, ['Which arm?']);
  assert.deepEqual(fixed.brief.constraints, ['No red ink']);
  assert.deepEqual(fixed.next_action.missing_information, ['placement']);
  assert.equal(broken.brief.size, '  ', 'the input is not mutated');
  const loneMissing = normalizeClientStateV2({ ...base, next_action: { ...base.next_action, missing_information: 'placement' } });
  assert.deepEqual(loneMissing.next_action.missing_information, ['placement']);
  assert.equal(diagnoseClientStateV2(loneMissing, allowed), null);
  const objectMissing = normalizeClientStateV2({ ...base, next_action: { ...base.next_action, missing_information: [{ f: 1 }] } });
  assert.equal(diagnoseClientStateV2(objectMissing, allowed), 'next_action.missing_information');
  // Objects, numbers and over-long values stay invalid, with a content-free location.
  const objectItem = normalizeClientStateV2({ ...base, brief: { ...base.brief, open_questions: [{ q: 'x' }] } });
  assert.equal(diagnoseClientStateV2(objectItem, allowed), 'brief.open_questions.item_object');
  const numericSize = normalizeClientStateV2({ ...base, brief: { ...base.brief, size: 15 } });
  assert.equal(diagnoseClientStateV2(numericSize, allowed), 'brief.size.number');
  const long = normalizeClientStateV2({ ...base, brief: { ...base.brief, size: 'x'.repeat(301) } });
  assert.equal(diagnoseClientStateV2(long, allowed), 'brief.size.long');
  assert.equal(normalizeClientStateV2(null), null);
  for (const code of ['brief.open_questions.item_object', 'brief.size.number', 'brief.size.long']) {
    assert.match(code, /^[a-z][a-z0-9_.]{2,79}$/, 'telemetry code format');
  }
});

console.log(`crm agent v2: ${passes} tests passed`);
