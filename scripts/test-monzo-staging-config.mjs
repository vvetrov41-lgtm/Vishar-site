import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMonzoStagingConfig } from './validate-monzo-staging.mjs';

const canonical = readFileSync(new URL('../wrangler.monzo-api.staging.toml', import.meta.url), 'utf8');

const validated = validateMonzoStagingConfig(canonical);
assert.equal(validated.ok, true);
assert.equal(validated.deployReady, false);
assert.equal(validated.worker, 'vishar-monzo-api-staging');
assert.equal(validated.reconciliationEnabled, false);
assert.deepEqual(validated.rateLimit, { limit: 60, period: 60, namespace: '1101' });

const mutations = [
  [
    'route exposure',
    `${canonical}\nroutes = [{ pattern = "monzo-staging.vishartattoo.com", custom_domain = true }]\n`,
    /must not declare a route/,
  ],
  [
    'committed KV id',
    `${canonical}\n[[kv_namespaces]]\nbinding = "MONZO_OAUTH_STATE"\nid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n`,
    /must not contain KV namespace ids/,
  ],
  [
    'enabled reconciliation',
    canonical.replace('MONZO_RECONCILIATION_ENABLED = "false"', 'MONZO_RECONCILIATION_ENABLED = "true"'),
    /must contain exactly one: MONZO_RECONCILIATION_ENABLED = "false"/,
  ],
  [
    'direct Worker entrypoint',
    canonical.replace('main = "workers/monzo-api-gateway.js"', 'main = "workers/monzo-api.js"'),
    /must contain exactly one: main = "workers\/monzo-api-gateway.js"/,
  ],
  [
    'wrong webhook host',
    canonical.replace('MONZO_WEBHOOK_BASE_URL = "https://monzo-staging.vishartattoo.com"', 'MONZO_WEBHOOK_BASE_URL = "https://example.test"'),
    /must contain exactly one: MONZO_WEBHOOK_BASE_URL/,
  ],
  [
    'committed Access audience',
    `${canonical}\nMONZO_ACCESS_AUD = "${'d'.repeat(64)}"\n`,
    /must not be committed/,
  ],
  [
    'removed rate limiter',
    canonical.replace('[[ratelimits]]\n', ''),
    /exactly one isolated rate limiter/,
  ],
];

for (const [name, source, expected] of mutations) {
  assert.throws(
    () => validateMonzoStagingConfig(source),
    expected,
    name,
  );
}

const deployEnv = {
  MONZO_ACCESS_AUD: 'd'.repeat(64),
  MONZO_KV_STATE_ID: '1'.repeat(32),
  MONZO_KV_TOKENS_ID: '2'.repeat(32),
  MONZO_KV_WEBHOOK_ROUTES_ID: '3'.repeat(32),
};

const deployReady = validateMonzoStagingConfig(canonical, {
  deployReady: true,
  env: deployEnv,
});
assert.equal(deployReady.deployReady, true);
assert.equal(deployReady.activationIdentifiersPresent, true);

assert.throws(
  () => validateMonzoStagingConfig(canonical, {
    deployReady: true,
    env: { ...deployEnv, MONZO_ACCESS_AUD: '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013' },
  }),
  /must not reuse the Calendar staging Access audience/,
);

assert.throws(
  () => validateMonzoStagingConfig(canonical, {
    deployReady: true,
    env: { ...deployEnv, MONZO_KV_TOKENS_ID: deployEnv.MONZO_KV_STATE_ID },
  }),
  /must be distinct/,
);

assert.throws(
  () => validateMonzoStagingConfig(canonical, {
    deployReady: true,
    env: { ...deployEnv, MONZO_KV_STATE_ID: 'dd43224461504e898addeba5b7915142' },
  }),
  /must not reuse a retained Calendar staging KV namespace/,
);

assert.throws(
  () => validateMonzoStagingConfig(canonical, {
    deployReady: true,
    env: { ...deployEnv, MONZO_KV_WEBHOOK_ROUTES_ID: '' },
  }),
  /kvWebhookRoutesId is not configured/,
);

console.log('Monzo dormant staging config regression: passed');
