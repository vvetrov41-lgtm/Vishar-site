#!/usr/bin/env node
// Live candidate evaluation for TypeSafe Jev via OpenRouter Decisions API.
//
// Safety properties:
// - synthetic fixtures only;
// - no Supabase, Cloudflare, CRM or production message reads;
// - the OpenRouter key is read only from OPENROUTER_API_KEY and never logged;
// - logs/results contain fixture ids and typed decisions, never fixture text;
// - bounded retries, call count and total reported cost;
// - evaluation mismatches are evidence, not a CI failure. Transport/API failures fail.
//
// v2 measures what a fail-closed decision layer needs, per split (dev / holdout /
// baseline): accuracy on answered cases, abstention (low confidence -> the
// existing fallback), stability across repeated runs, allowed-action compliance,
// latency and reported cost.

import { appendFileSync, writeFileSync } from 'node:fs';
import {
  CRM_ACTIONS, JEV_FIXTURES, JEV_MODEL, allowedActions, buildQuestions,
} from './jev-decision-fixtures.mjs';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MAX_FIXTURES = 120;
const REPEATS = Math.min(Math.max(Number.parseInt(process.env.JEV_EVAL_REPEATS ?? '2', 10) || 2, 1), 3);
const MAX_CALLS = 300;
const MAX_TOTAL_COST_USD = 0.05;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000];

// Fail-closed thresholds. A boolean is answered only when its probability is
// at least this far from 0.5; the action only at or above this confidence.
// Anything else abstains, which in production means "keep the existing path".
export const BOOLEAN_MARGIN = 0.3; // p <= 0.2 or p >= 0.8
export const ACTION_MIN_CONFIDENCE = 0.6;

const ACTIONS = new Set(CRM_ACTIONS);
const BOOLEAN_QUESTIONS = ['reply_needed', 'commitment_risk', 'human_review_needed'];
const EXPECT_KEY = { reply_needed: 'reply', commitment_risk: 'commitment', human_review_needed: 'review' };

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const ratio = (n, d) => (d ? round(n / d) : null);

function selfTest() {
  if (!Array.isArray(JEV_FIXTURES) || !JEV_FIXTURES.length || JEV_FIXTURES.length > MAX_FIXTURES) {
    throw new Error('fixture_count_invalid');
  }
  if (JEV_FIXTURES.length * REPEATS > MAX_CALLS) throw new Error('call_budget_exceeded');
  const ids = new Set();
  const splits = { dev: 0, holdout: 0, holdout2: 0, baseline: 0 };
  let multiChoice = 0;
  for (const fixture of JEV_FIXTURES) {
    if (typeof fixture?.id !== 'string' || !fixture.id || ids.has(fixture.id)) throw new Error(`fixture_id_invalid:${fixture?.id}`);
    ids.add(fixture.id);
    if (!(fixture.split in splits)) throw new Error(`fixture_split_invalid:${fixture.id}`);
    splits[fixture.split] += 1;
    const allowed = fixture.state.allowed_actions;
    if (JSON.stringify(allowed) !== JSON.stringify(allowedActions(fixture.facts))) throw new Error(`allowed_mismatch:${fixture.id}`);
    if (!allowed.length || !allowed.every((a) => ACTIONS.has(a))) throw new Error(`allowed_invalid:${fixture.id}`);
    if (allowed.length > 1) multiChoice += 1;
    const { expect } = fixture;
    for (const key of ['reply', 'commitment', 'review']) {
      if (!(expect[key] === null || typeof expect[key] === 'boolean')) throw new Error(`expect_${key}_invalid:${fixture.id}`);
    }
    if (expect.actions) {
      if (!expect.actions.length || !expect.actions.some((a) => allowed.includes(a))) {
        throw new Error(`expect_actions_unreachable:${fixture.id}`);
      }
      for (const a of expect.actions) if (!ACTIONS.has(a)) throw new Error(`expect_action_unknown:${fixture.id}`);
    }
    for (const a of expect.notActions ?? []) if (!ACTIONS.has(a)) throw new Error(`expect_action_unknown:${fixture.id}`);
    const questions = buildQuestions(allowed);
    const choices = Object.keys(questions.next_action.criteria);
    if (JSON.stringify(choices) !== JSON.stringify(allowed)) throw new Error(`question_choices_mismatch:${fixture.id}`);
    for (const q of BOOLEAN_QUESTIONS) if (questions[q]?.type !== 'noul') throw new Error('question_shape_invalid');
    // Payload minimisation: only the documented keys reach the provider.
    const keys = Object.keys(fixture.state).sort().join(',');
    if (keys !== 'allowed_actions,deposit_state,has_future_consultation,has_future_tattoo_session,hours_since_last_contact,last_speaker,latest_client_message,previous_studio_message,stage') {
      throw new Error(`state_keys_unexpected:${fixture.id}`);
    }
  }
  if (!splits.holdout || !splits.dev) throw new Error('splits_missing');
  return { fixtures: JEV_FIXTURES.length, splits, multiChoice, repeats: REPEATS, model: JEV_MODEL };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callJev(apiKey, state) {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions: buildQuestions(state.allowed_actions) });
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      return { ok: false, code: 'network_or_timeout' };
    }
    const durationMs = Date.now() - startedAt;
    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!response.ok) return { ok: false, code: `http_${response.status}`, durationMs };
    try {
      return { ok: true, durationMs, data: await response.json() };
    } catch {
      return { ok: false, code: 'response_not_json', durationMs };
    }
  }
  return { ok: false, code: 'retry_exhausted' };
}

