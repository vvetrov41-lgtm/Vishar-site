// The private CRM app is TypeScript and is built separately, so the Worker test
// suite reads its Monzo alias list from the source file instead of importing
// it. Any drift between the two surfaces fails the registry test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../admin/src/lib/monzo-connector.ts', import.meta.url)),
  'utf8',
);

const match = source.match(/export const MONZO_CONNECTOR_ALIASES = \[([^\]]*)\] as const;/);
if (!match) {
  throw new Error('MONZO_CONNECTOR_ALIASES was not found in admin/src/lib/monzo-connector.ts');
}

export const MONZO_CONNECTOR_ALIASES = Object.freeze(
  match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean),
);
