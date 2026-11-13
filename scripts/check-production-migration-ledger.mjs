#!/usr/bin/env node
// Fail closed when production Supabase applied migration history differs from
// the canonical, versioned SQL in this exact GitHub release snapshot.
// This checks versions, not equivalence of historical SQL bodies; a manually
// applied migration must be reconciled from the actual database before release.
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIGRATION_FILE = /^([0-9]+)_[a-z0-9_]+\.sql$/;

export function compareProductionMigrationLedger(cliOutput, files) {
  if (typeof cliOutput !== 'string' || !Array.isArray(files)) {
    throw new Error('Migration ledger input missing');
  }
  const rows = cliOutput.replaceAll(String.fromCharCode(96), '').split(/\r?\n/)
    .map(line => /^\s*([0-9]*)\s*\|\s*([0-9]*)\s*\|/.exec(line))
    .filter(Boolean);
  if (!rows.length) throw new Error('Supabase CLI returned no migration rows; blocking production release');

  const localFiles = files.filter(name => name.endsWith('.sql'));
  const versions = localFiles.map(name => {
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new Error('Invalid local migration filename: ' + name);
    return match[1];
  });
  const local = [...versions].sort();
  const remote = rows.map(row => row[2]).filter(Boolean);

  if (!remote.length || !local.length) throw new Error('Empty production or source migration history');
  const uniqueLocal = new Set(local);
  const uniqueRemote = new Set(remote);
  if (uniqueLocal.size !== local.length) throw new Error('Duplicate local migration versions; release blocked');
  if (uniqueRemote.size !== remote.length) throw new Error('Duplicate production migration versions; release blocked');
  if (remote.some((value, index) => index && value <= remote[index - 1])) {
    throw new Error('Production migration history is not strictly ordered; release blocked');
  }

  const sourceVersions = new Set(local);
  const missing = remote.filter(version => !sourceVersions.has(version));
  if (missing.length) {
    throw new Error(
      'Production has migrations missing from the repository: ' + missing.join(', ')
      + '. Recover exact applied SQL and commit under the existing versions; do not re-run them.'
    );
  }

  // Applied migrations must be the exact ordered prefix of the local ledger.
  // Otherwise a migration was inserted or renamed before the live production
  // head. Supabase db push must never use --include-all to work around this.
  const misplaced = remote.find((version, index) => local[index] !== version);
  if (misplaced) {
    throw new Error(
      'Migration lineage conflict before production head ' + remote.at(-1)
      + ': expected source ' + local[remote.indexOf(misplaced)]
      + ', production has ' + misplaced
      + '. Reconcile source and production history without replaying SQL.'
    );
  }
  const pending = local.slice(remote.length);
  if (pending.some(version => version <= remote.at(-1))) {
    throw new Error('Out-of-order pending production migration; release blocked');
  }
  return { productionApplied: remote.length, sourceTotal: local.length, pending };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ledgerFile = process.argv[2];
    if (!ledgerFile) throw new Error('Usage: node scripts/check-production-migration-ledger.mjs <supabase-migration-list-file>');
    const result = compareProductionMigrationLedger(
      readFileSync(ledgerFile, 'utf8'),
      readdirSync('supabase/migrations')
    );
    console.log('Production migration ledger aligned: '
      + result.productionApplied + ' applied, '
      + result.pending.length + ' pending: '
      + (result.pending.join(', ') || 'none'));
  } catch (error) {
    console.error('::error::' + (error?.message || String(error)));
    process.exitCode = 1;
  }
}