/** Typed decision with fail-closed abstention. Pure; exported for the self-test. */
export function decide(answers, allowed) {
  const out = { answered: {}, abstained: [] };
  for (const q of BOOLEAN_QUESTIONS) {
    const p = Number(answers?.[q]?.noul);
    if (!Number.isFinite(p) || p < 0 || p > 1) return { invalid: `answer_${q}` };
    out[`${q}_p`] = round(p);
    if (Math.abs(p - 0.5) >= BOOLEAN_MARGIN) out.answered[q] = p >= 0.5;
    else out.abstained.push(q);
  }
  const choice = answers?.next_action?.choice;
  const confidence = Number(answers?.next_action?.confidence);
  if (typeof choice !== 'string' || !ACTIONS.has(choice)) return { invalid: 'answer_next_action' };
  out.action = choice;
  out.action_allowed = allowed.includes(choice);
  out.action_confidence = Number.isFinite(confidence) ? round(confidence) : null;
  // An action outside the server list is never used, whatever its confidence.
  if (out.action_allowed && Number.isFinite(confidence) && confidence >= ACTION_MIN_CONFIDENCE) {
    out.answered.next_action = choice;
  } else {
    out.abstained.push('next_action');
  }
  return out;
}

/**
 * Fail-closed review routing, chosen from the first v2 run and tested on
 * holdout2: route to the artist unless BOTH commitment_risk and
 * human_review_needed are confidently false. (human_review_needed alone missed
 * most date/price questions; commitment_risk was never confidently false on a
 * commitment case.)
 */
export function routesToReview(decision) {
  return !(decision.commitment_risk_p <= 0.5 - BOOLEAN_MARGIN
    && decision.human_review_needed_p <= 0.5 - BOOLEAN_MARGIN);
}

function score(fixture, decision) {
  const checks = {};
  for (const q of BOOLEAN_QUESTIONS) {
    const expected = fixture.expect[EXPECT_KEY[q]];
    if (expected === null || !(q in decision.answered)) continue;
    checks[q] = decision.answered[q] === expected;
  }
  if ('next_action' in decision.answered) {
    const a = decision.answered.next_action;
    if (fixture.expect.actions) checks.next_action = fixture.expect.actions.includes(a);
    else if (fixture.expect.notActions) checks.next_action = !fixture.expect.notActions.includes(a);
  }
  // Scored on the raw choice too, so abstention cannot hide a wrong answer.
  const raw = decision.action;
  const rawAction = fixture.expect.actions ? fixture.expect.actions.includes(raw)
    : fixture.expect.notActions ? !fixture.expect.notActions.includes(raw) : null;
  return { checks, rawAction };
}

