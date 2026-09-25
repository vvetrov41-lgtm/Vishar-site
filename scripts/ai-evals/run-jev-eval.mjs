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

import { appendFileSync, writeFileSync } from 'node:fs';
import { JEV_FIXTURES, JEV_MODEL, JEV_QUESTIONS } from './jev-decision-fixtures.mjs';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MAX_FIXTURES = 50;
const MAX_TOTAL_COST_USD = 0.05;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000];

const ACTIONS = new Set(['reply_to_client', 'follow_up', 'await_client', 'no_action', 'human_review']);

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const round = (value, digits = 4) => (
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null
);

function selfTest() {
  if (!Array.isArray(JEV_FIXTURES) || !JEV_FIXTURES.length || JEV_FIXTURES.length > MAX_FIXTURES) {
    throw new Error('fixture_count_invalid');
  }
  const ids = new Set();
  for (const fixture of JEV_FIXTURES) {
    if (!fixture || typeof fixture !== 'object' || typeof fixture.id !== 'string' || !fixture.id) {
      throw new Error('fixture_id_invalid');
    }
    if (ids.has(fixture.id)) throw new Error('fixture_id_duplicate');
    ids.add(fixture.id);
    const allowed = fixture.state?.allowed_actions;
    if (!Array.isArray(allowed) || !allowed.length || !allowed.every((action) => ACTIONS.has(action))) {
      throw new Error(`fixture_allowed_actions_invalid:${fixture.id}`);
    }
    if (typeof fixture.state?.latest_message !== 'string') {
      throw new Error(`fixture_message_invalid:${fixture.id}`);
    }
    const expect = fixture.expect;
    if (typeof expect?.reply_needed !== 'boolean' || typeof expect?.commitment_risk !== 'boolean') {
      throw new Error(`fixture_boolean_expectation_invalid:${fixture.id}`);
    }
    if (!ACTIONS.has(expect?.next_action) || !allowed.includes(expect.next_action)) {
      throw new Error(`fixture_action_expectation_invalid:${fixture.id}`);
    }
  }

  if (JEV_QUESTIONS.reply_needed?.type !== 'noul'
    || JEV_QUESTIONS.commitment_risk?.type !== 'noul'
    || JEV_QUESTIONS.next_action?.type !== 'choice') {
    throw new Error('question_shape_invalid');
  }
  const choices = Object.keys(JEV_QUESTIONS.next_action.criteria ?? {});
  if (choices.length !== ACTIONS.size || !choices.every((choice) => ACTIONS.has(choice))) {
    throw new Error('question_actions_invalid');
  }
  return { fixtures: JEV_FIXTURES.length, model: JEV_MODEL };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callJev(apiKey, state) {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS });
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { ok: false, code: 'network_or_timeout' };
    }

    const durationMs = Date.now() - startedAt;
    if ((response.status === 429 || response.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!response.ok) return { ok: false, code: `http_${response.status}`, durationMs };

    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, code: 'response_not_json', durationMs };
    }
    return { ok: true, durationMs, data };
  }
  return { ok: false, code: 'retry_exhausted' };
}

function parseResult(fixture, call) {
  if (!call.ok) return { id: fixture.id, ok: false, error: call.code, durationMs: call.durationMs ?? null };

  const answers = call.data?.answers;
  const replyProbability = Number(answers?.reply_needed?.noul);
  const commitmentProbability = Number(answers?.commitment_risk?.noul);
  const nextAction = answers?.next_action?.choice;
  const actionConfidence = Number(answers?.next_action?.confidence);
  if (!Number.isFinite(replyProbability) || replyProbability < 0 || replyProbability > 1
    || !Number.isFinite(commitmentProbability) || commitmentProbability < 0 || commitmentProbability > 1
    || typeof nextAction !== 'string' || !ACTIONS.has(nextAction)) {
    return { id: fixture.id, ok: false, error: 'answer_shape_invalid', durationMs: call.durationMs };
  }

  const predicted = {
    reply_needed: replyProbability >= 0.5,
    next_action: nextAction,
    commitment_risk: commitmentProbability >= 0.5,
  };
  const checks = {
    reply_needed: predicted.reply_needed === fixture.expect.reply_needed,
    next_action: predicted.next_action === fixture.expect.next_action,
    commitment_risk: predicted.commitment_risk === fixture.expect.commitment_risk,
    allowed_action: fixture.state.allowed_actions.includes(predicted.next_action),
  };
  const usage = call.data?.usage ?? {};
  const cost = Number(usage.cost ?? 0);
  const inputTokens = Number(usage.input_tokens ?? 0);

  return {
    id: fixture.id,
    ok: true,
    predicted,
    checks,
    replyProbability: round(replyProbability),
    replyConfidence: round(Math.abs(2 * replyProbability - 1)),
    commitmentProbability: round(commitmentProbability),
    commitmentConfidence: round(Math.abs(2 * commitmentProbability - 1)),
    actionConfidence: Number.isFinite(actionConfidence) ? round(actionConfidence) : null,
    durationMs: call.durationMs,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    costUsd: Number.isFinite(cost) ? cost : 0,
    model: typeof call.data?.model === 'string' ? call.data.model : null,
    provider: typeof call.data?.provider === 'string' ? call.data.provider : null,
  };
}

