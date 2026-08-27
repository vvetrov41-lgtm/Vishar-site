import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyTailError, assertDiscardLogSink, operationFromRef, extractDiagnostics, jsonFrames, hasMixed401, snapshot, tailArguments, WORKER, OBSERVE_MS } from './observe-backend-auth.mjs';
const version = '12345678-abcd-4abc-8abc-123456789012';
const sha = 'a'.repeat(40);
const pii = 'private-customer@example.test';
const row = { event: 'supabase_backend_response', schema_version: 1, rpc: 'claim_telegram_outbox',
  client: 'shared_backend', key_kind: 'secret', status: 401, attempt: 1, supabase_code: 'PGRST303',
  auth_reason: 'jwt_expired', received_at: '2026-08-27T13:00:00.000Z', body_state: 'parsed', private: pii };
const envelope = { scriptName: WORKER, scriptVersion: { id: version },
  event: { cron: '*/5 * * * *', scheduledTime: Date.parse(row.received_at), request: { authorization: pii } },
  exceptions: [{ message: pii }], logs: [{ message: [JSON.stringify(row)] }, { message: [pii] },
    { message: [JSON.stringify({ ...row, status: 200, attempt: 2 })] }] };
const frames = [];
const parse = jsonFrames(x => frames.push(x));
const input = 'Wrangler preface\n' + JSON.stringify(envelope, null, 2);
for (let i = 0; i < input.length; i += 7) parse(input.slice(i, i + 7));
assert.equal(frames.length, 1);
const rows = extractDiagnostics(frames[0], version);
assert.equal(rows.length, 2);
assert.ok(!JSON.stringify(rows).includes(pii));
assert.ok(hasMixed401(rows));
assert.ok(!hasMixed401([rows[0], { ...rows[1], scheduled_at: 'different' }]));
assert.ok(!hasMixed401([rows[0], { ...rows[1], key_kind: 'legacy_service_role' }]));
assert.equal(extractDiagnostics({ ...envelope, event: { request: {} } }, version).length, 0);
assert.equal(extractDiagnostics({ ...envelope, scriptName: 'another-worker' }, version).length, 0);
assert.equal(extractDiagnostics({ ...envelope, scriptVersion: { id: 'different' } }, version).length, 0);
assert.throws(() => jsonFrames(() => {})('{' + ' '.repeat(1024 * 1024)), /frame_limit/);
assert.equal(OBSERVE_MS, 1200000);
assert.ok(tailArguments(version).includes(version));
assert.ok(tailArguments(version).includes('supabase_backend_response'));
const secrets = ['ARTIST_TELEGRAM_KRISTINA_HPRODUCTION', 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
  'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].map(name => ({ name, value: pii }));
const values = {
  '/settings': { bindings: [
    { name: 'SUPABASE_URL', text: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co' },
    ...['AUTOMATION_TICK_ENABLED', 'TELEGRAM_DRAIN_ENABLED', 'GMAIL_SHARED_DRAIN_ENABLED'].map(name => ({ name, text: 'true' })),
    { name: 'GMAIL_SERVICE', service: 'vishar-gmail-production' } ] },
  '/secrets': secrets, '/deployments': { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] },
  '/schedules': { schedules: [{ cron: '*/5 * * * *' }] }, '/subdomain': { enabled: false, previews_enabled: false },
  [`/versions/${version}`]: { annotations: { 'workers/tag': sha }, private: pii },
};
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-cf-token' };
let calls = 0;
const mockFetch = async (url, init) => {
  calls++;
  assert.equal(init.method, undefined, 'all snapshot requests must be GET');
  const prefix = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}`;
  assert.ok(url.startsWith(prefix));
  return Response.json({ success: true, result: values[url.slice(prefix.length)] });
};
const state = await snapshot(env, mockFetch);
assert.equal(calls, 6);
assert.equal(state.source_sha, sha);
assert.ok(!JSON.stringify(state).includes(pii));
values['/subdomain'].enabled = true;
await assert.rejects(snapshot(env, mockFetch), /observer_contract/);
const workflow = readFileSync('.github/workflows/backend-auth-scheduler-release.yml', 'utf8');
for (const boundary of ['github.actor == github.repository_owner', 'github.event.before !=', 'crm-production',
  'git rev-parse "$GITHUB_SHA^{tree}"', 'refs/heads/agent/platform-telegram-self-service',
  'CRM and booking validation', 'retention-days: 7', '--tag "$APPROVED_SHA"', 'release/private-crm-rc*-backend-auth-release-']) assert.ok(workflow.includes(boundary), boundary);
for (const forbidden of ['supabase db push', 'pages deploy', 'secrets.SUPABASE', 'secret put', 'workflow_dispatch']) assert.ok(!workflow.includes(forbidden), forbidden);
const observer = readFileSync('scripts/observe-backend-auth.mjs', 'utf8');
assert.ok(observer.includes('const category = classifyTailError(chunk)'));
assert.equal(classifyTailError('Authentication error secret@example.test'), 'authentication');
assert.equal(classifyTailError('private response body'), 'unknown');
assert.equal(classifyTailError('A sampling rate must be between 0 and 1'), 'invalid_sampling_rate');
assert.ok(observer.includes('await assertDiscardLogSink(env.WRANGLER_LOG_PATH)'));
assert.ok(!tailArguments(version).includes('--sampling-rate'), 'Wrangler rejects 1; omission means full stream');
assert.ok(observer.includes('JSON.stringify(before) !== JSON.stringify(after)'));
console.log('Backend auth observer privacy and release boundaries passed.');

for (const path of ['.github/workflows/private-production-release.yml', '.github/workflows/private-production-release-observer.yml']) {
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes("- '!release/private-crm-rc*-backend-auth-*'"));
  assert.ok(source.includes("release/private-crm-rc*-backend-auth*) echo 'Backend auth refs must use the scheduler-only workflow.' >&2; exit 1 ;;"));
}

assert.equal(operationFromRef('release/private-crm-rc123-backend-auth-release-diagnostic'), 'release');
assert.equal(operationFromRef('release/private-crm-rc123-backend-auth-observe-diagnostic'), 'observe');
assert.equal(operationFromRef('release/private-crm-rc122-backend-auth-observe-retry-backend-auth-release-check'), 'observe');
assert.equal(operationFromRef('release/private-crm-rc122-backend-auth-release-retry-backend-auth-observe-check'), 'release');
for (const invalid of ['ops/backend-auth-release-test', 'release/private-crm-rc123-other-backend-auth-release-test', 'release/private-crm-rc123-backend-auth-unknown-test']) {
  assert.throws(() => operationFromRef(invalid), /backend_auth_ref_invalid/);
}
assert.equal(workflow.match(/if: env.BACKEND_AUTH_OPERATION == 'release'/g)?.length, 2);
assert.ok(!workflow.includes('contains(github.ref_name'));
assert.ok(workflow.includes("operationFromRef(process.env.GITHUB_REF_NAME)"));

const { mkdtemp, symlink, writeFile, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const sinkDir = await mkdtemp(join(tmpdir(), 'auth-sink-test-'));
try {
  const sink = join(sinkDir, 'discard.log');
  await symlink('/dev/null', sink);
  await assertDiscardLogSink(sink);
  await writeFile(sink, 'synthetic-private-text');
  assert.equal(await readFile(sink, 'utf8'), '');
  await assert.rejects(assertDiscardLogSink('/dev/null'), /observer_log_sink_invalid/);
  const normal = join(sinkDir, 'normal.log');
  await writeFile(normal, '');
  await assert.rejects(assertDiscardLogSink(normal), /observer_log_sink_invalid/);
} finally { await rm(sinkDir, { recursive: true, force: true }); }
assert.ok(workflow.includes('ln -s /dev/null "$WRANGLER_LOG_PATH"'));
assert.ok(workflow.includes("['merge-base', '--is-ancestor', state.source_sha, process.env.APPROVED_SHA]"));
assert.ok(workflow.includes("['diff', '--quiet', state.source_sha, process.env.APPROVED_SHA"));
assert.ok(observer.includes('source_sha: deployedSource, observer_source_sha: env.APPROVED_SHA'));

assert.ok(!workflow.split('    steps:')[0].includes('runner.temp'), 'runner context is unavailable in job-level env');
assert.ok(workflow.includes('echo "WRANGLER_LOG_PATH=$WRANGLER_LOG_PATH" >> "$GITHUB_ENV"'));
