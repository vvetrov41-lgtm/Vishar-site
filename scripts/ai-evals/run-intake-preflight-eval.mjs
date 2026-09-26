#!/usr/bin/env node
// Live synthetic evaluation of the intake semantic preflight through a
// decision provider (TypeSafe Jev via the OpenRouter Decisions API).
//
// Safety: synthetic fixtures only; the key comes only from OPENROUTER_API_KEY
// and is never logged; results carry fixture ids, statuses and categories,
// never fixture text; bounded calls and cost. Quality misses are evidence,
// not a CI failure; transport failures above a small share fail the run.
//
//   node scripts/ai-evals/run-intake-preflight-eval.mjs --self-test
//   OPENROUTER_API_KEY=... node scripts/ai-evals/run-intake-preflight-eval.mjs

import { appendFileSync, writeFileSync } from 'node:fs';
import { PREFLIGHT_FIXTURES, PREFLIGHT_MODEL } from './intake-preflight-fixtures.mjs';
import {
  CLARIFY_CATEGORIES, PREFLIGHT_VERSION, decidePreflight,
} from '../../workers/lib/intake-preflight/contract.js';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const REPEATS = Math.min(Math.max(Number.parseInt(process.env.PREFLIGHT_EVAL_REPEATS ?? '2', 10) || 2, 1), 3);
const MAX_CALLS = 300;
const MAX_TOTAL_COST_USD = 0.05;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000];
const STATE_KEYS = 'cover_up,idea,placement,project_type,reference_image_count,size';

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const ratio = (n, d) => (d ? round(n / d) : null);

function selfTest() {
  if (!PREFLIGHT_FIXTURES.length || PREFLIGHT_FIXTURES.length * REPEATS > MAX_CALLS) throw new Error('fixture_budget_invalid');
  const ids = new Set();
  const splits = { dev: 0, holdout: 0 };
  let needClarify = 0; let needNone = 0; let review = 0;
  for (const f of PREFLIGHT_FIXTURES) {
    if (!f.id || ids.has(f.id)) throw new Error(`fixture_id_invalid:${f.id}`);
    ids.add(f.id);
    if (!(f.split in splits)) throw new Error(`fixture_split_invalid:${f.id}`);
    splits[f.split] += 1;
    if (Object.keys(f.state).sort().join(',') !== STATE_KEYS) throw new Error(`state_keys_unexpected:${f.id}`);
    for (const c of [...f.expect.clarify, ...f.expect.optional]) {
      if (!CLARIFY_CATEGORIES.includes(c)) throw new Error(`expect_category_unknown:${f.id}`);
    }
    if (f.expect.clarify.includes('coverup_goal') && !f.questions.coverup_goal_clear) throw new Error(`coverup_question_missing:${f.id}`);
    for (const q of Object.values(f.questions)) if (q.type !== 'noul') throw new Error('question_shape_invalid');
    if (f.expect.review === true) review += 1;
    else if (f.expect.clarify.length) needClarify += 1;
    else if (!f.expect.optional.length) needNone += 1;
  }
  // The contract must never turn a malformed or empty answer into a hint.
  for (const bad of [null, {}, { placement_clear: { noul: 'x' } }, { size_clear: { noul: 2 } }]) {
    const d = decidePreflight(bad, { cover_up: 'No' });
    if (d.status === 'clarify') throw new Error('fail_open_violated');
  }
  if (!splits.dev || !splits.holdout || !needClarify || !needNone || !review) throw new Error('coverage_missing');
  return { fixtures: PREFLIGHT_FIXTURES.length, splits, needClarify, needNone, review, repeats: REPEATS, model: PREFLIGHT_MODEL, contract: PREFLIGHT_VERSION };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callProvider(apiKey, fixture) {
  const body = JSON.stringify({ model: PREFLIGHT_MODEL, state: fixture.state, questions: fixture.questions });
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'manual',
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
    try { return { ok: true, durationMs, data: await response.json() }; } catch { return { ok: false, code: 'response_not_json', durationMs }; }
  }
  return { ok: false, code: 'retry_exhausted' };
}

/** Per-run scoring against the fixture labels. */
export function scoreRun(fixture, decision) {
  const { clarify, optional, review } = fixture.expect;
  const flagged = decision.status === 'clarify' ? decision.categories : [];
  const tolerated = new Set([...clarify, ...optional]);
  const falseCategories = review === true ? flagged : flagged.filter((c) => !tolerated.has(c));
  const missed = review === true ? [] : clarify.filter((c) => !flagged.includes(c));
  return {
    falseClarification: falseCategories.length > 0,
    falseCategories,
    missed,
    requiredCount: review === true ? 0 : clarify.length,
    reviewHit: review === true ? decision.status === 'artist_review' : null,
    reviewNoClarify: review === true ? decision.status !== 'clarify' : null,
  };
}

