import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARITY_METADATA } from '../docs/gpt-actions/operator-parity.current.mjs';
import { buildProjections } from './build-gpt-unified-openapi.mjs';

const workflow = readFileSync(new URL('../.github/workflows/gpt-production-unified-domain-rollout.yml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');

const BRANCH = 'release/private-crm-rc960-inventory-gpt-unified-domains';
const unifiedHosts = [
  'gpt-projects.vishartattoo.com', 'gpt-scheduling.vishartattoo.com', 'gpt-finance.vishartattoo.com',
  'gpt-billing.vishartattoo.com', 'gpt-notifications.vishartattoo.com', 'gpt-automations.vishartattoo.com',
  'gpt-integrations.vishartattoo.com', 'gpt-workspace.vishartattoo.com',
];

// Every imported unified schema has its host routed to the one GPT Worker, and
// no host is routed without a schema to import.
const routedHosts = [...wrangler.matchAll(/pattern = "([a-z-]+\.vishartattoo\.com)", custom_domain = true/g)].map((m) => m[1]).sort();
const schemaHosts = buildProjections().filter((p) => p.operationIds.length > 0).map((p) => p.host).sort();
assert.deepEqual(routedHosts, schemaHosts, 'routed GPT hosts must equal the hosts of non-empty unified schemas');
for (const host of unifiedHosts) assert.ok(Object.values(PARITY_METADATA.actionDomains).includes(host));

// One-shot admission: exact branch, owner push, production environment, and
// the same canonical-head + exact-head CI gate as every GPT edge rollout.
assert.match(workflow, new RegExp(`branches:\\n\\s+- ${BRANCH.replace(/[.*]/g, '\\$&')}\\n`));
assert.match(workflow, new RegExp(`\\[ "\\$GITHUB_REF_NAME" = '${BRANCH}' \\]`));
assert.match(workflow, /if: github\.actor == github\.repository_owner/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /CANONICAL_BRANCH: agent\/platform-telegram-self-service/);
assert.match(workflow, /\[ "\$\(git rev-parse "\$GITHUB_SHA\^"\)" = "\$APPROVED_SHA" \]/);
assert.match(workflow, /\[ "\$\(git rev-parse "\$GITHUB_SHA\^\{tree\}"\)" = "\$\(git rev-parse "\$APPROVED_SHA\^\{tree\}"\)" \]/);
for (const required of ['Static Validation', 'CRM and booking validation']) {
  assert.ok(workflow.includes(`'${required}'`), `missing exact-head gate ${required}`);
}
assert.ok(BRANCH.includes('-inventory-'), 'the ref stays under the inventory exclusion of the broad release');
assert.match(release, /'!release\/private-crm-rc\*-inventory-\*'/);

// Database is read, never written; secrets, OAuth clients and ceilings are untouched.
assert.match(workflow, /supabase db push --dry-run/);
assert.doesNotMatch(workflow, /supabase db push\s*(?:\n|$)/);
assert.doesNotMatch(workflow, /wrangler secret|configure_gpt_|gpt_action_clients/i);

// Four -> twelve only; twelve is an idempotent no-op; anything else refuses.
assert.match(workflow, /const isFour = JSON\.stringify\(hosts\) === JSON\.stringify\(four\);/);
assert.match(workflow, /const isTwelve = JSON\.stringify\(hosts\) === JSON\.stringify\(twelve\);/);
assert.match(workflow, /if \(!isFour && !isTwelve\) throw new Error/);
assert.match(workflow, /needs_deploy=\$\{isFour \? 'true' : 'false'\}/);
for (const host of unifiedHosts) assert.ok(workflow.includes(host), `${host} must be pinned`);
assert.match(workflow, /\[ "\$\(grep -c 'custom_domain = true' wrangler\.gpt-actions\.production\.toml\)" -eq 12 \]/);

// Rollback returns to the exact four-domain config, proven before mutation.
assert.match(workflow, /\[ "\$\(grep -c 'custom_domain = true' "\$rollback_config"\)" -eq 4 \]/);
assert.match(workflow, /for host in \$UNIFIED_HOSTS; do if grep -Fq "\$host" "\$rollback_config"; then exit 1; fi; done/);
assert.match(workflow, /--config "\$rollback_config" --name "\$WORKER_NAME" --dry-run/);
assert.match(workflow, /Roll back to four-domain transport if readback fails/);
assert.match(workflow, /Reassert four-domain transport if deploy command fails/);
assert.doesNotMatch(workflow, /! grep -Fq/, 'a negated grep never fails under set -e');

// Readback reaches every new host and proves OAuth is still required.
assert.match(workflow, /for host in \$UNIFIED_HOSTS; do\n\s+probe 200 "https:\/\/\$host\/privacy"/);
for (const path of ['gpt-billing.vishartattoo.com/v1/invoices', 'gpt-workspace.vishartattoo.com/v1/me']) {
  assert.ok(workflow.includes(`probe 401 "https://${path}"`), `readback must prove ${path} requires OAuth`);
}

console.log('GPT unified-domain rollout tests passed: exact one-shot admission, four-to-twelve topology, dry-run-proven rollback, no database, secret or OAuth mutation.');
