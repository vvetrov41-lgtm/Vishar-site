#!/usr/bin/env node
// External watchdog for the Vishar CRM production scheduler.
//
// The scheduler Worker records a heartbeat after every successful lifecycle
// tick (*/5). Its own failure alerts run inside that same scheduler, so they
// go silent exactly when the scheduler dies. This watchdog runs on GitHub
// Actions, holds no production credential, and reads only the anonymous
// `get_scheduler_heartbeat_status()` projection (timestamp, age, stale flag).
//
// Alerting uses one GitHub issue as the dedupe record:
//   * unhealthy and no open issue  -> open the issue (mentions the owner) and
//                                     fail the run, so both issue and failed-run
//                                     notifications fire exactly once;
//   * unhealthy and issue open     -> stay quiet (no storm);
//   * healthy and issue open       -> comment the recovery and close it;
//   * healthy and no issue         -> nothing.
// Nothing here writes to the CRM, so a watchdog failure cannot affect it.
//
// Usage: node scripts/crm-scheduler-watchdog.mjs [--self-test]

import assert from 'node:assert/strict';

export const LABEL = 'crm-scheduler-watchdog';
const FETCH_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;

export function decide({ health, openIssue }) {
  const unhealthy = !health.readable || health.stale === true;
  if (unhealthy && !openIssue) return { action: 'open', fail: true };
  if (unhealthy && openIssue) return { action: 'none', fail: false };
  if (!unhealthy && openIssue) return { action: 'close', fail: false };
  return { action: 'none', fail: false };
}

export function describe(health) {
  if (!health.readable) return `heartbeat unreadable (${health.reason})`;
  if (health.lastSucceededAt === null) return 'no scheduler heartbeat has ever been recorded';
  const minutes = Math.floor(health.ageSeconds / 60);
  return `last successful scheduler tick ${health.lastSucceededAt} (${minutes} min ago)`;
}

export function parseStatus(body) {
  const row = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== 'object' || typeof row.stale !== 'boolean') {
    return { readable: false, reason: 'unexpected_response_shape' };
  }
  const lastSucceededAt = typeof row.last_succeeded_at === 'string' ? row.last_succeeded_at : null;
  const ageSeconds = Number.isInteger(row.age_seconds) ? row.age_seconds : null;
  return { readable: true, stale: row.stale, lastSucceededAt, ageSeconds };
}

async function readHealth({ supabaseUrl, publishableKey, fetchImpl = fetch, sleep }) {
  let reason = 'not_attempted';
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/get_scheduler_heartbeat_status`, {
        method: 'POST',
        headers: { apikey: publishableKey, 'content-type': 'application/json' },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return parseStatus(await response.json());
      reason = `http_${response.status}`;
    } catch (error) {
      reason = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    }
    if (attempt < READ_ATTEMPTS) await sleep(attempt * 10_000);
  }
  return { readable: false, reason };
}

function github(token, repository, fetchImpl = fetch) {
  const root = `https://api.github.com/repos/${repository}`;
  return async (method, path, body) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok && !(method === 'POST' && path === '/labels' && response.status === 422)) {
      throw new Error(`GitHub ${method} ${path} failed with ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

async function main() {
  const env = process.env;
  const health = await readHealth({
    supabaseUrl: env.CRM_SUPABASE_URL,
    publishableKey: env.CRM_SUPABASE_PUBLISHABLE_KEY,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const api = github(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const open = await api('GET', `/issues?labels=${LABEL}&state=open&per_page=10`);
  const openIssue = (open || []).find((issue) => !issue.pull_request) || null;
  const decision = decide({ health, openIssue });
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const summary = describe(health);
  console.log(`CRM scheduler: ${health.readable && !health.stale ? 'healthy' : 'UNHEALTHY'}; ${summary}; action=${decision.action}`);

  if (decision.action === 'open') {
    await api('POST', '/labels', { name: LABEL, color: 'b60205', description: 'External CRM scheduler watchdog alert' });
    const issue = await api('POST', '/issues', {
      title: 'CRM production scheduler heartbeat is stale',
      labels: [LABEL],
      body: [
        `@${env.GITHUB_REPOSITORY_OWNER} the external watchdog could not confirm a recent production scheduler tick.`,
        '',
        `- Status: ${summary}`,
        '- Threshold: 15 minutes (three missed */5 ticks)',
        `- Detected by: ${runUrl}`,
        '',
        'While this is open, Telegram delivery, lifecycle jobs, outbox recovery and the in-scheduler failure alerts may not be running.',
        'This issue closes itself with a recovery comment once a fresh heartbeat is observed.',
      ].join('\n'),
    });
    console.log(`Opened alert issue #${issue.number}`);
  } else if (decision.action === 'close') {
    await api('POST', `/issues/${openIssue.number}/comments`, {
      body: `Recovered: ${summary}. Observed by ${runUrl}.`,
    });
    await api('PATCH', `/issues/${openIssue.number}`, { state: 'closed', state_reason: 'completed' });
    console.log(`Closed alert issue #${openIssue.number} after recovery`);
  }
  if (decision.fail) process.exit(1);
}

function selfTest() {
  const fresh = { readable: true, stale: false, lastSucceededAt: '2026-09-23T00:00:00Z', ageSeconds: 120 };
  const stale = { readable: true, stale: true, lastSucceededAt: '2026-09-23T00:00:00Z', ageSeconds: 1200 };
  const unreadable = { readable: false, reason: 'timeout' };
  const issue = { number: 1 };
  assert.deepEqual(decide({ health: stale, openIssue: null }), { action: 'open', fail: true });
  assert.deepEqual(decide({ health: unreadable, openIssue: null }), { action: 'open', fail: true });
  assert.deepEqual(decide({ health: stale, openIssue: issue }), { action: 'none', fail: false });
  assert.deepEqual(decide({ health: fresh, openIssue: issue }), { action: 'close', fail: false });
  assert.deepEqual(decide({ health: fresh, openIssue: null }), { action: 'none', fail: false });

  assert.deepEqual(parseStatus([{ last_succeeded_at: '2026-09-23T00:00:00Z', age_seconds: 60, stale: false }]),
    { readable: true, stale: false, lastSucceededAt: '2026-09-23T00:00:00Z', ageSeconds: 60 });
  assert.deepEqual(parseStatus([{ last_succeeded_at: null, age_seconds: null, stale: true }]),
    { readable: true, stale: true, lastSucceededAt: null, ageSeconds: null });
  assert.equal(parseStatus({ message: 'permission denied' }).readable, false);
  assert.equal(parseStatus([]).readable, false);
  assert.match(describe(stale), /20 min ago/);
  assert.match(describe(unreadable), /unreadable \(timeout\)/);
  console.log('CRM scheduler watchdog self-test passed.');
}

if (process.argv[2] === '--self-test') selfTest();
else await main();
