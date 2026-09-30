import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARITY_METADATA } from '../docs/gpt-actions/operator-parity.current.mjs';
import { buildProjections } from './build-gpt-unified-openapi.mjs';
import { configCustomDomains } from './assert-gpt-live-domain-topology.mjs';

const workflow = readFileSync(new URL('../.github/workflows/gpt-production-team-domain-rollout.yml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');

const BRANCH = 'release/private-crm-rc967-inventory-gpt-team-domain';
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

// Twelve -> thirteen only; thirteen is an idempotent no-op; anything else refuses.
assert.match(workflow, /const isTwelve = JSON\.stringify\(hosts\) === JSON\.stringify\(twelve\);/);
assert.match(workflow, /const isThirteen = JSON\.stringify\(hosts\) === JSON\.stringify\(thirteen\);/);
assert.match(workflow, /if \(!isTwelve && !isThirteen\) throw new Error/);
assert.match(workflow, /needs_deploy=\$\{isTwelve \? 'true' : 'false'\}/);
for (const host of unifiedHosts) assert.ok(workflow.includes(host), `${host} must be pinned`);
assert.match(workflow, /TEAM_HOST: gpt-team\.vishartattoo\.com/);
assert.match(workflow, /\[ "\$\(grep -c 'custom_domain = true' wrangler\.gpt-actions\.production\.toml\)" -eq 13 \]/);

// Rollback returns to the exact twelve-domain config, proven before mutation.
assert.match(workflow, /\[ "\$\(grep -c 'custom_domain = true' "\$rollback_config"\)" -eq 12 \]/);
assert.match(workflow, /if grep -Fq "\$TEAM_HOST" "\$rollback_config"; then exit 1; fi/);
assert.match(workflow, /--config "\$rollback_config" --name "\$WORKER_NAME" --dry-run/);
assert.ok(workflow.includes('rollback_config="$RUNNER_TEMP/wrangler.gpt-team-domain-rollback.toml"'),
  'rollback config must stay outside the checkout so the clean-worktree gate can succeed');
assert.ok(!workflow.includes('rollback_config="$GITHUB_WORKSPACE/'),
  'rollback config must not dirty the checked-out canonical tree');
assert.ok(workflow.includes('sed -i "s|^main = \\"workers/|main = \\"$GITHUB_WORKSPACE/workers/|" "$rollback_config"'),
  'the out-of-checkout rollback config must pin the Worker entry point to the checkout');
assert.ok(workflow.indexOf('main = \\"$GITHUB_WORKSPACE/workers/') < workflow.indexOf('--config "$rollback_config" --name "$WORKER_NAME" --dry-run'),
  'the entry point is pinned before the rollback dry-run');
assert.match(workflow, /Roll back to twelve-domain transport if readback fails/);
assert.match(workflow, /Reassert twelve-domain transport if deploy command fails/);
assert.doesNotMatch(workflow, /! grep -Fq/, 'a negated grep never fails under set -e');

// Readback reaches every new host and proves OAuth is still required.
assert.match(workflow, /for host in \$UNIFIED_HOSTS; do\n\s+probe 200 "https:\/\/\$host\/privacy"/);
// New hosts resolve seconds after the deploy: probes bypass the runner's
// negative DNS cache and retry only a missing response, never a wrong status.
assert.ok(workflow.includes('--doh-url https://cloudflare-dns.com/dns-query "$url"'), 'probes resolve through DoH');
assert.ok(workflow.includes(`[ "$actual" = '000' ] && [ "$(date +%s)" -lt "$probe_deadline" ] || break`),
  'only a missing response is retried, and only until one shared deadline');
const deadline = Number(workflow.match(/probe_deadline=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)/)?.[1]);
const jobTimeout = Number(workflow.match(/timeout-minutes: (\d+)/)?.[1]);
assert.ok(deadline > 0 && deadline <= 600 && deadline < jobTimeout * 60 / 3, 'probe deadline leaves room for rollback');
// The deadline is also capped by the job's own start, so slow earlier steps
// cannot push the probes into the job timeout, which would skip the rollback.
assert.ok(workflow.includes('echo "JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"'), 'job start is recorded in the first step');
assert.ok(workflow.indexOf('JOB_STARTED_AT=$(date +%s)') < workflow.indexOf('Checkout exact approved canonical source'));
const reserve = workflow.match(/job_budget_end=\$\(\( JOB_STARTED_AT \+ (\d+) \* 60 - (\d+) \)\)/);
assert.ok(reserve && Number(reserve[1]) === jobTimeout && Number(reserve[2]) >= 300, 'job budget uses the job timeout and reserves rollback time');
assert.ok(workflow.includes('[ "$probe_deadline" -le "$job_budget_end" ] || probe_deadline="$job_budget_end"'));
assert.ok(workflow.includes('probe 200 "https://$TEAM_HOST/privacy"'));
assert.ok(workflow.includes('probe 401 "https://$TEAM_HOST/v1/team/profiles"'));
for (const path of ['gpt-billing.vishartattoo.com/v1/invoices', 'gpt-workspace.vishartattoo.com/v1/me']) {
  assert.ok(workflow.includes(`probe 401 "https://${path}"`), `readback must prove ${path} requires OAuth`);
}

const configured = configCustomDomains(wrangler);
assert.equal(configured.length, 13);
assert.ok(configured.includes('gpt-team.vishartattoo.com'));

console.log('GPT Team-domain rollout tests passed: exact one-shot admission, twelve-to-thirteen topology, dry-run-proven rollback, DoH probes within the job budget, and no database, secret or OAuth mutation.');
