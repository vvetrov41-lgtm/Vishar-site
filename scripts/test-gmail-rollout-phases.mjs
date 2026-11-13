import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertState, expectedBodies, verify, STATE_SQL } from './verify-gmail-deposit-migration.mjs';

const rootEnv = {
  ...process.env,
  GMAIL_KV_STATE_ID: '1'.repeat(32),
  GMAIL_KV_TOKENS_ID: '2'.repeat(32),
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_syntheticproductionvalue000000000000',
};

function render(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-phase-'));
  const output = join(dir, 'wrangler.toml');
  try {
    const result = spawnSync(process.execPath, ['scripts/generate-gmail-production-deploy-config.mjs', output, phase], {
      cwd: process.cwd(),
      env: rootEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${phase} generator failed: ${result.stderr}`);
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectFlag(config, name, value) {
  assert.match(config, new RegExp(`${name} = "${value}"`));
}

function expectNoGmailCron(config) {
  assert.match(config, /\[triggers\][\s\S]*crons = \[\]/);
  assert.equal(config.includes('*/5 * * * *'), false, 'Gmail Worker must not own a Cron Trigger');
}

const bootstrap = render('bootstrap');
expectFlag(bootstrap, 'GMAIL_OAUTH_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_READ_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_VLADIMIR_ENABLED', 'false');
expectFlag(bootstrap, 'GMAIL_KRISTINA_ENABLED', 'false');
expectNoGmailCron(bootstrap);

const vladimirRead = render('vladimir-read');
expectFlag(vladimirRead, 'GMAIL_OAUTH_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_READ_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(vladimirRead, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(vladimirRead, 'GMAIL_KRISTINA_ENABLED', 'false');
expectNoGmailCron(vladimirRead);

const vladimirSend = render('vladimir-send');
expectFlag(vladimirSend, 'GMAIL_DRAIN_ENABLED', 'true');
expectFlag(vladimirSend, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(vladimirSend, 'GMAIL_KRISTINA_ENABLED', 'false');
expectNoGmailCron(vladimirSend);

const kristinaRead = render('kristina-read');
expectFlag(kristinaRead, 'GMAIL_OAUTH_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_READ_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_DRAIN_ENABLED', 'false');
expectFlag(kristinaRead, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(kristinaRead, 'GMAIL_KRISTINA_ENABLED', 'true');
expectNoGmailCron(kristinaRead);

const kristinaSend = render('kristina-send');
expectFlag(kristinaSend, 'GMAIL_DRAIN_ENABLED', 'true');
expectFlag(kristinaSend, 'GMAIL_VLADIMIR_ENABLED', 'true');
expectFlag(kristinaSend, 'GMAIL_KRISTINA_ENABLED', 'true');
expectNoGmailCron(kristinaSend);

const releaseWorkflow = readFileSync('.github/workflows/gmail-production-rollout.yml','utf8');
assert.match(releaseWorkflow,/PHASE" = 'bootstrap'/);
assert.match(releaseWorkflow,/workers\/scripts\/\$GMAIL_WORKER_NAME\/settings/);
assert.match(releaseWorkflow,/GMAIL_OAUTH_STATE" and \.type=="kv_namespace"/);
assert.match(releaseWorkflow,/GMAIL_OAUTH_TOKENS" and \.type=="kv_namespace"/);
assert.match(releaseWorkflow,/4bdea97be49c4ca8975f95391a7ffdf1/);
assert.match(releaseWorkflow,/143c9044f0ff4acd93f6c9cf7d022a66/);
assert.match(releaseWorkflow,/test "\$state_id" != "\$tokens_id"/);
console.log('Gmail rollout phase tests passed: 5, direct Gmail cron disabled in every phase');

const project = { id: 'vfjexhfdbrjmuxfdvbdx', name: 'vishar-crm-production', region: 'eu-west-2', status: 'ACTIVE_HEALTHY' };
const versions = ['0113', '0114', '0115'];
const bodies = expectedBodies(readFileSync('supabase/migrations/0115_gmail_deposit_outbox_target.sql', 'utf8'));
const before = { versions: ['0113', '0114'], leases: 0, failed: 0, overdue: 0,
  queue_digest: 'a'.repeat(32), heartbeat: new Date().toISOString(),
  functions: [{ name: 'record_email_outbox_result' }, { name: 'guard_email_automation_job' }] };
const previous = assertState(project, before, versions, bodies, 'before');
const after = { ...before, versions, functions: Object.keys(bodies).map(name => ({
  name, body_md5: bodies[name], anon: false, authenticated: false,
  service: name === 'service_resolve_gmail_outbox_target' || name === 'record_email_outbox_result',
})) };
assert.equal(assertState(project, after, versions, bodies, 'after', previous).functions_verified, true);
for (const change of [{ versions }, { versions: ['0114'] }, { leases: 1 }, { leases: null },
  { failed: 1 }, { overdue: 1 }, { heartbeat: 'invalid' }, { heartbeat: new Date(Date.now() - 1000000).toISOString() }]) {
  assert.throws(() => assertState(project, { ...before, ...change }, versions, bodies, 'before'));
}
for (const change of [{ id: 'a'.repeat(20) }, { status: 'RESTARTING' }, { region: 'eu-west-1' }]) {
  assert.throws(() => assertState({ ...project, ...change }, before, versions, bodies, 'before'));
}
for (const change of [{ queue_digest: 'b'.repeat(32) }, { versions: before.versions },
  { functions: after.functions.slice(1) },
  { functions: after.functions.map(f => ({ ...f, authenticated: true })) },
  { functions: after.functions.map(f => ({ ...f, body_md5: 'c'.repeat(32) })) }]) {
  assert.throws(() => assertState(project, { ...after, ...change }, versions, bodies, 'after', previous));
}
assert.throws(() => assertState(project, after, versions, bodies, 'after'));
assert.throws(() => expectedBodies('unrelated migration'));
const requests = [];
await assert.rejects(verify({ PROJECT_REF: project.id, SUPABASE_ACCESS_TOKEN: 'synthetic-only' }, 'before', undefined, async (url, options) => {
  requests.push({ url, options });
  return Response.json(requests.length === 1 ? project : []);
}), /gmail_migration_read/);
assert.deepEqual(requests.map(x => x.options.method), ['GET', 'POST']);
assert.deepEqual(JSON.parse(requests[1].options.body), { query: STATE_SQL, read_only: true });
assert(requests.every(x => x.url.startsWith(`https://api.supabase.com/v1/projects/${project.id}`)));
console.log('Gmail migration ledger, quiet queue, fixed target, function and ACL readback guards passed.');

// GitHub run 42588957009 completed successfully at 2026-11-09 08:51 UTC:
// its deployment job emitted version e3ab9d82-7d65-4c27-ad34-bc98003dac68.
// This is a one-version exception, not blanket permission for untagged Workers.
const gmailRedeploy = readFileSync('.github/workflows/gmail-backend-production-redeploy.yml','utf8');
assert.match(gmailRedeploy, /\[ "\$pre_version" = 'e3ab9d82-7d65-4c27-ad34-bc98003dac68' \]/);
assert.match(gmailRedeploy, /git merge-base --is-ancestor '52dbfce5c4500a1b37a769fec1f90d11e8095da5' "\$GITHUB_SHA"/);
assert.match(gmailRedeploy, /Unknown untagged source must never be overwritten/);
assert.match(gmailRedeploy, /exit 1\n\s+fi\n\s+echo "Gmail preflight version/);
assert.match(gmailRedeploy, /"pre_version" = '139682f0-c10b-4637-be2f-b17941ad0cba'/);
console.log('Gmail untagged production version allowance remains exact, proof-bound and fail-closed.');
