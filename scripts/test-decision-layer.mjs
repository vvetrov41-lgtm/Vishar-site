#!/usr/bin/env node
// Offline tests for the decision-layer contract and transport. No network.
import assert from 'node:assert/strict';
import {
  ACTION_MIN_CONFIDENCE, BOOLEAN_MARGIN, buildDecisionState, buildQuestions, decide,
  routesToReview, sanitizeAllowedActions,
} from '../workers/lib/ai/decision-contract.js';
import { decisionModelConfig, requestDecision } from '../workers/lib/ai/decision-model.js';

let passes = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const KEY = 'k'.repeat(40);
const allowed = ['artist_review', 'follow_up', 'no_action'];
const confident = {
  reply_needed: { noul: 0.95 }, commitment_risk: { noul: 0.05 }, human_review_needed: { noul: 0.1 },
  next_action: { choice: 'no_action', confidence: 0.9 },
};

await test('the payload carries only minimal state and clipped messages', () => {
  const state = buildDecisionState({
    stage: 'booked', deposit_state: 'paid', has_future_tattoo_session: true, has_future_consultation: false,
    last_speaker: 'client', hours_since_last_contact: 5.4, allowed_actions: ['no_action', 'bogus', 'artist_review'],
    latest_client_message: `  ${'x'.repeat(5000)}  `, previous_studio_message: '',
    full_name: 'Private Person', email: 'private@example.invalid', price: 500,
  });
  assert.deepEqual(Object.keys(state).sort(), [
    'allowed_actions', 'deposit_state', 'has_future_consultation', 'has_future_tattoo_session',
    'hours_since_last_contact', 'last_speaker', 'latest_client_message', 'previous_studio_message', 'stage',
  ]);
  assert.deepEqual(state.allowed_actions, ['artist_review', 'no_action']);
  assert.equal(state.latest_client_message.length, 1000);
  assert.equal(state.previous_studio_message, null);
  assert.equal(state.hours_since_last_contact, 5);
  assert.ok(!JSON.stringify(state).includes('Private Person'));
});

await test('the action choice set is exactly the allowed list', () => {
  const q = buildQuestions(['no_action', 'confirm_booking', 'x']);
  assert.deepEqual(Object.keys(q.next_action.criteria), ['confirm_booking', 'no_action']);
  assert.deepEqual(sanitizeAllowedActions(null), []);
});

await test('confident answers are used; unsure ones abstain', () => {
  const d = decide(confident, allowed);
  assert.deepEqual(d.answered, { reply_needed: true, commitment_risk: false, human_review_needed: false, next_action: 'no_action' });
  const unsure = decide({
    ...confident, reply_needed: { noul: 0.5 + BOOLEAN_MARGIN - 0.01 },
    next_action: { choice: 'no_action', confidence: ACTION_MIN_CONFIDENCE - 0.01 },
  }, allowed);
  assert.ok(unsure.abstained.includes('reply_needed'));
  assert.ok(unsure.abstained.includes('next_action'));
});

await test('an action outside the server list is never used, whatever its confidence', () => {
  const d = decide({ ...confident, next_action: { choice: 'confirm_booking', confidence: 0.99 } }, allowed);
  assert.equal(d.action_allowed, false);
  assert.equal('next_action' in d.answered, false);
});

await test('malformed answers are invalid, not guessed', () => {
  assert.ok(decide({ ...confident, reply_needed: { noul: 1.5 } }, allowed).invalid);
  assert.ok(decide({ ...confident, next_action: { choice: 'send_money' } }, allowed).invalid);
  assert.ok(decide(null, allowed).invalid);
  for (const bad of [null, false, '', '0.1', undefined]) {
    assert.ok(decide({ ...confident, commitment_risk: { noul: bad } }, allowed).invalid, `noul ${String(bad)}`);
  }
  // A non-numeric confidence never makes an action usable.
  const noConf = decide({ ...confident, next_action: { choice: 'no_action', confidence: '0.99' } }, allowed);
  assert.equal('next_action' in noConf.answered, false);
});

await test('review routing is fail-closed', () => {
  assert.equal(routesToReview({ commitment_risk_p: 0.1, human_review_needed_p: 0.1 }), false);
  assert.equal(routesToReview({ commitment_risk_p: 0.9, human_review_needed_p: 0.1 }), true);
  assert.equal(routesToReview({ commitment_risk_p: 0.1, human_review_needed_p: 0.45 }), true);
  assert.equal(routesToReview({ commitment_risk_p: 0.25, human_review_needed_p: 0.05 }), true);
});

await test('transport is off without a key and never sends without allowed actions', async () => {
  assert.equal(decisionModelConfig({}), null);
  assert.equal(decisionModelConfig({ DECISION_MODEL_API_KEY: 'short' }), null);
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}'); };
  assert.equal((await requestDecision(null, { allowed_actions: allowed }, { fetchImpl })).code, 'not_configured');
  const config = decisionModelConfig({ DECISION_MODEL_API_KEY: KEY });
  assert.equal((await requestDecision(config, { allowed_actions: [] }, { fetchImpl })).code, 'no_allowed_actions');
  assert.equal(called, false);
});

await test('a good answer becomes a typed decision; the key and text stay out of the result', async () => {
  const seen = [];
  const config = decisionModelConfig({ DECISION_MODEL_API_KEY: KEY, DECISION_MODEL: 'not a model id' });
  assert.equal(config.model, 'typesafe/jev-1.13');
  const state = buildDecisionState({ stage: 'booked', allowed_actions: allowed, latest_client_message: 'Thanks, see you!' });
  const result = await requestDecision(config, state, {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return Response.json({ answers: confident, model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { cost: 0.00004, input_tokens: 900 } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.answered.next_action, 'no_action');
  assert.equal(result.model, 'typesafe/jev-1.13-20260917');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.deepEqual(Object.keys(JSON.parse(seen[0].init.body).questions.next_action.criteria), allowed);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes('see you'));
});

await test('every transport failure is a bounded code', async () => {
  const config = decisionModelConfig({ DECISION_MODEL_API_KEY: KEY });
  const state = { allowed_actions: allowed };
  const code = async (fetchImpl) => (await requestDecision(config, state, { fetchImpl })).code;
  assert.equal(await code(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } })), 'redirect_refused');
  assert.equal(await code(async () => new Response('x', { status: 429 })), 'rate_limited');
  assert.equal(await code(async () => new Response('x', { status: 401 })), 'unauthorized');
  assert.equal(await code(async () => new Response('x', { status: 402 })), 'payment_required');
  assert.equal(await code(async () => new Response('x', { status: 503 })), 'provider_error');
  assert.equal(await code(async () => new Response('not json')), 'malformed');
  assert.equal(await code(async () => Response.json({ answers: {} })), 'answer_invalid');
  assert.equal(await code(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), 'timeout');
  assert.equal(await code(async () => { throw new Error('dns'); }), 'network');
});

if (!process.exitCode) console.log(`decision layer: ${passes} tests passed`);
