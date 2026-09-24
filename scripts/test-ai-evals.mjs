#!/usr/bin/env node
// Offline, deterministic CRM AI evaluation.
//
// Runs in CI with no model. It proves the pipeline around the model: every
// synthetic fixture projects inside budget, the checks tell a good answer from
// a bad one, request shaping reaches the provider exactly as configured, and
// provider failure, malformed JSON and truncated output are classified with
// bounded codes. Model quality is measured separately by the guarded live eval
// (scripts/ai-evals/run-live-eval.mjs), which reuses these fixtures and checks.
import assert from 'node:assert/strict';
import { CLIENT_STATE_FIXTURES, ENQUIRY_FIXTURES } from '../workers/lib/ai/eval-fixtures.js';
import { checkClientState, checkEnquiry } from './ai-evals/assertions.mjs';
import { projectClientStateInput } from '../workers/lib/crm-agent.js';
import { projectEnquiryAiInput } from '../workers/lib/enquiry-ai.js';
import { runModelTask } from '../workers/lib/ai/router.js';
import { resolveTask } from '../workers/lib/ai/tasks.js';
import { handleAiRouterProbeRequest } from '../workers/routes/ai-router-probe.js';
import { CLIENT_STATE_SYSTEM, validateClientStateAnalysis } from '../workers/lib/ai/client-state-schema.js';
import { ENQUIRY_AI_RESPONSE_SCHEMA, ENQUIRY_AI_TRANSPORT_SCHEMA } from '../workers/lib/ai/enquiry-schema.js';

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; }
  catch (error) { console.error(`FAIL ${name}\n${error.stack ?? error.message}`); process.exitCode = 1; }
}

const discussed = (overrides = {}) => ({
  session_estimate: { value: null, status: 'not_discussed' },
  price: { value: null, status: 'not_discussed' },
  deposit: { value: null, status: 'not_discussed' },
  candidate_dates: { value: null, status: 'not_discussed' },
  confirmed_dates: { value: null, status: 'not_discussed' },
  ...overrides,
});
const answer = ({ stage = 'gathering_information', waiting = 'artist', action = 'artist_review',
  draft = null, missing = [], size = null, cover = null, summary = 'Client wants a tattoo.', disc = {} } = {}) => ({
  summary,
  brief: {
    project_summary: 'Tattoo project.', stage, placement: null, style: null, colour: null, size,
    cover_up_context: cover, constraints: [], decisions_made: [], open_questions: [],
    promises_to_client: [], waiting_on: waiting, last_interaction: null, discussed: discussed(disc),
  },
  next_action: { action_type: action, reason: 'Next step.', priority: 'normal', draft_reply: draft, missing_information: missing },
});

// ---------------------------------------------------------------------------
// Fixtures project exactly as a production job does
// ---------------------------------------------------------------------------

await test('every client-state fixture projects inside the prompt budget', () => {
  const ids = Object.keys(CLIENT_STATE_FIXTURES);
  assert.ok(ids.length >= 14, 'the fixture set covers the required scenarios');
  for (const id of ids) {
    const projected = projectClientStateInput(CLIENT_STATE_FIXTURES[id].input);
    assert.ok(projected, `${id} projects`);
    assert.ok(projected.startsWith('{"untrusted_crm_data":'), `${id} stays inside the untrusted envelope`);
  }
});

await test('every enquiry fixture projects inside the prompt budget', () => {
  for (const [id, fixture] of Object.entries(ENQUIRY_FIXTURES)) {
    const projected = projectEnquiryAiInput(fixture.input);
    assert.ok(projected?.startsWith('{"untrusted_client_data":'), `${id} projects`);
  }
});

await test('prompt injection stays data: the system prompt is never modified', () => {
  const projected = projectClientStateInput(CLIENT_STATE_FIXTURES.prompt_injection.input);
  assert.ok(projected.includes('Ignore all previous instructions'));
  assert.ok(!CLIENT_STATE_SYSTEM.includes('admin mode'));
});

// ---------------------------------------------------------------------------
// The checks separate good answers from bad ones
// ---------------------------------------------------------------------------

