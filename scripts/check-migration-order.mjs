#!/usr/bin/env node
// C-2 (Vishar CRM technical audit, 2026-09-22).
//
// `supabase db push` refuses a local migration whose version sorts before the
// newest version already applied remotely. When that happened on 2026-09-21 the
// canonical private production release failed and the pending migrations were
// applied through one-off `--include-all` workflows instead.
//
// This check moves that failure to the pull request: every migration added
// relative to the base ref must have a version strictly greater than every
// migration version the base ref already contains, and versions must be unique.
//
// Usage: node scripts/check-migration-order.mjs [base-ref]
//        node scripts/check-migration-order.mjs --self-test

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const MIGRATIONS_DIR = 'supabase/migrations';

// Migrations production already applied from the rc1012 release ledger
// (2026-10-03) that the canonical branch never carried. Adding them records
// history the remote database already has, so supabase db push has nothing
// out of order to refuse; without them every push from the canonical branch
// fails with "Remote migration versions not found in local migrations
// directory". Exact versions only; nothing else may be added out of order.
export const APPLIED_LEDGER_VERSIONS = Object.freeze(new Set([
  '20261003072107',
  '20261003072301',
  '20261003072600',
]));
// One audited production ledger reconciliation. Supabase's migration API applied
// the exact SQL blob under its generated timestamp after a full release was
// blocked before mutation by an unrelated Telegram binding guard. The source
// migration's old filename was never applied. No general rename exception.
export const TOUCH_MIGRATION_RECONCILIATION = Object.freeze({
  from: '20261013130000_booking_touch_attribution.sql',
  to: '20261013122728_booking_touch_attribution.sql',
  exactBlob: '7203b797ba2b0f1429471e7f74cad8a0161cd186',
});
const FILE_RE = /^([0-9]+)_[a-z0-9_]+\.sql$/;

function reconcilesTouchMigration(baseFiles, headFiles) {
  const { from, to } = TOUCH_MIGRATION_RECONCILIATION;
  return baseFiles.includes(from) && !headFiles.includes(from) && headFiles.includes(to);
}

// Fail closed on any content change: this is a filename correction only.
function verifyReconciliationBlob(baseRef) {
  const { from, to, exactBlob } = TOUCH_MIGRATION_RECONCILIATION;
  const oldBlob = execFileSync('git', ['rev-parse', `${baseRef}:${MIGRATIONS_DIR}/${from}`], { encoding: 'utf8' }).trim();
  const newBlob = execFileSync('git', ['rev-parse', `HEAD:${MIGRATIONS_DIR}/${to}`], { encoding: 'utf8' }).trim();
  if (oldBlob !== exactBlob || newBlob !== exactBlob) throw new Error('Touch migration ledger correction must preserve exact audited SQL blob');
}

export function versionOf(fileName) {
  const match = FILE_RE.exec(fileName);
  if (!match) throw new Error(`migration file name is not <version>_<name>.sql: ${fileName}`);
  return BigInt(match[1]);
}

export function checkOrder(baseFiles, headFiles) {
  const errors = [];
  const seen = new Map();
  for (const file of headFiles) {
    const version = versionOf(file).toString();
    if (seen.has(version)) errors.push(`duplicate migration version ${version}: ${seen.get(version)} and ${file}`);
    seen.set(version, file);
  }

  const base = new Set(baseFiles);
  const baseMax = baseFiles.reduce((max, file) => {
    const version = versionOf(file);
    return version > max ? version : max;
  }, -1n);

  const touchReconciled = reconcilesTouchMigration(baseFiles, headFiles);
  const removed = baseFiles.filter((file) => !headFiles.includes(file) && !(touchReconciled && file === TOUCH_MIGRATION_RECONCILIATION.from));
  for (const file of removed) errors.push(`migration already on the base branch was removed or renamed: ${file}`);

  for (const file of headFiles) {
    if (base.has(file)) continue;
    const version = versionOf(file);
    if (APPLIED_LEDGER_VERSIONS.has(version.toString())) continue;
    if (touchReconciled && file === TOUCH_MIGRATION_RECONCILIATION.to) continue;
    if (version <= baseMax) {
      errors.push(
        `new migration ${file} has version ${version}, which is not greater than the newest base migration ${baseMax}; `
        + 'rename it with a newer timestamp so supabase db push can apply it in order',
      );
    }
  }
  return errors;
}

function listAt(ref) {
  const output = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${MIGRATIONS_DIR}`], { encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.sql'));
}

function selfTest() {
  assert.deepEqual(checkOrder(['0001_a.sql'], ['0001_a.sql', '20260101000000_b.sql']), []);
  assert.equal(checkOrder(['20260920185324_a.sql'], ['20260920185324_a.sql', '20260920185000_b.sql']).length, 1);
  assert.equal(checkOrder(['0001_a.sql'], ['0001_a.sql', '0001_b.sql']).length, 2);
  assert.equal(checkOrder(['0001_a.sql', '0002_b.sql'], ['0001_a.sql', '0003_b.sql']).length, 1);
  assert.throws(() => versionOf('bad.sql'));
  const { from, to } = TOUCH_MIGRATION_RECONCILIATION;
  assert.deepEqual(checkOrder([from], [to]), [], 'one audited ledger rename');
  assert.equal(checkOrder([from], ['20261013122729_booking_touch_attribution.sql']).length, 2, 'unknown rename rejected');
  assert.equal(checkOrder(['20261013130000_another.sql'], [to]).length, 2, 'exception cannot authorize other migrations');
  assert.equal(checkOrder([from, '20261013130001_other.sql'], [to]).length, 2, 'exception cannot remove unrelated migration');
  // An already-applied ledger version may join the base; no other old version may.
  assert.deepEqual(checkOrder(['20261004090000_a.sql'], ['20261004090000_a.sql', '20261003072107_guard.sql']), []);
  assert.equal(checkOrder(['20261004090000_a.sql'], ['20261004090000_a.sql', '20261003072108_other.sql']).length, 1);
  console.log('Migration order guard self-test passed.');
}

if (process.argv[2] === '--self-test') {
  selfTest();
} else {
  const baseRef = process.argv[2] || process.env.MIGRATION_BASE_REF || 'origin/agent/platform-telegram-self-service';
  const baseFiles = listAt(baseRef);
  const headFiles = listAt('HEAD');
  const errors = checkOrder(baseFiles, headFiles);
  if (reconcilesTouchMigration(baseFiles, headFiles)) {
    try { verifyReconciliationBlob(baseRef); } catch (error) { errors.push(String(error.message || error)); }
  }
  if (errors.length) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`Migration order OK: ${headFiles.length} migrations, ${headFiles.length - baseFiles.length} new relative to ${baseRef}.`);
}