function summarise(rows) {
  const ok = rows.filter((r) => r.ok);
  const per = {};
  for (const q of [...BOOLEAN_QUESTIONS, 'next_action']) {
    const scored = ok.filter((r) => q in r.checks);
    const eligible = ok.filter((r) => (q === 'next_action'
      ? (r.fixture.expect.actions || r.fixture.expect.notActions)
      : r.fixture.expect[EXPECT_KEY[q]] !== null));
    const abstained = eligible.filter((r) => r.abstained.includes(q)).length;
    per[q] = {
      eligible: eligible.length,
      answered: scored.length,
      correct: scored.filter((r) => r.checks[q]).length,
      accuracyAnswered: ratio(scored.filter((r) => r.checks[q]).length, scored.length),
      abstentionRate: ratio(abstained, eligible.length),
      coverageCorrect: ratio(scored.filter((r) => r.checks[q]).length, eligible.length),
    };
  }
  const reviewPos = ok.filter((r) => r.fixture.expect.review === true);
  const reviewNeg = ok.filter((r) => r.fixture.expect.review === false);
  const review = {
    recall: ratio(reviewPos.filter((r) => r.routedToReview).length, reviewPos.length),
    missed: [...new Set(reviewPos.filter((r) => !r.routedToReview).map((r) => r.id))],
    negativesRouted: ratio(reviewNeg.filter((r) => r.routedToReview).length, reviewNeg.length),
  };
  const rawScored = ok.filter((r) => r.rawAction !== null);
  const durations = ok.map((r) => r.durationMs).filter(Number.isFinite);
  return {
    calls: rows.length,
    successfulCalls: ok.length,
    apiErrors: rows.length - ok.length,
    allowedActionRate: ratio(ok.filter((r) => r.actionAllowed).length, ok.length),
    rawActionAccuracy: ratio(rawScored.filter((r) => r.rawAction).length, rawScored.length),
    questions: per,
    review,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
  };
}

function stability(rows) {
  const byId = new Map();
  for (const r of rows.filter((x) => x.ok)) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  let same = 0; let total = 0; let flips = 0; let pairs = 0;
  for (const runs of byId.values()) {
    if (runs.length < 2) continue;
    total += 1;
    const signature = (r) => [r.action, ...BOOLEAN_QUESTIONS.map((q) => r[`${q}_p`] >= 0.5)].join('|');
    if (runs.every((r) => signature(r) === signature(runs[0]))) same += 1;
    for (let i = 1; i < runs.length; i += 1) {
      pairs += 1;
      if (runs[i].action !== runs[0].action) flips += 1;
    }
  }
  return { fixturesRepeated: total, identicalDecisionRate: ratio(same, total), actionFlipRate: ratio(flips, pairs) };
}

function markdown(report) {
  const lines = [
    '## Jev CRM decision eval v2',
    '',
    '> Synthetic fixtures only. No CRM, Supabase, Cloudflare or client data is read.',
    '',
    `Model requested ${report.modelRequested}; served ${report.modelServed ?? 'unknown'} by ${report.provider ?? 'unknown'}.`,
    `Repeats ${report.repeats}; thresholds: boolean |p-0.5| >= ${BOOLEAN_MARGIN}, action confidence >= ${ACTION_MIN_CONFIDENCE}.`,
    `Calls ${report.totals.calls}, API errors ${report.totals.apiErrors}, input tokens ${report.totals.inputTokens}, cost $${report.totals.costUsd}.`,
    `Stability: identical decision across repeats ${report.stability.identicalDecisionRate}, action flip rate ${report.stability.actionFlipRate}.`,
    '',
    '| Split | Calls | Allowed-action | Raw action acc. | Q | Answered acc. | Abstain | Correct / eligible | p50 | p95 |',
    '|---|---:|---:|---:|---|---:|---:|---:|---:|---:|',
  ];
  for (const [split, s] of Object.entries(report.splits)) {
    for (const [q, m] of Object.entries(s.questions)) {
      lines.push(`| ${split} | ${s.calls} | ${s.allowedActionRate} | ${s.rawActionAccuracy} | ${q} | ${m.accuracyAnswered} | ${m.abstentionRate} | ${m.coverageCorrect} | ${s.p50Ms} | ${s.p95Ms} |`);
    }
  }
  lines.push('', '### Fail-closed review routing', '', '| Split | Review recall | Missed | Safe cases routed to review |', '|---|---:|---|---:|');
  for (const [split, s] of Object.entries(report.splits)) {
    lines.push(`| ${split} | ${s.review.recall} | ${s.review.missed.join(', ') || '-'} | ${s.review.negativesRouted} |`);
  }
  lines.push('', '### Misses (answered and wrong)', '', '| Fixture | Split | Question | Got | p / conf |', '|---|---|---|---|---:|');
  for (const miss of report.misses) lines.push(`| ${miss.id} | ${miss.split} | ${miss.question} | ${miss.got} | ${miss.p} |`);
  return lines.join('\n');
}