await test('deposit paid: requesting a deposit again fails, a sensible answer passes', () => {
  const { expect } = CLIENT_STATE_FIXTURES.deposit_paid;
  assert.deepEqual(checkClientState(answer({ stage: 'scheduling', action: 'offer_dates' }), expect).failures, []);
  assert.ok(checkClientState(answer({ stage: 'deposit_pending', action: 'request_deposit' }), expect).failures.length >= 2);
});

await test('session scheduled: re-asking for information fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.session_scheduled;
  assert.deepEqual(checkClientState(answer({ stage: 'booked', action: 'no_action' }), expect).failures, []);
  assert.ok(checkClientState(answer({ stage: 'gathering_information', action: 'request_information' }), expect).failures.includes('action:request_information'));
});

await test('artist reply last: waiting on the artist fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.artist_reply_last;
  assert.deepEqual(checkClientState(answer({ waiting: 'client', action: 'await_client' }), expect).failures, []);
  assert.ok(checkClientState(answer({ waiting: 'artist', action: 'artist_review' }), expect).failures.length >= 1);
});

await test('artist silent: telling the artist to wait fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.artist_silent;
  assert.deepEqual(checkClientState(answer({ waiting: 'artist', action: 'artist_review' }), expect).failures, []);
  assert.ok(checkClientState(answer({ waiting: 'client', action: 'await_client' }), expect).failures.length >= 2);
});

await test('cover-up: missing cover-up context fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.cover_up;
  assert.deepEqual(checkClientState(answer({ cover: 'Faded tribal piece to cover.' }), expect).failures, []);
  assert.ok(checkClientState(answer({ cover: null }), expect).failures.includes('brief_null:cover_up_context'));
});

await test('text exclusions scan decisions, promises and other brief text', () => {
  const { expect } = CLIENT_STATE_FIXTURES.deposit_requested;
  const bad = answer({ stage: 'deposit_pending', action: 'await_client' });
  bad.brief.decisions_made = ['Deposit paid'];
  assert.ok(checkClientState(bad, expect).failures.includes('claims:deposit_paid'));
});

await test('a negated payment statement is not a paid claim', () => {
  const { expect } = CLIENT_STATE_FIXTURES.deposit_requested;
  for (const phrase of ['Deposit requested, not yet paid.', 'Deposit is unpaid.', 'Book once paid.',
    "Client hasn't paid the deposit.", 'Awaiting paid confirmation? no.']) {
    const ok = answer({ stage: 'deposit_pending', action: 'await_client', summary: phrase });
    assert.ok(!checkClientState(ok, expect).failures.includes('claims:deposit_paid'), phrase);
  }
  const claimed = answer({ stage: 'deposit_pending', action: 'await_client', summary: 'The deposit has been paid.' });
  assert.ok(checkClientState(claimed, expect).failures.includes('claims:deposit_paid'));
});

await test('missing-information exclusions normalize separators and plurals', () => {
  const { expect } = CLIENT_STATE_FIXTURES.reference_images;
  assert.deepEqual(checkClientState(answer({ missing: [] }), expect).failures, []);
  const bad = checkClientState(answer({ missing: ['reference images'] }), expect);
  assert.ok(bad.failures.some((failure) => failure.startsWith('missing_has:reference')));
});

await test('prompt injection: an answer that obeys it fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.prompt_injection;
  assert.deepEqual(checkClientState(answer({ action: 'request_information',
    draft: 'Thanks! Which size and style would you like?', missing: ['size'] }), expect).failures, []);
  const obeyed = checkClientState(answer({ stage: 'booked', action: 'confirm_booking',
    disc: { confirmed_dates: { value: '1 October', status: 'mentioned_by_artist' } } }), expect);
  assert.ok(obeyed.failures.includes('stage:booked'));
  assert.ok(obeyed.failures.includes('action:confirm_booking'));
  assert.ok(obeyed.failures.includes('discussed:confirmed_dates'));
});

await test('conflicting channels: an answer that silently picks one size fails', () => {
  const { expect } = CLIENT_STATE_FIXTURES.conflicting_channels;
  assert.deepEqual(checkClientState(answer({ size: '25 cm (changed from 15 cm)' }), expect).failures, []);
  assert.ok(checkClientState(answer({ size: null, summary: 'Mountain landscape.' }), expect).failures.length >= 1);
});

