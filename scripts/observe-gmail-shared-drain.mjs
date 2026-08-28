import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { snapshot, jsonFrames, extractGmailDiagnostics, assertDiscardLogSink,
  createTailErrorClassifier, WORKER as SCHEDULER } from './observe-backend-auth.mjs';
import { sanitizeBackendDiagnostic } from '../workers/lib/supabase-diagnostics.js';

export const GMAIL = 'vishar-gmail-production';
export const WINDOW_MS = 8 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ERROR_CODES = new Set(['gmail_supabase_url_invalid', 'gmail_supabase_secret_unavailable',
  'gmail_supabase_publishable_unavailable', 'gmail_rpc_forbidden', 'gmail_rpc_failed',
  'gmail_backend_rpc_not_allowed', 'gmail_email_job_invalid']);
const FRAMES = ['workerId', 'createGmailSupabase', 'drainEmailOutbox',
  'drainApprovedEmailOutbox', 'processEmailJob', 'resolveTarget', 'callRpc'];
const FLAGS = ['GMAIL_DRAIN_ENABLED', 'GMAIL_READ_ENABLED', 'GMAIL_OAUTH_ENABLED',
  'GMAIL_VLADIMIR_ENABLED', 'GMAIL_KRISTINA_ENABLED'];

export function safeException(value) {
  if (typeof value?.message !== 'string' || value.message.length > 8192) return null;
  const message = value.message.replace(/^Error: /, '');
  let code = ERROR_CODES.has(message) ? message : 'unclassified';
  if (/^Cannot perform I\/O on behalf of a different request\b/.test(message)) code = 'cross_request_io';
  if (/^No such (?:RPC )?method\b/i.test(message)) code = 'rpc_method_unavailable';
  if (/^Illegal invocation\b/.test(message)) code = 'illegal_invocation';
  const stack = typeof value.stack === 'string' ? value.stack.slice(0, 16384) : '';
  return { code, name: ['Error', 'TypeError', 'ReferenceError', 'RangeError'].includes(value.name) ? value.name : null,
    frames: FRAMES.filter(name => new RegExp('\\bat ' + name + '\\b').test(stack)) };
}

export function extractGmailRpc(envelope, version) {
  if (!UUID.test(version) || envelope?.scriptName !== GMAIL
    || envelope?.scriptVersion?.id !== version
    || envelope?.event?.rpcMethod !== 'drainApprovedEmailOutbox') return null;
  const diagnostics = [];
  for (const entry of (Array.isArray(envelope.logs) ? envelope.logs : []).slice(0, 100)) {
    if (!Array.isArray(entry?.message) || entry.message.length !== 1
      || typeof entry.message[0] !== 'string' || entry.message[0].length > 4096) continue;
    try {
      const row = sanitizeBackendDiagnostic(JSON.parse(entry.message[0]));
      if (row?.client === 'gmail_backend') diagnostics.push(row);
    } catch { /* Discard arbitrary log text. */ }
  }
  return { worker: GMAIL, worker_version: version, rpc_method: 'drainApprovedEmailOutbox',
    outcome: ['ok', 'exception', 'canceled', 'exceededCpu', 'exceededMemory'].includes(envelope.outcome) ? envelope.outcome : 'unknown',
    exceptions: (Array.isArray(envelope.exceptions) ? envelope.exceptions : []).slice(0, 10).map(safeException).filter(Boolean),
    diagnostics };
}

