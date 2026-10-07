import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTodayLineage } from './verify-today-db-release.mjs';
const valid = ' Local | Remote | Time\n 20261006150000 | 20261006150000 | t\n 20261007093649 | | t';
assert.equal(verifyTodayLineage(valid), '20261007093649');
// Captured format from the pinned CLI 2.110.0 in the production runner.
const markdown = ' Local | Remote | Time (UTC)\n `20261006150000` | `20261006150000` | `2026-10-06 15:00:00`\n `20261007093649` | ` ` | `2026-10-07 09:36:49`';
assert.equal(verifyTodayLineage(markdown), '20261007093649');
assert.throws(() => verifyTodayLineage(markdown.replaceAll('20261006150000', '20261006160000')));
assert.throws(() => verifyTodayLineage(markdown+'\n `20261007100000` | ` ` | time'));

for (const invalid of ['', valid.replaceAll('20261006150000','20261006160000'), valid+'\n 20261007094000 | | t', valid+'\n | 20261006140000 | t', valid.replace('20261007093649','20261005093649')]) {
  assert.throws(() => verifyTodayLineage(invalid));
}
const workflow = readFileSync('.github/workflows/deploy-private-production-database.yml','utf8');
for (const guard of ['backend-auth-today-database-only', 'GITHUB_REPOSITORY_OWNER', 'canonical_sha', 'Required exact-head workflow', 'Verify Today production lineage', 'verify-today-db-release.mjs', 'supabase db push --dry-run', 'Remote database is up to date.', 'DB_DEPLOY_ENABLED', 'DEPLOY_PRIVATE_CRM_DATABASE']) {
  assert.ok(workflow.includes(guard === 'DB_DEPLOY_ENABLED' ? 'CRM_PRODUCTION_DB_DEPLOY_ENABLED' : guard), guard);
}
assert.ok(!workflow.includes('--include-all'));
assert.ok(!workflow.includes('wrangler'));
console.log('Today database-only lineage and release boundaries passed');