function accuracy(rows, key) {
  const valid = rows.filter((row) => row.ok);
  if (!valid.length) return null;
  return round(valid.filter((row) => row.checks[key]).length / valid.length);
}

function makeSummary(rows, totalCost, totalTokens) {
  const valid = rows.filter((row) => row.ok);
  const durations = valid.map((row) => row.durationMs).filter(Number.isFinite);
  return {
    modelRequested: JEV_MODEL,
    modelServed: valid.find((row) => row.model)?.model ?? null,
    provider: valid.find((row) => row.provider)?.provider ?? null,
    fixtures: rows.length,
    successfulCalls: valid.length,
    apiErrors: rows.length - valid.length,
    fixturePassRate: valid.length
      ? round(valid.filter((row) => Object.values(row.checks).every(Boolean)).length / valid.length)
      : null,
    replyAccuracy: accuracy(rows, 'reply_needed'),
    nextActionAccuracy: accuracy(rows, 'next_action'),
    commitmentRiskAccuracy: accuracy(rows, 'commitment_risk'),
    allowedActionRate: accuracy(rows, 'allowed_action'),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    inputTokens: totalTokens,
    costUsd: round(totalCost, 8),
  };
}

function markdown(summary, rows) {
  const lines = [
    '## Jev CRM decision eval',
    '',
    '> Synthetic fixtures only. This run does not read CRM, Supabase, Cloudflare, or client messages.',
    '',
    '| Metric | Result |',
    '|---|---:|',
    `| Model requested | ${summary.modelRequested} |`,
    `| Model served | ${summary.modelServed ?? 'unknown'} |`,
    `| Provider | ${summary.provider ?? 'unknown'} |`,
    `| Fixtures | ${summary.fixtures} |`,
    `| Successful calls | ${summary.successfulCalls} |`,
    `| API errors | ${summary.apiErrors} |`,
    `| Full fixture pass rate | ${summary.fixturePassRate ?? 'n/a'} |`,
    `| reply_needed accuracy | ${summary.replyAccuracy ?? 'n/a'} |`,
    `| next_action accuracy | ${summary.nextActionAccuracy ?? 'n/a'} |`,
    `| commitment_risk accuracy | ${summary.commitmentRiskAccuracy ?? 'n/a'} |`,
    `| Allowed-action compliance | ${summary.allowedActionRate ?? 'n/a'} |`,
    `| p50 latency | ${summary.p50Ms ?? 'n/a'} ms |`,
    `| p95 latency | ${summary.p95Ms ?? 'n/a'} ms |`,
    `| Input tokens | ${summary.inputTokens} |`,
    `| Reported cost | $${summary.costUsd} |`,
    '',
    '| Fixture | Reply p | Action | Action conf. | Commitment p | Pass |',
    '|---|---:|---|---:|---:|---|',
    ...rows.map((row) => {
      if (!row.ok) return `| ${row.id} | - | ${row.error} | - | - | API error |`;
      const pass = Object.values(row.checks).every(Boolean) ? 'yes' : 'no';
      return `| ${row.id} | ${row.replyProbability} | ${row.predicted.next_action} | ${row.actionConfidence ?? '-'} | ${row.commitmentProbability} | ${pass} |`;
    }),
  ];
  return lines.join('\n');
}

const self = selfTest();
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ ok: true, ...self }));
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const rows = [];
let totalCost = 0;
let totalTokens = 0;
for (const fixture of JEV_FIXTURES) {
  if (totalCost >= MAX_TOTAL_COST_USD) throw new Error('jev_eval_cost_guard_reached');
  const result = parseResult(fixture, await callJev(apiKey, fixture.state));
  rows.push(result);
  if (result.ok) {
    totalCost += result.costUsd;
    totalTokens += result.inputTokens;
  }
}

const summary = makeSummary(rows, totalCost, totalTokens);
const output = {
  generatedAt: new Date().toISOString(),
  summary,
  // Deliberately exclude fixture input/state from the artifact.
  rows,
};
writeFileSync('jev-eval-results.json', JSON.stringify(output, null, 2));
const md = markdown(summary, rows);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);

if (summary.apiErrors > 0) process.exit(1);