export async function gmailSnapshot(env, fetchImpl = fetch) {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_API_TOKEN) throw new Error('gmail_observer_config');
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GMAIL}`;
  const get = async (path, source = false) => {
    const response = await fetchImpl(root + path, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('gmail_observer_readback');
    if (source) {
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('gmail_observer_source_limit');
      return { rpc_method_marker: text.includes('drainApprovedEmailOutbox'),
        worker_entrypoint_marker: text.includes('WorkerEntrypoint'),
        claim_marker: text.includes('claim_email_outbox') };
    }
    const body = await response.json();
    if (body.success !== true) throw new Error('gmail_observer_readback');
    return body.result;
  };
  const [settings, secrets, deployments, schedules, subdomain, codeMarkers] = await Promise.all([
    get('/settings'), get('/secrets'), get('/deployments'), get('/schedules'), get('/subdomain'), get('', true),
  ]);
  const versions = deployments.deployments?.[0]?.versions;
  if (versions?.length !== 1 || versions[0].percentage !== 100 || !UUID.test(versions[0].version_id)) throw new Error('gmail_observer_version');
  const binding = name => settings.bindings?.find(b => b.name === name);
  const names = secrets.map(x => x.name).sort();
  const expected = ['GMAIL_TOKEN_ENCRYPTION_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SUPABASE_SECRET_KEY'].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)
    || binding('SUPABASE_URL')?.text !== 'https://vfjexhfdbrjmuxfdvbdx.supabase.co'
    || subdomain.enabled !== false || subdomain.previews_enabled !== false) throw new Error('gmail_observer_contract');
  const crons = (Array.isArray(schedules) ? schedules : schedules.schedules)?.map(x => x.cron).sort();
  if (!Array.isArray(crons) || crons.length) throw new Error('gmail_observer_contract');
  const metadata = await get(`/versions/${versions[0].version_id}`);
  const tag = metadata.annotations?.['workers/tag'];
  return { worker: GMAIL, version: versions[0].version_id, secret_names: names, crons,
    source_sha: /^[a-f0-9]{40}$/.test(tag || '') ? tag : null,
    flags: Object.fromEntries(FLAGS.map(name => [name, ['true', 'false'].includes(binding(name)?.text) ? binding(name).text : null])),
    publishable_kind_valid: /^sb_publishable_/.test(binding('SUPABASE_PUBLISHABLE_KEY')?.text || ''),
    oauth_kv: ['GMAIL_OAUTH_STATE', 'GMAIL_OAUTH_TOKENS'].map(name => ({ name,
      id: /^[a-f0-9]{32}$/.test(binding(name)?.namespace_id || '') ? binding(name).namespace_id : null })),
    code_markers: codeMarkers };
}

export async function main(env = process.env) {
  if (env.GITHUB_REPOSITORY !== 'vvetrov41-lgtm/Vishar-site' || env.GITHUB_ACTOR !== 'vvetrov41-lgtm'
    || !/^[a-f0-9]{40}$/.test(env.APPROVED_SHA || '') || !env.RUNNER_TEMP
    || !/^release\/private-crm-rc[0-9]+-backend-auth-gmail-observe-[a-z0-9-]+$/.test(env.GITHUB_REF_NAME || '')) throw new Error('gmail_observer_config');
  await assertDiscardLogSink(env.WRANGLER_LOG_PATH);
  const before = { scheduler: await snapshot(env), gmail: await gmailSnapshot(env) };
  const report = { source_sha: env.APPROVED_SHA, started_at: new Date().toISOString(), before,
    frame_counts: { scheduler: 0, gmail: 0 }, records: [] };
  const children = [], exits = [], pending = [];
  let stopped = false, reason = 'window_complete', settle, force;
  const stop = value => {
    if (stopped) return;
    stopped = true; reason = value;
    for (const child of children) child.kill('SIGINT');
    force = setTimeout(() => children.forEach(c => c.kill('SIGKILL')), 5000);
  };
  const deadline = setTimeout(() => stop('window_complete'), WINDOW_MS);
  for (const [worker, config, version] of [[SCHEDULER, 'wrangler.telegram-drain.production.toml', before.scheduler.version],
    [GMAIL, 'wrangler.gmail.production.toml', before.gmail.version]]) {
    const args = ['node_modules/wrangler/bin/wrangler.js', 'tail', worker, '--config', config, '--format', 'json', '--version-id', version];
    if (worker === SCHEDULER) args.push('--search', 'gmail outbox shared drain');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    children.push(child);
    const classify = createTailErrorClassifier();
    let tailError = 'unknown';
    const consume = jsonFrames(envelope => {
      const key = worker === SCHEDULER ? 'scheduler' : 'gmail';
      report.frame_counts[key] = Math.min(report.frame_counts[key] + 1, 10000);
      const records = worker === SCHEDULER ? extractGmailDiagnostics(envelope, version) : [extractGmailRpc(envelope, version)].filter(Boolean);
      for (const record of records) {
        if (report.records.length >= 100) { stop('record_limit'); break; }
        report.records.push({ observed_at: new Date().toISOString(), ...record });
      }
      if (!settle && report.records.some(r => r.worker === GMAIL) && report.records.some(r => r.worker === SCHEDULER)) {
        settle = setTimeout(() => stop('natural_shared_drain_observed'), 2000);
      }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { try { consume(value); } catch { stop('frame_limit'); } });
    child.stderr.on('data', value => { tailError = classify(value); });
    pending.push(new Promise(resolve => {
      child.on('error', () => { stop('tail_start_failed'); resolve(); });
      child.on('close', code => { exits.push({ worker, code: Number.isInteger(code) ? code : null, error: tailError });
        if (!stopped) stop('tail_closed'); resolve(); });
    }));
  }
  await Promise.all(pending);
  clearTimeout(deadline); clearTimeout(settle); clearTimeout(force);
  const after = { scheduler: await snapshot(env), gmail: await gmailSnapshot(env) };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('gmail_observer_runtime_changed');
  Object.assign(report, { after, stop_reason: reason, stopped_at: new Date().toISOString(), tails: exits });
  await writeFile(`${env.RUNNER_TEMP}/gmail-shared-drain-evidence.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (['tail_closed', 'tail_start_failed', 'frame_limit'].includes(reason)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('gmail_shared_observer_failed'); process.exitCode = 1; });
}
