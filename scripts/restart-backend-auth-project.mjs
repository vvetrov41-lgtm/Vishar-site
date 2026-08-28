import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { snapshot } from './observe-backend-auth.mjs';

export const PROJECT = 'vfjexhfdbrjmuxfdvbdx';
export const EXPECTED_MIGRATION = '0115';
export const EVIDENCE_RUN = 33191205274;
export const EVIDENCE_SOURCE = '1d88d6158320025a7a7b9aaa18fa6b20cd54f781';
const ROOT = `https://api.supabase.com/v1/projects/${PROJECT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw new Error(code); };
const CODES = new Set(['restart_config', 'restart_project', 'restart_health', 'restart_evidence',
  'restart_busy', 'restart_runtime_changed', 'restart_request_unknown', 'restart_recovery_timeout',
  'restart_api_read', 'restart_ref_changed']);

// Fixed aggregate SELECT only. No customer rows, credentials, or query text from the environment.
export const HEALTH_SQL = `select
  (select max(version) from supabase_migrations.schema_migrations) as migration,
  (select count(distinct artist_id) from public.automation_rules where is_enabled) as artists,
  (select count(*) from public.automation_rules where is_enabled) as rules,
  (select count(*) from public.artist_integrations where is_enabled) as integrations,
  (select count(*) from public.artist_integrations where is_enabled and last_error_at is not null
    and (last_success_at is null or last_error_at > last_success_at)) as integration_errors,
  (select count(*) from public.automation_jobs where status='failed' and updated_at > now()-interval '7 days') as failed,
  (select count(*) from public.automation_jobs where status='pending') as pending,
  (select count(*) from public.automation_jobs where status='pending' and scheduled_at < now()-interval '15 minutes') as overdue,
  (select count(*) from public.automation_jobs where status='running') as running,
  (select count(*) from public.automation_jobs where status='pending' and scheduled_at < now()+interval '3 minutes') as due_soon,
  (select count(*) from public.integration_outbox where status='leased') as leased,
  (select count(*) from pg_stat_activity where pid <> pg_backend_pid() and backend_type='client backend'
    and xact_start is not null and state <> 'idle') as active_transactions,
  (select last_succeeded_at from crm_private.automation_scheduler_heartbeat) as heartbeat`;

export function projectState(value) {
  if (value?.id !== PROJECT || value?.name !== 'vishar-crm-production'
    || value?.region !== 'eu-west-2' || !['ACTIVE_HEALTHY', 'RESTARTING', 'COMING_UP', 'ACTIVE_UNHEALTHY'].includes(value?.status)) fail('restart_project');
  return { project: PROJECT, region: 'eu-west-2', status: value.status };
}

export function healthState(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) fail('restart_health');
  const row = rows[0], out = {};
  if (row.migration !== EXPECTED_MIGRATION || !Number.isFinite(Date.parse(row.heartbeat))) fail('restart_health');
  out.migration = row.migration;
  for (const key of ['artists', 'rules', 'integrations', 'integration_errors', 'failed', 'pending',
    'overdue', 'running', 'due_soon', 'leased', 'active_transactions']) {
    const value = row[key];
    if (!/^(0|[1-9][0-9]{0,8})$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('restart_health');
    out[key] = Number(value);
  }
  out.heartbeat = new Date(row.heartbeat).toISOString();
  return out;
}

export function healthy(state, now = Date.now()) {
  const age = now - Date.parse(state.heartbeat);
  return state.artists === 2 && state.rules === 12 && state.integrations === 13
    && state.failed === 0 && state.overdue === 0 && state.integration_errors === 0
    && age >= 0 && age < 15 * 60 * 1000;
}

export function quiet(state, now = Date.now()) {
  // Start between seconds 60 and 120 of the five-minute cron interval.
  // This is a low-load guard, not a promise of zero downtime or a global lock.
  const phase = now % (5 * 60 * 1000);
  return healthy(state, now) && state.running === 0 && state.leased === 0
    && state.due_soon === 0 && state.active_transactions === 0 && phase >= 60000 && phase < 120000;
}

export function evidenceState(value, live, now = Date.now()) {
  if (value?.source_sha !== EVIDENCE_SOURCE || value?.snapshot?.source_sha !== EVIDENCE_SOURCE
    || value?.snapshot?.version !== live.version || live.source_sha !== EVIDENCE_SOURCE
    || value?.natural_401_captured !== true || value?.stop_reason !== 'natural_401_with_neighbor_success'
    || !Array.isArray(value.records) || value.records.length > 250
    || !value.records.some(r => r.status === 401 && r.supabase_code === 'PGRST303'
      && Object.hasOwn(r, 'sb_gateway_version') && Object.hasOwn(r, 'x_sb_error_code'))
    || !Number.isFinite(Date.parse(value.stopped_at)) || now - Date.parse(value.stopped_at) < 0
    || now - Date.parse(value.stopped_at) > 24 * 60 * 60 * 1000) fail('restart_evidence');
  return { run_id: EVIDENCE_RUN, source_sha: EVIDENCE_SOURCE, worker_version: live.version,
    captured_at: new Date(value.stopped_at).toISOString() };
}

export async function restartOnce(token, fetchImpl = fetch) {
  // Never retry this POST, including transport errors and ambiguous non-2xx responses.
  try {
    const response = await fetchImpl(`${ROOT}/restart`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (response.status !== 200) fail('restart_request_unknown');
    await response.body?.cancel(); // No raw provider response is printed or persisted.
  } catch { fail('restart_request_unknown'); }
}

export async function main(env = process.env) {
  if (!env.SUPABASE_ACCESS_TOKEN || !env.GH_TOKEN || env.GITHUB_RUN_ATTEMPT !== '1'
    || env.DEPLOY_ENABLED !== 'true' || env.GITHUB_REPOSITORY !== 'vvetrov41-lgtm/Vishar-site'
    || env.GITHUB_ACTOR !== 'vvetrov41-lgtm' || !/^[a-f0-9]{40}$/.test(env.APPROVED_SHA || '')
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    || !/^release\/private-crm-rc[0-9]+-backend-auth-restart-[a-z0-9-]+$/.test(env.GITHUB_REF_NAME || '')
    || !env.RUNNER_TEMP) fail('restart_config');
  const report = { schema_version: 1, project: PROJECT, region: 'eu-west-2',
    source_sha: env.APPROVED_SHA, restart_requested_at: null, restart_accepted: false };
  const save = () => writeFile(`${env.RUNNER_TEMP}/backend-auth-restart.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  const read = async (path, sql = false) => {
    const response = await fetch(ROOT + path, { method: sql ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      ...(sql ? { body: JSON.stringify({ query: HEALTH_SQL, read_only: true }) } : {}),
      signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail('restart_api_read');
    return response.json();
  };
  const checkRefs = async () => {
    for (const [branch, sha] of [['agent/platform-telegram-self-service', env.APPROVED_SHA], [env.GITHUB_REF_NAME, env.GITHUB_SHA]]) {
      const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/${branch}`, {
        redirect: 'error', headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000) });
      if (!response.ok || (await response.json()).object?.sha !== sha) fail('restart_ref_changed');
    }
  };
  try {
    const live = await snapshot(env);
    const evidence = JSON.parse(await readFile(`${env.RUNNER_TEMP}/backend-auth-evidence.json`, 'utf8'));
    report.evidence = evidenceState(evidence, live);
    report.worker_before = live;
    const deadline = Date.now() + 10 * 60 * 1000;
    let state;
    while (Date.now() < deadline) {
      const project = projectState(await read(''));
      state = healthState(await read('/database/query', true));
      if (project.status !== 'ACTIVE_HEALTHY' || !healthy(state)) fail('restart_health');
      if (quiet(state)) break;
      await sleep(10000);
    }
    if (!quiet(state)) fail('restart_busy');
    await checkRefs();
    if (JSON.stringify(await snapshot(env)) !== JSON.stringify(live)) fail('restart_runtime_changed');
    // Refresh database load immediately before the one and only mutation.
    state = healthState(await read('/database/query', true));
    if (!quiet(state)) fail('restart_busy');
    report.before = state;
    report.restart_requested_at = new Date().toISOString();
    await save();
    await restartOnce(env.SUPABASE_ACCESS_TOKEN);
    report.restart_accepted = true;
    await save();
    const recoveryDeadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < recoveryDeadline) {
      await sleep(15000);
      let project, health;
      try { project = projectState(await read('')); health = healthState(await read('/database/query', true)); }
      catch { continue; } // Read-only recovery polling, never another restart.
      if (project.status === 'ACTIVE_HEALTHY' && healthy(health)
        && Date.parse(health.heartbeat) > Date.parse(report.restart_requested_at)) {
        const after = await snapshot(env);
        if (JSON.stringify(after) !== JSON.stringify(live)) fail('restart_runtime_changed');
        report.after = health; report.worker_after = after;
        report.recovered_at = new Date().toISOString();
        await save();
        console.log(JSON.stringify(report));
        return;
      }
    }
    fail('restart_recovery_timeout');
  } catch (error) {
    report.error = CODES.has(error?.message) ? error.message : 'restart_api_read';
    await save();
    console.error(report.error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('restart_config'); process.exitCode = 1; });
}
