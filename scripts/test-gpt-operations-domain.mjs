import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const rollout = readFileSync(new URL('../.github/workflows/gpt-production-operations-domain-rollout.yml', import.meta.url), 'utf8');

assert.match(wrangler, /pattern = "gpt-actions\.vishartattoo\.com", custom_domain = true/);
assert.match(wrangler, /pattern = "gpt-operations\.vishartattoo\.com", custom_domain = true/);
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 2, 'production GPT worker must expose exactly two custom domains');

assert.match(core, /^\s*- url: https:\/\/gpt-actions\.vishartattoo\.com$/m);
assert.match(operations, /^\s*- url: https:\/\/gpt-operations\.vishartattoo\.com$/m);
assert.doesNotMatch(operations, /^\s*- url: https:\/\/gpt-actions\.vishartattoo\.com$/m);
for (const schema of [core, operations]) {
  assert.match(schema, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
  assert.match(schema, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
}

assert.match(rollout, /release\/private-crm-rc32-gpt-operations-domain/);
assert.match(rollout, /PRODUCT_BRANCH: agent\/gpt-full-crm-management/);
assert.match(rollout, /environment: crm-production/);
assert.match(rollout, /CORE_HOST: gpt-actions\.vishartattoo\.com/);
assert.match(rollout, /OPERATIONS_HOST: gpt-operations\.vishartattoo\.com/);
assert.match(rollout, /npm run test:gpt-production/);
assert.match(rollout, /npm run scan:secrets/);
assert.match(rollout, /wrangler deploy --config wrangler\.gpt-actions\.production\.toml/);
assert.doesNotMatch(rollout, /supabase db push|configure_gpt_full_management|update\s+crm_private\.gpt_action_clients/i,
  'operations-domain rollout must be Worker-only and must not mutate production DB or GPT bindings');
assert.doesNotMatch(rollout, /gwaliusblwrzisrwnsvs|STAGING_SUPABASE|staging\.vishartattoo/i);

console.log('GPT operations-domain tests passed: two distinct production action domains, shared OAuth origin, Worker-only RC32 rollout.');
