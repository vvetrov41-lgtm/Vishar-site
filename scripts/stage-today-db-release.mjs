#!/usr/bin/env node
// Exact-head release staging: never modify committed migration history.
// Only one explicitly reviewed later migration may be deferred, on the runner.
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deferredTodayMigration } from './verify-today-db-release.mjs';

const FILENAME = '20261113120000_whatsapp_reminder_24h_clean_v5.sql';
const SOURCE = 'supabase/migrations/' + FILENAME;
const mode = process.argv[2];
const targetDir = resolve(mode === '--stage' ? process.argv[4] ?? '' : process.argv[3] ?? '');
if (mode !== '--stage' && mode !== '--restore') throw new Error('Expected --stage or --restore');
if (!targetDir || targetDir === resolve('.')) throw new Error('Staging directory missing');
const destination = join(targetDir,FILENAME);

const committedBytes = () => execFileSync('git',['show','HEAD:'+SOURCE],{maxBuffer:8*1024*1024});
function assertCanonicalBytes(path) {
  const actual=readFileSync(path);
  if (!actual.equals(committedBytes())) throw new Error('Migration source differs from immutable HEAD');
}

if (mode === '--stage') {
  const migrationList=process.argv[3];
  if (!migrationList) throw new Error('Migration ledger input missing');
  const toDefer=deferredTodayMigration(readFileSync(migrationList,'utf8'));
  if (toDefer === null) {
    if (!existsSync(SOURCE)) throw new Error('Expected committed migration file is missing');
    assertCanonicalBytes(SOURCE);
    console.log('Already a strictly permitted single migration; no staging');
  } else {
    if (toDefer !== FILENAME || !existsSync(SOURCE) || existsSync(destination))
      throw new Error('Unexpected migration staging state');
    assertCanonicalBytes(SOURCE);
    mkdirSync(targetDir,{recursive:true});
    renameSync(SOURCE,destination);
    assertCanonicalBytes(destination);
    console.log('Deferred exactly one reviewed later migration on this runner');
  }
} else {
  if (existsSync(destination)) {
    if (existsSync(SOURCE)) throw new Error('Cannot overwrite source during restore');
    assertCanonicalBytes(destination);
    renameSync(destination,SOURCE);
  }
  if (!existsSync(SOURCE)) throw new Error('Canonical migration missing after restore');
  assertCanonicalBytes(SOURCE);
  console.log('Source restored and matches immutable Git HEAD');
}
