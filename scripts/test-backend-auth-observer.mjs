import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTailErrorClassifier, classifyTailError, assertDiscardLogSink, operationFromRef, extractDiagnostics, extractGmailDiagnostics, jsonFrames, hasMixed401, snapshot, tailArguments, WORKER, OBSERVE_MS } from './observe-backend-auth.mjs';
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
const gmailEnvelope = { ...envelope, logs: [
  { message: ['gmail outbox shared drain', JSON.stringify({ skipped: false, processed: 2, sent: 1, deduplicated: 0, failed: 1, private: pii })] },
  { message: ['gmail outbox shared drain failed', JSON.stringify({ code: 'gmail_service_binding_unavailable', private: pii })] },
  { message: ['gmail outbox shared drain failed', JSON.stringify({ code: pii })] },
  { message: ['arbitrary', JSON.stringify({ code: 'gmail_rpc_failed' })] },
], exceptions: [{ message: 'Error: gmail_supabase_publishable_unavailable', stack: pii },
  { message: `Error: gmail_rpc_failed ${pii}` }, { message: pii }] };
const gmailRows = extractGmailDiagnostics(gmailEnvelope, version);
assert.equal(gmailRows.length, 3);
assert.equal(gmailRows[0].processed, 2);
assert.equal(gmailRows[1].code, 'gmail_service_binding_unavailable');
assert.equal(gmailRows[2].code, 'gmail_supabase_publishable_unavailable');
assert.ok(!JSON.stringify(gmailRows).includes(pii));
assert.equal(extractGmailDiagnostics({ ...gmailEnvelope, scriptVersion: { id: 'different' } }, version).length, 0);
assert.equal(extractGmailDiagnostics({ ...gmailEnvelope, scriptName: 'another-worker' }, version).length, 0);
assert.equal(extractGmailDiagnostics({ ...gmailEnvelope, event: { request: {} } }, version).length, 0);
for (const counts of [{ processed: -1, sent: 0, deduplicated: 0, failed: 0 },
  { processed: 1, sent: 1, deduplicated: 1, failed: 0 },
  { processed: 21, sent: 0, deduplicated: 0, failed: 0 }]) {
  assert.equal(extractGmailDiagnostics({ ...envelope, logs: [{ message: ['gmail outbox shared drain',
    JSON.stringify({ skipped: false, ...counts })] }] }, version).length, 0);
}
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
assert.ok(observer.includes('tailError = classifyStderr(chunk)'));
const splitClassifier = createTailErrorClassifier();
assert.equal(splitClassifier('private-user@example.test Authenti'), 'unknown');
assert.equal(splitClassifier('cation error'), 'authentication');
assert.equal(splitClassifier('private trailing body'), 'authentication');
const boundedClassifier = createTailErrorClassifier();
assert.equal(boundedClassifier('private'.repeat(10000)), 'unknown');
assert.equal(boundedClassifier('A sampling rate must be '), 'unknown');
assert.equal(boundedClassifier('between 0 and 1'), 'invalid_sampling_rate');
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

const { GMAIL, WINDOW_MS, safeException, extractGmailRpc, gmailSnapshot } = await import('./observe-gmail-shared-drain.mjs');
assert.equal(WINDOW_MS, 8 * 60 * 1000);
const gmailRpc = { scriptName: GMAIL, scriptVersion: { id: version },
  event: { rpcMethod: 'drainApprovedEmailOutbox', arguments: [pii] }, outcome: 'exception',
  exceptions: [{ name: 'Error', message: 'gmail_supabase_secret_unavailable', stack: `at createGmailSupabase (${pii})` }],
  logs: [{ message: [JSON.stringify({ ...row, client: 'gmail_backend', rpc: 'claim_email_outbox' })] }] };
const rpcObservation = extractGmailRpc(gmailRpc, version);
assert.equal(rpcObservation.exceptions[0].code, 'gmail_supabase_secret_unavailable');
assert.deepEqual(rpcObservation.exceptions[0].frames, ['createGmailSupabase']);
assert.equal(rpcObservation.diagnostics[0].rpc, 'claim_email_outbox');
assert.ok(!JSON.stringify(rpcObservation).includes(pii));
for (const overrides of [{ scriptName: 'other' }, { scriptVersion: { id: 'other' } }, { event: { request: { body: pii } } }]) {
  assert.equal(extractGmailRpc({ ...gmailRpc, ...overrides }, version), null);
}
assert.deepEqual(safeException({ name: pii, message: pii, stack: pii }), { code: 'unclassified', name: null, frames: [] });
assert.equal(safeException({ message: 'gmail_rpc_failed ' + pii }).code, 'unclassified');
assert.equal(safeException({ message: 'x'.repeat(8193) }), null);
const gmailNames = ['GMAIL_TOKEN_ENCRYPTION_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SUPABASE_SECRET_KEY'];
const gmailValues = {
  '/settings': { bindings: [
    { name: 'SUPABASE_URL', text: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co' },
    { name: 'SUPABASE_PUBLISHABLE_KEY', text: 'sb_publishable_' + pii },
    ...['GMAIL_DRAIN_ENABLED', 'GMAIL_READ_ENABLED', 'GMAIL_OAUTH_ENABLED', 'GMAIL_VLADIMIR_ENABLED', 'GMAIL_KRISTINA_ENABLED'].map(name => ({ name, text: 'true' })),
    ...['GMAIL_OAUTH_STATE', 'GMAIL_OAUTH_TOKENS'].map((name, i) => ({ name, namespace_id: String(i + 1).repeat(32) })),
  ] },
  '/secrets': gmailNames.map(name => ({ name, value: pii })),
  '/deployments': { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] },
  '/schedules': { schedules: [] }, '/subdomain': { enabled: false, previews_enabled: false },
  [`/versions/${version}`]: { annotations: { 'workers/tag': sha } },
};
let gmailReads = 0;
const gmailState = await gmailSnapshot(env, async (url, init) => {
  gmailReads++;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GMAIL}`;
  assert.ok(url.startsWith(root));
  const path = url.slice(root.length);
  return path ? Response.json({ success: true, result: gmailValues[path] })
    : new Response(`WorkerEntrypoint drainApprovedEmailOutbox claim_email_outbox ${pii}`);
});
assert.equal(gmailReads, 7);
assert.equal(gmailState.version, version);
assert.equal(gmailState.publishable_kind_valid, true);
assert.equal(gmailState.code_markers.rpc_method_marker, true);
assert.ok(!JSON.stringify(gmailState).includes(pii));
const gmailWorkflow = readFileSync('.github/workflows/gmail-shared-drain-observe.yml', 'utf8');
for (const required of ['github.actor == github.repository_owner', 'crm-production', 'git rev-parse "$GITHUB_SHA^{tree}"',
  'refs/heads/agent/platform-telegram-self-service', 'Gmail production validation', 'ln -s /dev/null', 'retention-days: 7']) {
  assert.ok(gmailWorkflow.includes(required));
}
assert.doesNotMatch(gmailWorkflow, /wrangler deploy|secret put|SUPABASE_ACCESS_TOKEN|db push|workflow_dispatch/);
const gmailObserver = readFileSync('scripts/observe-gmail-shared-drain.mjs', 'utf8');
assert.doesNotMatch(gmailObserver, /\.drainApprovedEmailOutbox\(/);
assert.ok(gmailObserver.includes('JSON.stringify(before) !== JSON.stringify(after)'));
console.log('Gmail RPC observer: fixed targets, GET-only snapshots, natural-traffic and privacy checks passed.');
