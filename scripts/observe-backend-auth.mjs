import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DIAGNOSTIC_EVENT, sanitizeBackendDiagnostic } from '../workers/lib/supabase-diagnostics.js';

export const WORKER = 'vishar-telegram-drain-production';
export const OBSERVE_MS = 20 * 60 * 1000;
export const MAX_RECORDS = 250;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SECRET_NAMES = ['ARTIST_TELEGRAM_KRISTINA_HPRODUCTION', 'ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION',
  'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].sort();

// The operation comes from the first, anchored subtype, never from its suffix.
export function operationFromRef(ref) {
  const match = /^release\/private-crm-rc[0-9]+-backend-auth-(release|observe)-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(ref || '');
  if (!match) throw new Error('backend_auth_ref_invalid');
  return match[1];
}

// Wrangler prints pretty JSON objects, not NDJSON. Raw frames never leave memory.
export function jsonFrames(accept) {
  let frame = '', depth = 0, quoted = false, escaped = false;
  return chunk => {
    for (const char of chunk) {
      if (!depth && char !== '{') continue;
      frame += char;
      if (frame.length > 1024 * 1024) throw new Error('observer_frame_limit');
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (!depth) {
        let value;
        try { value = JSON.parse(frame); } catch { /* discard malformed frame */ }
        frame = '';
        if (value) accept(value);
      }
    }
  };
}

export function extractDiagnostics(envelope, version) {
  if (!UUID.test(version) || envelope?.event?.cron !== '*/5 * * * *'
    || !Number.isSafeInteger(envelope.event.scheduledTime) || envelope.event.scheduledTime < 0
    || envelope.event.scheduledTime > 8640000000000000
    || (envelope.scriptName && envelope.scriptName !== WORKER)
    || (envelope.scriptVersion?.id && envelope.scriptVersion.id !== version)) return [];
  const result = [];
  for (const entry of (Array.isArray(envelope.logs) ? envelope.logs : []).slice(0, 500)) {
    if (!Array.isArray(entry?.message) || entry.message.length !== 1
      || typeof entry.message[0] !== 'string' || entry.message[0].length > 4096) continue;
    let value;
    try { value = sanitizeBackendDiagnostic(JSON.parse(entry.message[0])); } catch { continue; }
    if (value) result.push({ ...value, worker: WORKER, worker_version: version,
      scheduled_at: new Date(envelope.event.scheduledTime).toISOString() });
  }
  return result;
}

export function hasMixed401(records) {
  return records.some(a => a.status === 401 && records.some(b => b.status === 200
    && a.scheduled_at === b.scheduled_at && a.worker_version === b.worker_version
    && a.key_kind === b.key_kind && a.client === b.client));
}

export async function snapshot(env, fetchImpl = fetch) {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_API_TOKEN) throw new Error('observer_config');
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}`;
  const get = async path => {
    const response = await fetchImpl(root + path, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('observer_readback');
    const body = await response.json();
    if (body.success !== true) throw new Error('observer_readback');
    return body.result;
  };
  const [settings, secrets, deployments, schedules, subdomain] = await Promise.all([
    get('/settings'), get('/secrets'), get('/deployments'), get('/schedules'), get('/subdomain'),
  ]);
  const names = secrets.map(x => x.name).sort();
  const versions = deployments.deployments?.[0]?.versions;
  const crons = (Array.isArray(schedules) ? schedules : schedules.schedules)?.map(x => x.cron).sort();
  const binding = name => settings.bindings?.find(x => x.name === name);
  if (JSON.stringify(names) !== JSON.stringify(SECRET_NAMES)
    || versions?.length !== 1 || versions[0].percentage !== 100 || !UUID.test(versions[0].version_id)
    || JSON.stringify(crons) !== JSON.stringify(['*/5 * * * *'])
    || subdomain.enabled !== false || subdomain.previews_enabled !== false
    || binding('SUPABASE_URL')?.text !== 'https://vfjexhfdbrjmuxfdvbdx.supabase.co'
    || binding('AUTOMATION_TICK_ENABLED')?.text !== 'true'
    || binding('TELEGRAM_DRAIN_ENABLED')?.text !== 'true'
    || binding('GMAIL_SHARED_DRAIN_ENABLED')?.text !== 'true'
    || binding('GMAIL_SERVICE')?.service !== 'vishar-gmail-production') throw new Error('observer_contract');
  const version = versions[0].version_id;
  const metadata = await get(`/versions/${version}`);
  const tag = metadata.annotations?.['workers/tag'];
  return { worker: WORKER, version, secret_names: names, crons, key_kind: 'secret',
    source_sha: /^[a-f0-9]{40}$/.test(tag || '') ? tag : null };
}

export const tailArguments = version => ['node_modules/wrangler/bin/wrangler.js', 'tail', WORKER,
  '--config', 'wrangler.telegram-drain.production.toml', '--format', 'json', '--version-id', version,
  '--sampling-rate', '1', '--search', DIAGNOSTIC_EVENT];

export async function main(env = process.env, output = process.argv[2]) {
  if (!/^[a-f0-9]{40}$/.test(env.APPROVED_SHA || '') || !output) throw new Error('observer_source');
  const before = await snapshot(env);
  if (before.source_sha !== env.APPROVED_SHA) throw new Error('observer_version_source');
  const records = [];
  let reason = 'window_complete', stopRequested = false, force;
  const child = spawn(process.execPath, tailArguments(before.version), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '/dev/null' },
  });
  const stop = why => {
    if (stopRequested) return;
    stopRequested = true; reason = why; child.kill('SIGINT');
    force = setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  const deadline = setTimeout(() => stop('window_complete'), OBSERVE_MS);
  const consume = jsonFrames(envelope => {
    for (const record of extractDiagnostics(envelope, before.version)) {
      if (records.length >= MAX_RECORDS) { stop('record_limit'); break; }
      records.push(record);
      console.log(JSON.stringify(record));
    }
    if (hasMixed401(records)) stop('natural_401_with_neighbor_success');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { try { consume(chunk); } catch { stop('frame_limit'); } });
  child.stderr.on('data', () => {}); // Never forward or persist raw Wrangler diagnostics.
  await new Promise(resolve => {
    child.on('error', () => { reason = 'tail_start_failed'; resolve(); });
    child.on('close', () => { if (!stopRequested) reason = 'tail_closed'; resolve(); });
  });
  clearTimeout(deadline); clearTimeout(force);
  const after = await snapshot(env);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('observer_runtime_changed');
  await writeFile(output, JSON.stringify({ schema_version: 1, source_sha: env.APPROVED_SHA, snapshot: after,
    stopped_at: new Date().toISOString(), stop_reason: reason, natural_401_captured: hasMixed401(records), records }, null, 2), { mode: 0o600 });
  console.log(`Backend auth observer: ${reason}; safe_records=${records.length}`);
  if (['frame_limit', 'tail_start_failed', 'tail_closed'].includes(reason)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('backend_auth_observer_failed'); process.exitCode = 1; });
}
