#!/usr/bin/env node
// C-2 (Vishar CRM technical audit, 2026-09-22).
//
// Production schema changes have exactly one path: the private production
// release (full validation, remote dry-run, apply, post-apply dry-run) and its
// validation-first database-only twin. Any other workflow that can run a
// mutating `supabase db push` against production, or any `--include-all` push,
// reintroduces the out-of-order lineage that broke the canonical release.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW_DIR = '.github/workflows';
const ALLOWED = new Set([
  'private-production-release.yml',
  'deploy-private-production-database.yml',
]);
const PRODUCTION_MARKERS = [/CRM_PRODUCTION_SUPABASE/, /vfjexhfdbrjmuxfdvbdx/];

const errors = [];
for (const name of readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file)).sort()) {
  const source = readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
  if (/supabase\s+db\s+push[^\n]*--include-all/.test(source)) {
    errors.push(`${name}: supabase db push --include-all is forbidden; fix the migration version instead`);
  }
  const targetsProduction = PRODUCTION_MARKERS.some((marker) => marker.test(source));
  const mutatingPush = source
    .split('\n')
    .some((line) => /supabase\s+db\s+push\b/.test(line) && !/--dry-run/.test(line));
  if (targetsProduction && mutatingPush && !ALLOWED.has(name)) {
    errors.push(`${name}: only ${[...ALLOWED].join(' or ')} may apply production migrations`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`Production database release paths OK: only ${[...ALLOWED].join(', ')} may apply migrations.`);
