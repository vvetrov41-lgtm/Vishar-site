import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROJECT, EXPECTED_MIGRATION, EVIDENCE_SOURCE, HEALTH_SQL, projectState, healthState, healthy, quiet,
  evidenceState, restartOnce } from './restart-backend-auth-project.mjs';

const now = Date.parse('2026-08-28T17:01:15Z');
const baseline = { migration: EXPECTED_MIGRATION, artists: 2, rules: 12, integrations: 13, integration_errors: 0,
  failed: 0, pending: 13, overdue: 0, running: 0, due_soon: 0, leased: 0, active_transactions: 0,
  heartbeat: '2026-08-28T17:00:53Z' };
assert.equal(EXPECTED_MIGRATION, '0115');
const health = healthState([{ ...baseline, arbitrary: 'private-value' }]);
assert.equal(JSON.stringify(health).includes('private-value'), false);
assert.equal(healthy(health, now), true);
assert.equal(quiet(health, now), true);
for (const field of ['failed', 'overdue', 'running', 'due_soon', 'leased', 'active_transactions', 'integration_errors']) {
  assert.equal(quiet({ ...health, [field]: 1 }, now), false, field);
}
assert.equal(quiet(health, Date.parse('2026-08-28T17:00:59Z')), false);
assert.equal(quiet(health, Date.parse('2026-08-28T17:02:00Z')), false);
assert.equal(healthy({ ...health, heartbeat: '2026-08-28T16:30:00Z' }, now), false);
assert.equal(healthy({ ...health, heartbeat: '2026-08-28T18:00:00Z' }, now), false);
for (const value of [[], [{ ...baseline, migration: '0114' }], [{ ...baseline, migration: '0116' }],
  [{ ...baseline, leased: -1 }], [{ ...baseline, running: null }],
  [{ ...baseline, heartbeat: 'private-value' }]]) {
  assert.throws(() => healthState(value), /restart_health/);
}
assert.deepEqual(projectState({ id: PROJECT, name: 'vishar-crm-production', region: 'eu-west-2',
  status: 'ACTIVE_HEALTHY', credentials: 'private-value' }), { project: PROJECT, region: 'eu-west-2', status: 'ACTIVE_HEALTHY' });
assert.throws(() => projectState({ id: 'staging' }), /restart_project/);
const live = { source_sha: EVIDENCE_SOURCE, version: 'a1b2c3d4-1111-2222-3333-444444444444' };
const evidence = { source_sha: EVIDENCE_SOURCE, snapshot: live, natural_401_captured: true,
  stop_reason: 'natural_401_with_neighbor_success', stopped_at: '2026-08-28T16:55:00Z',
  records: [{ status: 401, supabase_code: 'PGRST303', sb_gateway_version: null, x_sb_error_code: null }] };
assert.equal(evidenceState(evidence, live, now).source_sha, EVIDENCE_SOURCE);
assert.throws(() => evidenceState({ ...evidence, natural_401_captured: false }, live, now), /restart_evidence/);
assert.throws(() => evidenceState(evidence, { ...live, version: 'different' }, now), /restart_evidence/);
assert.throws(() => evidenceState({ ...evidence, stopped_at: '2026-08-26T00:00:00Z' }, live, now), /restart_evidence/);
assert.throws(() => evidenceState({ ...evidence, records: [{ status: 401, supabase_code: 'PGRST303' }] }, live, now), /restart_evidence/);
for (const status of [200, 401, 429, 500, 'transport']) {
  let count = 0;
  const call = restartOnce('unit-test-placeholder', async (url, init) => {
    count++;
    assert.equal(url, `https://api.supabase.com/v1/projects/${PROJECT}/restart`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    if (status === 'transport') throw new Error('private-value');
    return new Response('private-value', { status });
  });
  if (status === 200) await call;
  else await assert.rejects(call, { message: 'restart_request_unknown' });
  assert.equal(count, 1);
}
assert.match(HEALTH_SQL, /^select/);
assert.doesNotMatch(HEALTH_SQL, /\b(insert|update|delete|alter|drop|create|truncate)\b/i);
const workflow = readFileSync(new URL('../.github/workflows/backend-auth-project-restart.yml', import.meta.url), 'utf8');
assert.match(workflow, /github.run_attempt == 1/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /group: backend-auth-scheduler-operation/);
assert.match(workflow, /supabase\/migrations\/0115_gmail_deposit_outbox_target\.sql/);
assert.match(workflow, /restart_migration_lineage_changed/);
assert.doesNotMatch(workflow, /wrangler deploy|db push|apply.migration|workflow_dispatch/);
for (const path of ['private-production-release.yml', 'private-production-release-observer.yml']) {
  assert.match(readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8'), /!release\/private-crm-rc\*-backend-auth-\*/);
}
console.log('Controlled Supabase restart: fixed target, evidence, quiet-window, privacy and no-retry tests passed.');
