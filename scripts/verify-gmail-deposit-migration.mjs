import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROJECT = 'vfjexhfdbrjmuxfdvbdx';
const MIGRATION = '0115_gmail_deposit_outbox_target.sql';
const FUNCTIONS = ['gmail_deposit_email_obsolete', 'service_resolve_gmail_outbox_target', 'record_email_outbox_result'];
export const STATE_SQL = `select
  (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations) as versions,
  (select count(*) from public.integration_outbox where kind='approved_email' and status='leased') as leases,
  (select md5(coalesce(string_agg(concat_ws(':',id,status,attempt_count,leased_by,lease_expires_at,last_error_code),',' order by id),''))
    from public.integration_outbox where kind='approved_email') as queue_digest,
  (select last_succeeded_at from crm_private.automation_scheduler_heartbeat) as heartbeat,
  (select count(*) from public.automation_jobs where status='failed' and updated_at>now()-interval '7 days') as failed,
  (select count(*) from public.automation_jobs where status='pending' and scheduled_at<now()-interval '15 minutes') as overdue,
  (select jsonb_agg(jsonb_build_object('name',p.proname,'body_md5',md5(p.prosrc),
     'anon',has_function_privilege('anon',p.oid,'EXECUTE'),
     'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
     'service',has_function_privilege('service_role',p.oid,'EXECUTE')) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='public' and p.proname in ('service_resolve_gmail_outbox_target','record_email_outbox_result'))
     or (n.nspname='crm_private' and p.proname='gmail_deposit_email_obsolete')) as functions`;

export function expectedBodies(sql) {
  return Object.fromEntries(FUNCTIONS.map(name => {
    const match = sql.match(new RegExp(`create or replace function (?:public|crm_private)\\.${name}\\([\\s\\S]*?as (\\$\\$|\\$function\\$)([\\s\\S]*?)\\1;`, 'i'));
    if (!match) throw Error('gmail_migration_source');
    return [name, createHash('md5').update(match[2]).digest('hex')];
  }));
}

export function assertState(project, row, versions, bodies, phase, previous, now = Date.now()) {
  if (!['before', 'after'].includes(phase) || project?.id !== PROJECT
    || project?.name !== 'vishar-crm-production' || project?.region !== 'eu-west-2'
    || project?.status !== 'ACTIVE_HEALTHY') throw Error('gmail_migration_target');
  if (versions.at(-1) !== '0115' || new Set(versions).size !== versions.length) throw Error('gmail_migration_source');
  const expected = phase === 'before' ? versions.slice(0, -1) : versions;
  if (JSON.stringify(row?.versions) !== JSON.stringify(expected)) throw Error('gmail_migration_ledger');
  const age = now - Date.parse(row.heartbeat);
  if (row.leases !== 0 || row.failed !== 0 || row.overdue !== 0
    || !Number.isFinite(age) || age < 0 || age > 900000 || !/^[a-f0-9]{32}$/.test(row.queue_digest)) throw Error('gmail_migration_health');
  if (previous && previous.queue_digest !== row.queue_digest) throw Error('gmail_migration_queue_changed');
  if (phase === 'before' && row.functions?.some(f => f.name !== 'record_email_outbox_result')) throw Error('gmail_migration_already_applied');
  if (phase === 'after') {
    if (!previous || row.functions?.length !== FUNCTIONS.length) throw Error('gmail_migration_readback');
    for (const name of FUNCTIONS) {
      const f = row.functions.find(f => f.name === name);
      if (!f || f.body_md5 !== bodies[name] || f.anon !== false || f.authenticated !== false
        || f.service !== (name !== 'gmail_deposit_email_obsolete')) throw Error('gmail_migration_readback');
    }
  }
  return { project: PROJECT, phase, migration: expected.at(-1), queue_digest: row.queue_digest,
    leases: Number(row.leases), functions_verified: phase === 'after' };
}

export async function verify(env, phase, previous, fetchImpl = fetch) {
  if (!env.SUPABASE_ACCESS_TOKEN || env.PROJECT_REF !== PROJECT) throw Error('gmail_migration_config');
  const root = `https://api.supabase.com/v1/projects/${PROJECT}`;
  async function request(path, query) {
    const response = await fetchImpl(root + path, {
      method: query ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, ...(query ? { 'content-type': 'application/json' } : {}) },
      ...(query ? { body: JSON.stringify({ query, read_only: true }) } : {}),
    });
    if (!response.ok) throw Error('gmail_migration_read');
    return response.json();
  }
  const project = await request('');
  const rows = await request('/database/query', STATE_SQL);
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('gmail_migration_read');
  const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
  if (files.at(-1) !== MIGRATION || files.some(f => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f))) throw Error('gmail_migration_source');
  return assertState(project, rows[0], files.map(f => f.slice(0, 4)),
    expectedBodies(readFileSync(`supabase/migrations/${MIGRATION}`, 'utf8')), phase, previous);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const phase = process.argv[2];
    const path = `${process.env.RUNNER_TEMP}/gmail-deposit-migration-before.json`;
    const previous = phase === 'after' ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const state = await verify(process.env, phase, previous);
    writeFileSync(phase === 'before' ? path : `${process.env.RUNNER_TEMP}/gmail-deposit-migration-after.json`, JSON.stringify(state));
    console.log(JSON.stringify(state));
  } catch { console.error('Gmail migration gate failed closed'); process.exitCode = 1; }
}