function summarise(rows) {
  const ok = rows.filter((r) => r.ok);
  const required = ok.reduce((n, r) => n + r.score.requiredCount, 0);
  const missed = ok.reduce((n, r) => n + r.score.missed.length, 0);
  const reviewRows = ok.filter((r) => r.score.reviewHit !== null);
  const noneRows = ok.filter((r) => r.fixture.expect.review !== true && !r.fixture.expect.clarify.length && !r.fixture.expect.optional.length);
  const clarifyRows = ok.filter((r) => r.fixture.expect.review !== true && r.fixture.expect.clarify.length);
  const falseByCategory = {};
  for (const r of ok) for (const c of r.score.falseCategories) falseByCategory[c] = (falseByCategory[c] ?? 0) + 1;
  const durations = ok.map((r) => r.durationMs).filter(Number.isFinite);
  const statuses = {};
  for (const r of ok) statuses[r.decision.status] = (statuses[r.decision.status] ?? 0) + 1;
  return {
    calls: rows.length,
    apiErrors: rows.length - ok.length,
    statuses,
    falseClarificationRate: ratio(ok.filter((r) => r.score.falseClarification).length, ok.length),
    falseClarificationOnCleanRate: ratio(noneRows.filter((r) => r.score.falseClarification).length, noneRows.length),
    falseByCategory,
    missedClarificationRate: ratio(missed, required),
    clarifyCaseRecall: ratio(clarifyRows.filter((r) => r.decision.status === 'clarify').length, clarifyRows.length),
    artistReviewRecall: ratio(reviewRows.filter((r) => r.score.reviewHit).length, reviewRows.length),
    reviewWithoutClarification: ratio(reviewRows.filter((r) => r.score.reviewNoClarify).length, reviewRows.length),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length ? Math.max(...durations) : null,
  };
}

function stability(rows) {
  const byId = new Map();
  for (const r of rows.filter((x) => x.ok)) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(`${r.decision.status}:${[...r.decision.categories].sort().join('+')}`);
  }
  let same = 0; let total = 0;
  for (const sigs of byId.values()) {
    if (sigs.length < 2) continue;
    total += 1;
    if (sigs.every((s) => s === sigs[0])) same += 1;
  }
  return { fixtures: total, identicalDecisionRate: ratio(same, total) };
}

async function live() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing');
  const meta = selfTest();
  const rows = [];
  let cost = 0; let calls = 0;
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    for (const fixture of PREFLIGHT_FIXTURES) {
      if (calls >= MAX_CALLS || cost >= MAX_TOTAL_COST_USD) break;
      calls += 1;
      const result = await callProvider(apiKey, fixture);
      if (!result.ok) { rows.push({ id: fixture.id, split: fixture.split, ok: false, code: result.code }); continue; }
      const c = Number(result.data?.usage?.cost);
      if (Number.isFinite(c) && c >= 0) cost += c;
      const decision = decidePreflight(result.data?.answers, fixture.state);
      if (decision.status === 'skipped') { rows.push({ id: fixture.id, split: fixture.split, ok: false, code: decision.reason ?? 'skipped' }); continue; }
      rows.push({ id: fixture.id, split: fixture.split, fixture, ok: true, durationMs: result.durationMs, decision, score: scoreRun(fixture, decision) });
    }
  }
  const bySplit = {};
  for (const split of ['dev', 'holdout']) bySplit[split] = summarise(rows.filter((r) => r.split === split));
  const report = {
    ...meta,
    totalCostUsd: round(cost, 6),
    costPerDecisionUsd: ratio(cost, rows.filter((r) => r.ok).length),
    overall: summarise(rows),
    bySplit,
    stability: stability(rows),
    // Content-free per-fixture outcomes for error analysis.
    outcomes: rows.map((r) => (r.ok
      ? { id: r.id, split: r.split, status: r.decision.status, categories: r.decision.categories, false: r.score.falseCategories, missed: r.score.missed }
      : { id: r.id, split: r.split, error: r.code })),
  };
  writeFileSync('intake-preflight-eval-results.json', `${JSON.stringify(report, null, 2)}\n`);
  const summary = [
    `## Intake preflight eval (${PREFLIGHT_MODEL}, ${PREFLIGHT_VERSION})`,
    '',
    '| split | calls | false clarification | false on clean | missed clarification | clarify recall | artist_review recall | review w/o hint | p50 ms | p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries({ ...bySplit, overall: report.overall }).map(([k, s]) => `| ${k} | ${s.calls} | ${s.falseClarificationRate} | ${s.falseClarificationOnCleanRate} | ${s.missedClarificationRate} | ${s.clarifyCaseRecall} | ${s.artistReviewRecall} | ${s.reviewWithoutClarification} | ${s.p50Ms} | ${s.p95Ms} |`),
    '',
    `Stability: ${report.stability.identicalDecisionRate} over ${report.stability.fixtures} fixtures. Cost: $${report.totalCostUsd}.`,
  ].join('\n');
  console.log(JSON.stringify({ overall: report.overall, bySplit, stability: report.stability, totalCostUsd: report.totalCostUsd }, null, 2));
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (report.overall.apiErrors > Math.ceil(rows.length * 0.1)) throw new Error('too_many_api_errors');
}

if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ ok: true, ...selfTest() }));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  await live();
}
