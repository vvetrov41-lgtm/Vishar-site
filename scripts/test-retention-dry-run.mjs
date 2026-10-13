// Retention phase 1 Worker hook: one RPC, fail-open, never affects the drain.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRetentionDryRun } from '../workers/lib/crm-agent.js';
import { RETENTION_RPCS } from '../workers/lib/supabase.js';

const env = { CRM_AGENT_ENABLED: 'true' };
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
try {
  const calls = [];
  const rpc = (result) => ({ rpc: async (name, args) => { calls.push([name, args]); return result; } });

  assert.equal(await runRetentionDryRun(env, { supabase: rpc({ status: 'recorded', candidates: 0, candidate_files: 0 }) }), 'recorded');
  assert.deepEqual(calls, [['service_run_retention_dry_run', {}]]);
  assert.equal(await runRetentionDryRun(env, { supabase: rpc({ status: 'throttled' }) }), 'throttled');
  assert.equal(await runRetentionDryRun(env, { supabase: rpc({ status: 'deleted' }) }), 'rejected');
  assert.equal(await runRetentionDryRun(env, { supabase: { rpc: async () => { throw new Error('down'); } } }), 'failed');
  assert.equal(await runRetentionDryRun({ CRM_AGENT_ENABLED: 'false' }, { supabase: rpc({}) }), 'disabled');
} finally {
  Object.assign(console, quiet);
}

assert.deepEqual([...RETENTION_RPCS], ['service_run_retention_dry_run'], 'the retention surface is one dry-run RPC');
const entry = readFileSync(new URL('../workers/tattooai-entry.js', import.meta.url), 'utf8');
assert.match(entry, /await runRetentionDryRun\(env\);/, 'the CRM agent drain asks for the daily dry run');
const migration = readFileSync(new URL('../supabase/migrations/20261013150000_retention_dry_run.sql', import.meta.url), 'utf8');
assert.ok(!/\bdelete\s+from\s+public\.(enquiries|clients|enquiry_files)/i.test(migration), 'phase 1 never deletes enquiries, clients or files');
assert.ok(!/storage\.objects/i.test(migration), 'phase 1 never touches Storage');
console.log('Retention dry-run hook passed');