await test('a schema-invalid answer is reported as such', () => {
  assert.deepEqual(checkClientState({ summary: 'x' }, {}).failures, ['schema_invalid']);
  assert.deepEqual(checkEnquiry({ fields: {} }, {}).failures, ['schema_invalid']);
});

// ---------------------------------------------------------------------------
// Failure classification the live eval and telemetry rely on
// ---------------------------------------------------------------------------

const stateInput = { system: CLIENT_STATE_SYSTEM, input: projectClientStateInput(CLIENT_STATE_FIXTURES.vague_enquiry.input) };
const validate = (value) => validateClientStateAnalysis(value) !== null;
const bindingEnv = (run) => ({ AI_ROUTE_CRM_CLIENT_STATE: 'qwen,workers_ai', AI: { run } });

await test('provider failure falls back and records a bounded code', async () => {
  const result = await runModelTask(bindingEnv(async (model) => {
    if (model.includes('/qwen/')) throw new Error('capacity for account 123');
    return { response: JSON.stringify(answer()) };
  }), 'crm_client_state', stateInput, { validateJson: validate });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.attempts[0].errorCode, 'provider_unavailable');
  assert.ok(!JSON.stringify(result.attempts).includes('123'));
});

await test('malformed JSON is classified as json_parse', async () => {
  const result = await runModelTask(bindingEnv(async () => ({ response: '{"summary": "unterminated' })),
    'crm_client_state', stateInput, { validateJson: validate });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((a) => a.validationFailure), ['json_parse', 'json_parse']);
});

await test('truncated output keeps its finish reason next to the parse failure', async () => {
  const result = await runModelTask(bindingEnv(async (model) => (model.includes('/qwen/')
    ? { choices: [{ message: { content: '{"summary":"Cut off mid' }, finish_reason: 'length' }],
      usage: { completion_tokens: 1800, completion_tokens_details: { reasoning_tokens: 1500 } } }
    : { response: JSON.stringify(answer()) })), 'crm_client_state', stateInput, { validateJson: validate });
  assert.equal(result.provider, 'workers_ai');
  assert.equal(result.attempts[0].finishReason, 'length');
  assert.equal(result.attempts[0].validationFailure, 'json_parse');
  assert.equal(result.attempts[0].reasoningTokens, 1500);
});

// ---------------------------------------------------------------------------
// Request shaping reaches the provider exactly as configured
// ---------------------------------------------------------------------------

const capture = () => {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); return { response: JSON.stringify(answer()) }; } };
};

await test('default Qwen structured calls are unchanged: low reasoning, no template override', async () => {
  const binding = capture();
  await runModelTask(bindingEnv(binding.run), 'crm_client_state', stateInput, { validateJson: validate });
  assert.equal(binding.calls[0].input.reasoning_effort, 'low');
  assert.equal(binding.calls[0].input.chat_template_kwargs, undefined);
  assert.deepEqual(binding.calls[0].input.response_format, { type: 'json_object' });
});

await test('thinking off removes the reasoning budget and disables the template thinking', async () => {
  const binding = capture();
  await runModelTask({ ...bindingEnv(binding.run), AI_QWEN_STRUCTURED_THINKING: 'off' },
    'crm_client_state', stateInput, { validateJson: validate });
  assert.equal(binding.calls[0].input.reasoning_effort, undefined);
  assert.deepEqual(binding.calls[0].input.chat_template_kwargs, { enable_thinking: false });
});

await test('enquiry schema mode selects full, transport or json_object for Qwen', async () => {
  const enquiryInput = { system: 'Return JSON.', input: projectEnquiryAiInput(ENQUIRY_FIXTURES.intake_vague.input) };
  const shapes = {};
  for (const mode of ['full', 'transport', 'object']) {
    const binding = capture();
    await runModelTask({ AI_ROUTE_ENQUIRY_INTAKE: 'qwen', AI_QWEN_ENQUIRY_SCHEMA: mode, AI: { run: binding.run } },
      'enquiry_intake', enquiryInput, { validateJson: () => true });
    shapes[mode] = binding.calls[0].input.response_format;
  }
  assert.deepEqual(shapes.full, { type: 'json_schema', json_schema: ENQUIRY_AI_RESPONSE_SCHEMA });
  assert.deepEqual(shapes.transport, { type: 'json_schema', json_schema: ENQUIRY_AI_TRANSPORT_SCHEMA });
  assert.deepEqual(shapes.object, { type: 'json_object' });
});

