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

console.log('Gmail rollout phase tests passed: 5, direct Gmail cron disabled in every phase');

const project = { id: 'vfjexhfdbrjmuxfdvbdx', name: 'vishar-crm-production', region: 'eu-west-2', status: 'ACTIVE_HEALTHY' };
const versions = ['0113', '0114', '0115'];
const bodies = expectedBodies(readFileSync('supabase/migrations/0115_gmail_deposit_outbox_target.sql', 'utf8'));
const before = { versions: ['0113', '0114'], leases: 0, failed: 0, overdue: 0,
  queue_digest: 'a'.repeat(32), heartbeat: new Date().toISOString(), functions: [{ name: 'record_email_outbox_result' }] };
const previous = assertState(project, before, versions, bodies, 'before');
const after = { ...before, versions, functions: Object.keys(bodies).map(name => ({
  name, body_md5: bodies[name], anon: false, authenticated: false, service: name !== 'gmail_deposit_email_obsolete',
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
const release = readFileSync('.github/workflows/gmail-deposit-database-release.yml', 'utf8');
assert(release.indexOf('scripts/verify-gmail-deposit-migration.mjs before') < release.indexOf('supabase db push --yes'));
assert(release.indexOf('supabase db push --yes') < release.indexOf('scripts/verify-gmail-deposit-migration.mjs after'));
assert(!release.includes('wrangler deploy'));
assert(!release.includes('supabase db reset'));
console.log('Gmail migration ledger, quiet queue, fixed target, function and ACL readback guards passed.');
