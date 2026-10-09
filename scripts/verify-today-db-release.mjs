import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A deliberately single-migration automatic path; other releases use dispatch.
export function verifyTodayLineage(source) {
  const rows = source.replaceAll('`', '').split('\n').map((line) => line.match(/^\s*(\d*)\s*\|\s*(\d*)\s*\|/)).filter(Boolean);
  if (!rows.length) throw new Error('No migration state; refusing production mutation');
  const local = rows.map((r) => r[1]).filter(Boolean);
  const remote = rows.map((r) => r[2]).filter(Boolean);
  if (remote.at(-1) !== '20261009210000') throw new Error('Production migration head changed');
  if (remote.some((version) => !local.includes(version))) throw new Error('Production contains unknown migration history');
  const pending = local.filter((version) => !remote.includes(version));
  if (pending.length !== 1 || pending[0] !== '20261009220000') throw new Error('Expected exactly the ordered enquiry project summary migration');
  if (pending[0] <= remote.at(-1)) throw new Error('Out-of-order production migration');
  return pending[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Validated production head and sole pending migration: ${verifyTodayLineage(readFileSync(process.argv[2], 'utf8'))}`);
}