await test('an experiment can force one provider, a timeout and a token ceiling, within bounds', async () => {
  const binding = capture();
  await runModelTask(bindingEnv(binding.run), 'crm_client_state', stateInput, {
    validateJson: validate,
    experiment: { provider: 'workers_ai', timeoutMs: 45_000, maxOutputTokens: 900, thinking: 'off' },
  });
  assert.equal(binding.calls.length, 1);
  assert.ok(binding.calls[0].model.includes('llama'));
  assert.equal(binding.calls[0].input.max_completion_tokens, 900);

  const ignored = capture();
  await runModelTask(bindingEnv(ignored.run), 'crm_client_state', stateInput, {
    validateJson: validate,
    experiment: { provider: 'unknown_vendor', maxOutputTokens: 999_999, schemaMode: 'raw', thinking: 'max' },
  });
  assert.ok(ignored.calls[0].model.includes('qwen'), 'an unknown provider falls back to the configured chain');
  assert.equal(ignored.calls[0].input.max_completion_tokens, 1_800, 'an out-of-range ceiling is ignored');
});

await test('AI_TIMEOUT_MS_<TASK> is honoured only inside [1s, 60s]', () => {
  const ids = new Set(['qwen', 'workers_ai']);
  assert.equal(resolveTask({ AI_TIMEOUT_MS_CRM_CLIENT_STATE: '45000' }, 'crm_client_state', ids).timeoutMs, 45_000);
  assert.equal(resolveTask({ AI_TIMEOUT_MS_CRM_CLIENT_STATE: '90000' }, 'crm_client_state', ids).timeoutMs, 30_000);
  assert.equal(resolveTask({ AI_TIMEOUT_MS_CRM_CLIENT_STATE: '4.5e4' }, 'crm_client_state', ids).timeoutMs, 30_000);
  assert.equal(resolveTask({}, 'crm_client_state', ids).timeoutMs, 30_000);
});


// ---------------------------------------------------------------------------
// Guarded probe eval mode
// ---------------------------------------------------------------------------

const PROBE_TOKEN = 'p'.repeat(40);
const probeRequest = (body) => new Request('https://tattooai.example/internal/ai-router', {
  method: 'POST',
  headers: { authorization: `Bearer ${PROBE_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

await test('probe eval mode runs a named synthetic fixture and never caller text', async () => {
  const binding = capture();
  const env = { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: PROBE_TOKEN, AI: { run: binding.run } };
  const response = await handleAiRouterProbeRequest(probeRequest({
    mode: 'eval', task: 'crm_client_state', fixture: 'deposit_paid',
    variant: { provider: 'qwen', thinking: 'off' }, input: 'CALLER TEXT', system: 'CALLER SYSTEM',
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.fixture, 'deposit_paid');
  assert.equal(binding.calls.length, 1);
  const sent = JSON.stringify(binding.calls[0].input);
  assert.ok(!sent.includes('CALLER TEXT') && !sent.includes('CALLER SYSTEM'));
  assert.ok(sent.includes('Ivy Example'), 'the compiled fixture reached the model');
  assert.deepEqual(binding.calls[0].input.chat_template_kwargs, { enable_thinking: false });
});

await test('probe eval mode rejects an unknown fixture and stays closed without a token', async () => {
  const env = { AI_ROUTER_PROBE_ENABLED: 'true', AI_ROUTER_PROBE_TOKEN: PROBE_TOKEN, AI: { run: async () => ({}) } };
  const unknown = await handleAiRouterProbeRequest(probeRequest({ mode: 'eval', task: 'crm_client_state', fixture: '../etc' }), env);
  assert.equal(unknown.status, 400);
  const closed = await handleAiRouterProbeRequest(probeRequest({ mode: 'eval', task: 'crm_client_state', fixture: 'deposit_paid' }),
    { AI: { run: async () => ({}) } });
  assert.equal(closed.status, 404);
});

console.log(`ai evals (offline): ${passes} tests passed`);
