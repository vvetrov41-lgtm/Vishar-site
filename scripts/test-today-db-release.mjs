import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTodayLineage } from './verify-today-db-release.mjs';
const valid = ' Local | Remote | Time\n 20261009200000 | 20261009200000 | t\n 20261009210000 | | t';
assert.equal(verifyTodayLineage(valid), '20261009210000');
// Captured format from the pinned CLI 2.110.0 in the production runner.
const markdown = ' Local | Remote | Time (UTC)\n `20261009200000` | `20261009200000` | `2026-10-09 20:00:00`\n `20261009210000` | ` ` | `2026-10-09 21:00:00`';
assert.equal(verifyTodayLineage(markdown), '20261009210000');
assert.throws(() => verifyTodayLineage(markdown.replaceAll('20261009200000', '20261009184414')));
assert.throws(() => verifyTodayLineage(markdown+'\n `20261009220000` | ` ` | time'));

for (const invalid of ['', valid.replaceAll('20261009200000','20261009184414'), valid+'\n 20261009220000 | | t', valid+'\n | 20261006140000 | t', valid.replace('20261009210000','20261005093649')]) {
  assert.throws(() => verifyTodayLineage(invalid));
}
const workflow = readFileSync('.github/workflows/deploy-private-production-database.yml','utf8');
for (const guard of ['backend-auth-today-database-only', 'GITHUB_REPOSITORY_OWNER', 'canonical_sha', 'Required exact-head workflow', 'Verify Today production lineage', 'verify-today-db-release.mjs', 'supabase db push --dry-run', 'Remote database is up to date.', 'DB_DEPLOY_ENABLED', 'DEPLOY_PRIVATE_CRM_DATABASE']) {
  assert.ok(workflow.includes(guard === 'DB_DEPLOY_ENABLED' ? 'CRM_PRODUCTION_DB_DEPLOY_ENABLED' : guard), guard);
}
assert.ok(!workflow.includes('--include-all'));
assert.ok(!workflow.includes('wrangler'));
console.log('Today database-only lineage and release boundaries passed');

const operator = readFileSync('.github/workflows/crm-host-split-operator.yml','utf8');
assert.ok(operator.includes('VITE_POSTHOG_HOST: eu.i.posthog.com'));
assert.ok(!operator.includes('vars.CRM_PRODUCTION_POSTHOG_HOST'));
