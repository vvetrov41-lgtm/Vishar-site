import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARITY_METADATA } from '../docs/gpt-actions/operator-parity.current.mjs';
import { buildProjections } from './build-gpt-unified-openapi.mjs';
import { readdirSync } from 'node:fs';
import {
  assertSameTopology, configCustomDomains, liveCustomDomains,
} from './assert-gpt-live-domain-topology.mjs';

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
assert.ok(workflow.includes('rollback_config="$RUNNER_TEMP/wrangler.gpt-unified-domain-rollback.toml"'),
  'rollback config must stay outside the checkout so the clean-worktree gate can succeed');
assert.ok(!workflow.includes('rollback_config="$GITHUB_WORKSPACE/'),
  'rollback config must not dirty the checked-out canonical tree');
assert.ok(workflow.includes('sed -i "s|^main = \\"workers/|main = \\"$GITHUB_WORKSPACE/workers/|" "$rollback_config"'),
  'the out-of-checkout rollback config must pin the Worker entry point to the checkout');
assert.ok(workflow.indexOf('main = \\"$GITHUB_WORKSPACE/workers/') < workflow.indexOf('--config "$rollback_config" --name "$WORKER_NAME" --dry-run'),
  'the entry point is pinned before the rollback dry-run');
assert.match(workflow, /Roll back to four-domain transport if readback fails/);
assert.match(workflow, /Reassert four-domain transport if deploy command fails/);
assert.doesNotMatch(workflow, /! grep -Fq/, 'a negated grep never fails under set -e');

// Readback reaches every new host and proves OAuth is still required.
assert.match(workflow, /for host in \$UNIFIED_HOSTS; do\n\s+probe 200 "https:\/\/\$host\/privacy"/);
for (const path of ['gpt-billing.vishartattoo.com/v1/invoices', 'gpt-workspace.vishartattoo.com/v1/me']) {
  assert.ok(workflow.includes(`probe 401 "https://${path}"`), `readback must prove ${path} requires OAuth`);
}

// No other deployer of the shared GPT config can change the domain topology.
// Each one either pins an exact domain count for its own one-shot transition,
// is this rollout, or runs the live-topology guard before its first mutation.
const configured = configCustomDomains(wrangler);
assert.equal(configured.length, 12);
assert.doesNotThrow(() => assertSameTopology(configured, [...configured]));
assert.throws(() => assertSameTopology(configured, configured.slice(0, 4)), /Would add: .*gpt-projects/);
assert.throws(() => assertSameTopology(configured.slice(0, 4), configured), /Would drop: .*gpt-projects/);
assert.throws(() => assertSameTopology([], []), /no custom domains/);
{
  const seen = [];
  const live = await liveCustomDomains({
    accountId: 'acct', apiToken: 'token', workerName: 'vishar-gpt-actions-production',
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization });
      return new Response(JSON.stringify({ success: true, result: [
        { hostname: 'gpt-actions.vishartattoo.com', service: 'vishar-gpt-actions-production' },
        { hostname: 'gmail.vishartattoo.com', service: 'vishar-gmail-production' },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual(live, ['gpt-actions.vishartattoo.com'], 'only the GPT Worker domains are compared');
  assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/workers/domains?service=vishar-gpt-actions-production');
  assert.equal(seen[0].auth, 'Bearer token');
  await assert.rejects(
    liveCustomDomains({ accountId: 'a', apiToken: 't', workerName: 'w', fetchImpl: async () => new Response('{}', { status: 403 }) }),
    /refusing to deploy/,
  );
}
const workflowDir = new URL('../.github/workflows/', import.meta.url);
const pinnedTransitions = new Map([
  ['gpt-production-communications-domain-rollout.yml', 3],
  ['gpt-production-cloudflare-domain-rollout.yml', 4],
  ['gpt-production-worker-rollout.yml', 12],
  ['gpt-production-unified-domain-rollout.yml', 12],
]);
for (const name of readdirSync(workflowDir).filter((file) => file.endsWith('.yml'))) {
  const text = readFileSync(new URL(name, workflowDir), 'utf8');
  const lines = text.split('\n');
  const deploys = lines.findIndex((line) => /wrangler deploy --config wrangler\.gpt-actions\.production\.toml/.test(line) && !/--dry-run/.test(line));
  if (deploys === -1) continue;
  if (pinnedTransitions.has(name)) {
    const count = pinnedTransitions.get(name);
    assert.ok(text.includes(`[ "$(grep -c 'custom_domain = true' wrangler.gpt-actions.production.toml)" -eq ${count} ]`),
      `${name} must pin its exact ${count}-domain config`);
    continue;
  }
  const firstMutation = lines.findIndex((line) => (/wrangler deploy/.test(line) && !/--dry-run/.test(line)) || /wrangler secret put/.test(line));
  const guardLine = lines.findIndex((line) => line.includes('node scripts/assert-gpt-live-domain-topology.mjs'));
  assert.ok(guardLine !== -1 && guardLine < firstMutation,
    `${name} deploys the GPT config and must run the live-topology guard before its first mutation`);
}

console.log('GPT unified-domain rollout tests passed: exact one-shot admission, four-to-twelve topology, dry-run-proven rollback, no database, secret or OAuth mutation, and no other deployer can change the topology.');
