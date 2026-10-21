import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A deliberately single-migration automatic path; other releases use dispatch.
export function verifyTodayLineage(source) {
  const rows = source.replaceAll('`', '').split('\n').map((line) => line.match(/^\s*(\d*)\s*\|\s*(\d*)\s*\|/)).filter(Boolean);
  if (!rows.length) throw new Error('No migration state; refusing production mutation');
  const local = rows.map((r) => r[1]).filter(Boolean);
  const remote = rows.map((r) => r[2]).filter(Boolean);
  const approvedTransitions = new Map([
    ['20261010080000', '20261010170000'],
    // Reliability PR #1118: only the attention report body changes.
    ['20261020090000', '20261021074511'],
  ]);
  const expectedPending = approvedTransitions.get(remote.at(-1));
  if (!expectedPending) throw new Error('Production migration head changed');
  if (remote.some((version) => !local.includes(version))) throw new Error('Production contains unknown migration history');
  const pending = local.filter((version) => !remote.includes(version));
  if (pending.length !== 1 || pending[0] !== expectedPending) throw new Error('Expected exactly the approved ordered single migration');
  if (pending[0] <= remote.at(-1)) throw new Error('Out-of-order production migration');
  return pending[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Validated production head and sole pending migration: ${verifyTodayLineage(readFileSync(process.argv[2], 'utf8'))}`);
}