const self = selfTest();
if (process.argv.includes('--self-test')) {
  // Pure decision logic checks, no network.
  const allowed = ['artist_review', 'no_action'];
  const confident = decide({
    reply_needed: { noul: 0.95 }, commitment_risk: { noul: 0.05 }, human_review_needed: { noul: 0.9 },
    next_action: { choice: 'artist_review', confidence: 0.9 },
  }, allowed);
  if (confident.answered.next_action !== 'artist_review' || confident.abstained.length) throw new Error('decide_confident');
  const unsure = decide({
    reply_needed: { noul: 0.55 }, commitment_risk: { noul: 0.6 }, human_review_needed: { noul: 0.1 },
    next_action: { choice: 'artist_review', confidence: 0.4 },
  }, allowed);
  if (!unsure.abstained.includes('reply_needed') || !unsure.abstained.includes('next_action')) throw new Error('decide_abstain');
  const outside = decide({
    reply_needed: { noul: 0.9 }, commitment_risk: { noul: 0.9 }, human_review_needed: { noul: 0.9 },
    next_action: { choice: 'confirm_booking', confidence: 0.99 },
  }, allowed);
  if ('next_action' in outside.answered || outside.action_allowed) throw new Error('decide_outside_allowed');
  if (!decide({ next_action: { choice: 'x' } }, allowed).invalid) throw new Error('decide_invalid');
  if (!routesToReview({ commitment_risk_p: 0.9, human_review_needed_p: 0.1 })) throw new Error('review_commitment');
  if (!routesToReview({ commitment_risk_p: 0.1, human_review_needed_p: 0.5 })) throw new Error('review_unsure');
  if (routesToReview({ commitment_risk_p: 0.1, human_review_needed_p: 0.15 })) throw new Error('review_safe');
  console.log(JSON.stringify({ ok: true, ...self }));
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const rows = [];
let totalCost = 0;
let totalTokens = 0;
let modelServed = null;
let provider = null;
for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  for (const fixture of JEV_FIXTURES) {
    if (totalCost >= MAX_TOTAL_COST_USD) throw new Error('jev_eval_cost_guard_reached');
    if (rows.length >= MAX_CALLS) throw new Error('jev_eval_call_guard_reached');
    const call = await callJev(apiKey, fixture.state);
    if (!call.ok) {
      rows.push({ id: fixture.id, split: fixture.split, fixture, ok: false, error: call.code, durationMs: call.durationMs ?? null });
      continue;
    }
    const decision = decide(call.data?.answers, fixture.state.allowed_actions);
    if (decision.invalid) {
      rows.push({ id: fixture.id, split: fixture.split, fixture, ok: false, error: decision.invalid, durationMs: call.durationMs });
      continue;
    }
    const usage = call.data?.usage ?? {};
    const cost = Number(usage.cost ?? 0);
    const tokens = Number(usage.input_tokens ?? 0);
    totalCost += Number.isFinite(cost) ? cost : 0;
    totalTokens += Number.isFinite(tokens) ? tokens : 0;
    modelServed ??= typeof call.data?.model === 'string' ? call.data.model : null;
    provider ??= typeof call.data?.provider === 'string' ? call.data.provider : null;
    const { checks, rawAction } = score(fixture, decision);
    rows.push({
      id: fixture.id, split: fixture.split, fixture, ok: true, repeat,
      action: decision.action, actionAllowed: decision.action_allowed, action_confidence: decision.action_confidence,
      reply_needed_p: decision.reply_needed_p, commitment_risk_p: decision.commitment_risk_p,
      human_review_needed_p: decision.human_review_needed_p,
      answered: decision.answered, abstained: decision.abstained, checks, rawAction,
      routedToReview: routesToReview(decision),
      durationMs: call.durationMs,
    });
  }
}

const splits = {};
for (const split of ['dev', 'holdout', 'holdout2', 'baseline']) splits[split] = summarise(rows.filter((r) => r.split === split));
const misses = [];
for (const r of rows.filter((x) => x.ok)) {
  for (const [q, pass] of Object.entries(r.checks)) {
    if (pass) continue;
    misses.push({
      id: r.id, split: r.split, question: q,
      got: q === 'next_action' ? r.answered.next_action : String(r.answered[q]),
      p: q === 'next_action' ? r.action_confidence : r[`${q}_p`],
    });
  }
}
const report = {
  generatedAt: new Date().toISOString(),
  modelRequested: JEV_MODEL,
  modelServed,
  provider,
  repeats: REPEATS,
  totals: { calls: rows.length, apiErrors: rows.filter((r) => !r.ok).length, inputTokens: totalTokens, costUsd: round(totalCost, 8) },
  stability: stability(rows),
  splits,
  misses,
  // Content-free rows: ids, typed decisions and probabilities only, never fixture text.
  rows: rows.map(({ fixture, ...rest }) => rest),
};
writeFileSync('jev-eval-results.json', JSON.stringify(report, null, 2));
const md = markdown(report);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
if (report.totals.apiErrors > 0) process.exit(1);
