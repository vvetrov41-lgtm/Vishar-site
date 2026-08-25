import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GPT_DOMAIN_POLICY,
  classifyTargetDomains,
  rollbackAttachPayload,
} from './reconcile-gpt-production-domains.mjs';

const canonicalRows = [
  {
    id: 'core-domain-id',
    hostname: GPT_DOMAIN_POLICY.coreHost,
    service: GPT_DOMAIN_POLICY.worker,
    environment: 'production',
    zone_id: 'zone-id',
    zone_name: GPT_DOMAIN_POLICY.zoneName,
  },
  {
    id: 'operations-domain-id',
    hostname: GPT_DOMAIN_POLICY.operationsHost,
    service: GPT_DOMAIN_POLICY.worker,
    environment: 'production',
    zone_id: 'zone-id',
    zone_name: GPT_DOMAIN_POLICY.zoneName,
  },
];
const staleRow = {
  id: 'stale-domain-id',
  hostname: GPT_DOMAIN_POLICY.staleHost,
  service: GPT_DOMAIN_POLICY.worker,
  environment: 'production',
  zone_id: 'zone-id',
  zone_name: GPT_DOMAIN_POLICY.zoneName,
};

const canonical = classifyTargetDomains(canonicalRows);
assert.equal(canonical.targetCount, 2);
assert.equal(canonical.requiresDetach, false);
assert.equal(canonical.stale, null);

const withStale = classifyTargetDomains([
  ...canonicalRows,
  staleRow,
  {
    id: 'unrelated-domain-id',
    hostname: 'telegram.vishartattoo.com',
    service: 'vishar-telegram-drain-production',
    environment: 'production',
    zone_id: 'zone-id',
    zone_name: GPT_DOMAIN_POLICY.zoneName,
  },
]);
assert.equal(withStale.targetCount, 3);
assert.equal(withStale.requiresDetach, true);
assert.equal(withStale.stale.id, 'stale-domain-id');
assert.deepEqual(rollbackAttachPayload(withStale.stale), {
  hostname: GPT_DOMAIN_POLICY.staleHost,
  service: GPT_DOMAIN_POLICY.worker,
  zone_id: 'zone-id',
  zone_name: GPT_DOMAIN_POLICY.zoneName,
});

assert.throws(
  () => classifyTargetDomains(canonicalRows.filter((row) => row.hostname !== GPT_DOMAIN_POLICY.operationsHost)),
  /canonical Custom Domain is missing/,
);
assert.throws(
  () => classifyTargetDomains([...canonicalRows, staleRow, { ...staleRow, id: 'duplicate-stale-id' }]),
  /Custom Domain is duplicated/,
);
assert.throws(
  () => classifyTargetDomains([
    ...canonicalRows,
    {
      id: 'unexpected-domain-id',
      hostname: 'gpt-old.vishartattoo.com',
      service: GPT_DOMAIN_POLICY.worker,
      environment: 'production',
      zone_id: 'zone-id',
      zone_name: GPT_DOMAIN_POLICY.zoneName,
    },
  ]),
  /Unexpected Custom Domain/,
);
assert.throws(
  () => classifyTargetDomains([...canonicalRows, { ...staleRow, zone_name: 'example.com' }]),
  /not safely identifiable/,
);

const workflow = readFileSync(new URL('../.github/workflows/gpt-production-domain-reconciliation.yml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const reconciler = readFileSync(new URL('./reconcile-gpt-production-domains.mjs', import.meta.url), 'utf8');

assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 2, 'canonical GPT config must expose exactly two Custom Domains');
assert.match(wrangler, /gpt-actions\.vishartattoo\.com/);
assert.match(wrangler, /gpt-operations\.vishartattoo\.com/);
assert.doesNotMatch(wrangler, /gpt-communications\.vishartattoo\.com/);
assert.match(operations, /gpt-operations\.vishartattoo\.com/);
assert.match(operations, /operationId: getWhatsAppConversation/);
assert.match(operations, /operationId: searchEmailHistory/);
assert.match(operations, /operationId: createEmailDraft/);

assert.match(workflow, /release\/private-crm-rc102-gpt-domain-reconcile/);
assert.match(workflow, /CANONICAL_BRANCH: agent\/platform-telegram-self-service/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /node scripts\/reconcile-gpt-production-domains\.mjs\s*$/m);
assert.match(workflow, /node scripts\/reconcile-gpt-production-domains\.mjs --apply/);
assert.doesNotMatch(workflow, /wrangler deploy|supabase db push|SUPABASE_DB_PASSWORD|SUPABASE_SECRET_KEY/i);

assert.match(reconciler, /workers\/domains\/\$\{encodeURIComponent\(stale\.id\)\}/);
assert.match(reconciler, /method: 'DELETE'/);
assert.match(reconciler, /method: 'PUT', body: rollbackAttachPayload\(stale\)/);
assert.match(reconciler, /worker_deployment_unchanged=true/);
assert.doesNotMatch(reconciler, /25a878c2c6cbcdbf4987523bdf4b1e69d6f2b106/,
  'runtime domain IDs must be resolved from fresh Cloudflare state, never pinned in source');

console.log('GPT production domain reconciliation tests passed: exact two-domain policy, stale-host-only mutation, fail-closed rollback boundary.');
