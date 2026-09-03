import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const communications = readFileSync(new URL('../docs/gpt-actions/openapi.production.communications.yaml', import.meta.url), 'utf8');
const rollout = readFileSync(new URL('../.github/workflows/gpt-production-communications-domain-rollout.yml', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const coreIds = operationIds(core);
const operationsIds = operationIds(operations);
const communicationsIds = operationIds(communications);

// Communications-domain topology remains unchanged. The current Operations
// import now also carries the two bounded Web Research reads, so the three
// existing CRM ChatGPT Action sets contain 68 unique operations in total. The
// dedicated Cloudflare Action set adds a fourth transport domain separately.
assert.deepEqual([coreIds.length, operationsIds.length, communicationsIds.length], [28, 21, 19]);
assert.equal(new Set([...coreIds, ...operationsIds, ...communicationsIds]).size, 68);
assert.ok(operationsIds.includes('searchWeb'));
assert.ok(operationsIds.includes('scrapeWebPage'));

for (const host of ['gpt-actions', 'gpt-operations', 'gpt-communications', 'gpt-cloudflare']) {
  assert.match(wrangler, new RegExp(`pattern = "${host}\\.vishartattoo\\.com", custom_domain = true`));
}
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 4);
assert.match(communications, /^\s*- url: https:\/\/gpt-communications\.vishartattoo\.com$/m);
for (const schema of [core, operations, communications]) {
  assert.match(schema, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
  assert.match(schema, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
}

assert.equal(existsSync(new URL('../.github/workflows/gpt-production-domain-reconciliation.yml', import.meta.url)), false,
  'two-domain reconciliation workflow must stay retired');
assert.equal(existsSync(new URL('./reconcile-gpt-production-domains.mjs', import.meta.url)), false,
  'obsolete Communications detach operator must stay retired');
assert.equal(existsSync(new URL('./test-gpt-production-domain-reconciliation.mjs', import.meta.url)), false,
  'obsolete two-domain reconciliation test must stay retired');

assert.match(rollout, /release\/private-crm-rc558-gpt-communications-domain/);
assert.match(rollout, /CANONICAL_BRANCH: agent\/platform-telegram-self-service/);
assert.match(rollout, /environment: crm-production/);
assert.match(rollout, /APPROVED_SHA: \$\{\{ github\.event\.before \}\}/);
assert.match(rollout, /git rev-parse "\$GITHUB_SHA\^"/);
assert.match(rollout, /git rev-parse "\$GITHUB_SHA\^\{tree\}"/);
assert.match(rollout, /git ls-remote origin "refs\/heads\/\$CANONICAL_BRANCH"/);
for (const required of [
  'Static Validation',
  'CRM and booking validation',
  'Gmail production validation',
  'Booking host validation',
  'WhatsApp production onboarding validation',
]) {
  assert.ok(rollout.includes(`'${required}'`), `rollout missing exact-head gate: ${required}`);
}
assert.match(rollout, /supabase db push --dry-run/);
assert.doesNotMatch(rollout, /supabase db push\s*(?:\n|$)/,
  'Communications rollout must never apply production database migrations');
assert.match(rollout, /cloudflare-production-inventory\.mjs/);
assert.match(rollout, /needs_deploy=/);
assert.match(rollout, /Unexpected production GPT domain topology/);
assert.match(rollout, /wrangler deploy --config wrangler\.gpt-actions\.production\.toml/);
assert.match(rollout, /gpt-communications\.vishartattoo\.com/);
assert.match(rollout, /gpt-operations\.vishartattoo\.com/);
assert.match(rollout, /gpt-actions\.vishartattoo\.com/);
assert.match(rollout, /Operations-host Gmail route retained temporarily as Builder migration fallback/);
assert.match(rollout, /Roll back to the two-domain transport if post-mutation readback fails/);
assert.match(rollout, /sed -i '\/gpt-communications\\\.vishartattoo\\\.com\/d'/);
assert.match(rollout, /GPT_ACTIONS_ENABLED:true/);
assert.match(rollout, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.doesNotMatch(rollout, /configure_gpt_action_client|update\s+crm_private\.gpt_action_clients|insert\s+into\s+crm_private\.gpt_action_clients/i,
  'transport rollout must not mutate GPT bindings or capability ceilings');
assert.doesNotMatch(rollout, /gwaliusblwrzisrwnsvs|STAGING_SUPABASE|staging\.vishartattoo/i);

console.log('GPT Communications-domain rollout tests passed: exact three-schema CRM transport plus dedicated Cloudflare domain, canonical-only admission, no DB/binding mutation, fresh Cloudflare readback and rollback boundary.');
