#!/usr/bin/env node
// Exact-head release staging: never modify committed migration history.
// Only one explicitly reviewed later migration may be deferred, on the runner.
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deferredTodayMigration } from './verify-today-db-release.mjs';

// Every file that may ever be deferred, each tied to one exact ledger state
// in deferredTodayMigration().
const DEFERRABLE = [
  '20261113120000_whatsapp_reminder_24h_clean_v5.sql',
  '20261116170000_healing_check_whatsapp_candidate.sql',
  '20261127200100_lead_magnet_reporting.sql',
];
const mode = process.argv[2];
const targetDir = resolve(mode === '--stage' ? process.argv[4] ?? '' : process.argv[3] ?? '');
if (mode !== '--stage' && mode !== '--restore') throw new Error('Expected --stage or --restore');
if (!targetDir || targetDir === resolve('.')) throw new Error('Staging directory missing');

const sourceOf = (file) => 'supabase/migrations/' + file;
const committedBytes = (file) => execFileSync('git',['show','HEAD:'+sourceOf(file)],{maxBuffer:8*1024*1024});
function assertCanonicalBytes(path, file) {
  const actual=readFileSync(path);
  if (!actual.equals(committedBytes(file))) throw new Error('Migration source differs from immutable HEAD');
}

if (mode === '--stage') {
  const migrationList=process.argv[3];
  if (!migrationList) throw new Error('Migration ledger input missing');
  const toDefer=deferredTodayMigration(readFileSync(migrationList,'utf8'));
  if (toDefer === null) {
    console.log('Already a strictly permitted single migration; no staging');
  } else {
    const source=sourceOf(toDefer), destination=join(targetDir,toDefer);
    if (!DEFERRABLE.includes(toDefer) || !existsSync(source) || existsSync(destination))
      throw new Error('Unexpected migration staging state');
    assertCanonicalBytes(source,toDefer);
    mkdirSync(targetDir,{recursive:true});
    renameSync(source,destination);
    assertCanonicalBytes(destination,toDefer);
    console.log('Deferred exactly one reviewed later migration on this runner: '+toDefer);
  }
} else {
  for (const file of DEFERRABLE) {
    const source=sourceOf(file), destination=join(targetDir,file);
    if (existsSync(destination)) {
      if (existsSync(source)) throw new Error('Cannot overwrite source during restore');
      assertCanonicalBytes(destination,file);
      renameSync(destination,source);
    }
    // Some listed future migrations do not exist on older release snapshots.
    // For the new lead-magnet file, require restoration only if it is in HEAD.
    if (file === '20261127200100_lead_magnet_reporting.sql' && !existsSync(source)) {
      try { committedBytes(file); } catch { continue; }
    }
    if (!existsSync(source)) throw new Error('Canonical migration missing after restore');
    assertCanonicalBytes(source,file);
  }
  console.log('Source restored and matches immutable Git HEAD');
}
