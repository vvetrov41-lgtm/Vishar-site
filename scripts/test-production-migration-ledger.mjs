import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareProductionMigrationLedger } from './check-production-migration-ledger.mjs';

const files = ['0001_extensions.sql', '0002_profiles.sql', '20261113010000_latest.sql', '20261113020000_new.sql'];
const history = [
  ' Local | Remote | Time (UTC)',
  ' 0001 | 0001 | t',
  ' 0002 | 0002 | t',
  ' 20261113010000 | 20261113010000 | t',
  ' 20261113020000 | | t',
].join('\n');

assert.deepEqual(compareProductionMigrationLedger(history, files), {
  productionApplied: 3, sourceTotal: 4, pending: ['20261113020000'],
});
assert.deepEqual(compareProductionMigrationLedger(history.replace(' 20261113020000 | | t',' 20261113020000 | 20261113020000 | t'), files).pending, []);
assert.equal(compareProductionMigrationLedger(history.replaceAll('0001', '\u00600001\u0060'), files).productionApplied, 3);

for (const [label, ledger, names] of [
  ['remote-only', history + '\n | 20261114030000 | t', files],
  ['missing local migration', history, files.filter(name => !name.startsWith('0002'))],
  ['inserted earlier local version', history, [...files, '0003_unapplied.sql']],
  ['duplicate source version', history, [...files, '0002_duplicate.sql']],
  ['duplicate remote version', history + '\n | 20261113010000 | t', files],
  ['unsorted remote', history.replace(' 0001 | 0001 | t', ' 0001 | 20261113010000 | t'), files],
  ['empty ledger', '', files],
  ['invalid filename', history, [...files, 'unversioned.sql']],
]) {
  assert.throws(() => compareProductionMigrationLedger(ledger, names), Error, label);
}

for (const filename of [
  '.github/workflows/deploy-private-production-database.yml',
  '.github/workflows/private-production-release.yml',
]) {
  const yaml = readFileSync(filename, 'utf8');
  const guard = yaml.indexOf('node scripts/check-production-migration-ledger.mjs');
  const dryRun = yaml.indexOf('supabase db push --dry-run');
  const deploy = yaml.indexOf('supabase db push\n');
  assert(guard >= 0 && dryRun > guard && deploy > guard, filename + ' must guard production writes');
}
console.log('Production migration ledger fail-closed tests passed.');
