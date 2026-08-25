import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GPT_DOMAIN_POLICY,
  classifyTargetDomains,
  rollbackAttachPayload,
  cloudflareResponseAccepted,
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

// Cloudflare may return HTTP 200 for a successful Custom Domain DELETE without
// the standard JSON envelope. A mutation 2xx is transport acceptance only;
// normal GET reads still require the canonical Cloudflare success envelope.
assert.equal(cloudflareResponseAccepted({ ok: true, method: 'DELETE', payload: null }), true);
assert.equal(cloudflareResponseAccepted({ ok: true, method: 'DELETE', payload: {} }), true);
assert.equal(cloudflareResponseAccepted({ ok: true, method: 'PUT', payload: null }), true);
assert.equal(cloudflareResponseAccepted({ ok: false, method: 'DELETE', payload: { success: true } }), false);
assert.equal(cloudflareResponseAccepted({ ok: true, method: 'GET', payload: null }), false);
assert.equal(cloudflareResponseAccepted({ ok: true, method: 'GET', payload: { success: true } }), true);

const workflow = readFileSync(new URL('../.github/workflows/gpt-production-domain-reconciliation.yml', import.meta.url), 'utf8');
const fullRelease = readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');
const releaseObserver = readFileSync(new URL('../.github/workflows/private-production-release-observer.yml', import.meta.url), 'utf8');
const inventoryWorkflow = readFileSync(new URL('../.github/workflows/cloudflare-production-inventory.yml', import.meta.url), 'utf8');
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

// The production environment admits release/private-crm-rc* refs. The bounded
// GPT operator therefore uses a one-commit, same-tree trigger under the existing
// inventory exclusion. Its parent is the immutable canonical SHA that is
// actually checked out and executed. Full release and its observer already
// exclude every inventory ref, while the read-only inventory workflow is free
// to run alongside the operator as independent topology evidence.
assert.match(workflow, /release\/private-crm-rc\*-inventory-gpt-domain-operator/);
assert.match(workflow, /APPROVED_SHA: \$\{\{ github\.event\.before \}\}/);
assert.match(workflow, /git rev-parse "\$GITHUB_SHA\^"/);
assert.match(workflow, /GITHUB_SHA\^\{tree\}/);
assert.match(workflow, /APPROVED_SHA\^\{tree\}/);
assert.match(workflow, /\[ "\$GITHUB_SHA" != "\$APPROVED_SHA" \]/);
assert.match(workflow, /required_workflows=\(/);
for (const required of [
  'Static Validation',
  'CRM and booking validation',
  'Gmail production validation',
  'Booking host validation',
  'WhatsApp production onboarding validation',
]) {
  assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(fullRelease, /!release\/private-crm-rc\*-inventory-\*/);
assert.match(releaseObserver, /!release\/private-crm-rc\*-inventory-\*/);
assert.match(inventoryWorkflow, /release\/private-crm-rc\*-inventory-\*/);
assert.match(workflow, /CANONICAL_BRANCH: agent\/platform-telegram-self-service/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /group: gpt-production-domain-reconciliation-\$\{\{ github\.event\.before \|\| github\.sha \}\}/);
assert.match(workflow, /github\.event\.before != '0000000000000000000000000000000000000000'/);
assert.doesNotMatch(workflow, /group: gpt-production-domain-reconciliation\s*$/m);
assert.match(workflow, /node scripts\/reconcile-gpt-production-domains\.mjs\s*$/m);
assert.match(workflow, /node scripts\/reconcile-gpt-production-domains\.mjs --apply/);
assert.doesNotMatch(workflow, /wrangler deploy|supabase db push|SUPABASE_DB_PASSWORD|SUPABASE_SECRET_KEY/i);

assert.match(reconciler, /workers\/domains\/\$\{encodeURIComponent\(stale\.id\)\}/);
assert.match(reconciler, /method: 'DELETE'/);
assert.match(reconciler, /cloudflareResponseAccepted/);
assert.match(reconciler, /DELETE was not confirmed by canonical GET readback/);
assert.match(reconciler, /waitForTargetDomainState/);
assert.match(reconciler, /ensurePreviousDomainState/);
assert.match(reconciler, /method: 'PUT', body: rollbackAttachPayload\(stale\)/);
assert.match(reconciler, /delete_transport=accepted readback=canonical/);
assert.match(reconciler, /worker_deployment_unchanged=true/);
assert.doesNotMatch(reconciler, /25a878c2c6cbcdbf4987523bdf4b1e69d6f2b106/,
  'runtime domain IDs must be resolved from fresh Cloudflare state, never pinned in source');

const deleteIndex = reconciler.indexOf("{ method: 'DELETE' }");
const authoritativeReadbackIndex = reconciler.indexOf('await waitForTargetDomainState', deleteIndex);
assert.ok(deleteIndex >= 0 && authoritativeReadbackIndex > deleteIndex,
  'Cloudflare DELETE must always be followed by authoritative GET readback');

console.log('GPT production domain reconciliation tests passed: inventory-excluded same-tree operator trigger, branch-creation skip, parent-keyed concurrency, exact-head CI admission, 2xx transport, authoritative GET readback and rollback boundary.');
