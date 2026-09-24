#!/usr/bin/env node
// Guarded live evaluation against the production TattooAI probe endpoint.
//
// Sends only fixture IDs and closed request-shape choices; the Worker owns the
// synthetic fixture text. Each variant forces one provider, so a result
// measures that model alone rather than the fallback chain. Timeouts in a
// variant are raised so latency is measured rather than cut off at 30 s.
//
// Output: per-variant validity, check pass rate, first-attempt outcome codes,
// p50/p95 latency and token means, as JSON and as a Markdown table.
import { readFileSync, appendFileSync } from 'node:fs';
import { EVAL_FIXTURE_IDS, CLIENT_STATE_FIXTURES, ENQUIRY_FIXTURES } from '../../workers/lib/ai/eval-fixtures.js';
import { checkAnswer } from './assertions.mjs';

const endpoint = process.env.ENDPOINT;
const token = process.env.PROBE_TOKEN;
if (!endpoint || !token) throw new Error('ENDPOINT and PROBE_TOKEN are required');
const plan = JSON.parse(readFileSync(new URL('./live-variants.json', import.meta.url), 'utf8'));
const only = (process.env.EVAL_VARIANTS || '').split(',').map((v) => v.trim()).filter(Boolean);

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const mean = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

async function call(task, fixture, variant) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'eval', task, fixture, variant }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) return { httpStatus: response.status };
  return response.json();
}

let calls = 0;
const report = [];
for (const entry of plan.variants) {
  if (only.length && !only.includes(entry.id)) continue;
  const fixtures = EVAL_FIXTURE_IDS[entry.task];
  const expectations = entry.task === 'enquiry_intake' ? ENQUIRY_FIXTURES : CLIENT_STATE_FIXTURES;
  const rows = [];
  for (let repeat = 0; repeat < plan.repeats; repeat += 1) {
    for (const fixture of fixtures) {
      if (calls >= plan.maxCalls) break;
      calls += 1;
      let result;
      try { result = await call(entry.task, fixture, entry.variant); } catch { result = { httpStatus: 0 }; }
      const first = Array.isArray(result.attempts) ? result.attempts[0] : null;
      const check = result.ok && result.answer ? checkAnswer(entry.task, result.answer, expectations[fixture].expect) : null;
      rows.push({
        fixture,
        ok: Boolean(result.ok),
        code: first?.errorCode ?? (result.ok ? 'ok' : result.errorCode ?? `http_${result.httpStatus}`),
        validationFailure: first?.validationFailure ?? null,
        finishReason: first?.finishReason ?? null,
        durationMs: first?.durationMs ?? null,
        completionTokens: first?.completionTokens ?? null,
        reasoningTokens: first?.reasoningTokens ?? null,
        checkFailures: check ? check.failures : null,
      });
    }
  }
  const durations = rows.map((r) => r.durationMs).filter(Number.isFinite);
  const valid = rows.filter((r) => r.ok);
  const passed = valid.filter((r) => r.checkFailures && r.checkFailures.length === 0);
  const codes = {};
  for (const r of rows) {
    const key = r.validationFailure ? `${r.code}:${r.validationFailure}` : r.code;
    codes[key] = (codes[key] ?? 0) + 1;
  }
  const checkFailures = {};
  for (const r of valid) for (const f of r.checkFailures ?? []) checkFailures[`${r.fixture}/${f}`] = (checkFailures[`${r.fixture}/${f}`] ?? 0) + 1;
  report.push({
    id: entry.id,
    task: entry.task,
    runs: rows.length,
    validRate: rows.length ? +(valid.length / rows.length).toFixed(2) : 0,
    checkPassRate: valid.length ? +(passed.length / valid.length).toFixed(2) : 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    meanCompletionTokens: mean(rows.map((r) => r.completionTokens).filter(Number.isFinite)),
    meanReasoningTokens: mean(rows.map((r) => r.reasoningTokens).filter(Number.isFinite)),
    codes,
    checkFailures,
  });
}

console.log(JSON.stringify({ calls, report }, null, 2));
const table = ['| variant | runs | valid | checks pass | p50 ms | p95 ms | completion tok | reasoning tok | outcome codes |',
  '|---|---|---|---|---|---|---|---|---|',
  ...report.map((r) => `| ${r.id} | ${r.runs} | ${r.validRate} | ${r.checkPassRate} | ${r.p50Ms} | ${r.p95Ms} | ${r.meanCompletionTokens} | ${r.meanReasoningTokens} | ${Object.entries(r.codes).map(([k, v]) => `${k}=${v}`).join(', ')} |`)];
console.log(table.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CRM AI live eval\n\n${table.join('\n')}\n`);
