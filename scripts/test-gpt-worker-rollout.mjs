import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rollout = readFileSync(new URL('../.github/workflows/gpt-production-worker-rollout.yml', import.meta.url), 'utf8');
const domainRollout = readFileSync(new URL('../.github/workflows/gpt-production-communications-domain-rollout.yml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Admission
//
// The branch is a pattern, not one spent release name: this is the reusable
// path for every GPT code change. The domain rollout stays pinned to its own
// one-shot branch and is not widened by this workflow existing.
// ---------------------------------------------------------------------------

assert.match(rollout, /- 'release\/private-crm-rc\*-gpt-worker'/,
  'the Worker rollout must admit the reusable release branch pattern');
assert.match(rollout, /release\/private-crm-rc\*-gpt-worker\) ;;/,
  'the branch pattern must also be re-checked at runtime, not only by the trigger');
assert.match(domainRollout, /- release\/private-crm-rc558-gpt-communications-domain/,
  'the one-shot Communications-domain rollout must stay pinned to its own branch');

assert.match(rollout, /if: github\.actor == github\.repository_owner && github\.event\.before != '0{40}'/,
  'only the repository owner may trigger a production Worker rollout, and branch creation must not');
assert.match(rollout, /APPROVED_SHA: \$\{\{ github\.event\.before \}\}/,
  'the deployed SHA must be the branch head before the trigger commit');
assert.match(rollout, /environment: crm-production/);
assert.match(rollout, /concurrency:\n\s+group: gpt-production-worker-rollout/,
  'concurrent production Worker rollouts must not interleave');

// The trigger commit must be an empty same-tree child of the approved SHA, so
// the deployed tree is exactly the canonical one that CI checked.
assert.match(rollout, /git rev-parse "\$GITHUB_SHA\^"/);
assert.match(rollout, /git rev-parse "\$GITHUB_SHA\^\{tree\}"/);
assert.match(rollout, /git ls-remote origin "refs\/heads\/\$CANONICAL_BRANCH"/);
assert.match(rollout, /Approved SHA is no longer the canonical Vishar CRM head/);
assert.match(rollout, /CANONICAL_BRANCH: agent\/platform-telegram-self-service/);

for (const required of [
  'Static Validation',
  'CRM and booking validation',
  'Gmail production validation',
  'Booking host validation',
  'WhatsApp production onboarding validation',
]) {
  assert.ok(rollout.includes(`'${required}'`), `rollout missing exact-head CI gate: ${required}`);
}

// ---------------------------------------------------------------------------
// What this workflow may and may not mutate
// ---------------------------------------------------------------------------

assert.match(rollout, /supabase db push --dry-run/);
assert.doesNotMatch(rollout, /supabase db push\s*(?:\n|$)/,
  'a Worker rollout must never apply production database migrations');
assert.match(rollout, /Pending production database migration detected\. Refusing GPT edge mutation\./,
  'a pending migration must block the edge mutation rather than race it');

assert.doesNotMatch(rollout, /wrangler secret|configure_gpt_action_client|gpt_action_clients|can_manage_(?:crm|finance|communications)/i,
  'a Worker rollout must not touch secrets, GPT OAuth clients or capability ceilings');
assert.doesNotMatch(rollout, /gwaliusblwrzisrwnsvs|gpt-actions-staging/,
  'the production Worker rollout must never target the retained staging project');
assert.match(rollout, /\[ "\$SUPABASE_PROJECT_REF" = 'vfjexhfdbrjmuxfdvbdx' \]/,
  'the production Supabase target must be pinned exactly');

// Topology is a precondition here, never an outcome: the third custom domain
// was established by the one-shot rollout and this path only ships code.
const topologyAssertions = rollout.match(/JSON\.stringify\(hosts\) !== JSON\.stringify\(expected\)/g) || [];
assert.ok(topologyAssertions.length >= 3,
  'preflight, readback and rollback must each assert the exact three-domain topology');
assert.doesNotMatch(rollout, /needs_deploy/,
  'this path is not conditional on domain count; it always ships the approved code');
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 3);
assert.match(rollout, /\[ "\$\(grep -c 'custom_domain = true' wrangler\.gpt-actions\.production\.toml\)" -eq 3 \]/,
  'the deployed config must still declare exactly the three current custom domains');

// ---------------------------------------------------------------------------
// Everything the Cloudflare inventory needs must be in scope where it runs
//
// The inventory script fails closed on a missing variable, so a rollout that
// omits one is not partially broken, it never reaches Cloudflare at all. These
// live at job scope deliberately: a per-step copy is how one goes missing from
// the readback or the rollback while the preflight still looks fine.
// ---------------------------------------------------------------------------

const inventory = readFileSync(new URL('./cloudflare-production-inventory.mjs', import.meta.url), 'utf8');
const requiredInventoryEnv = [...inventory.matchAll(/process\.env\.([A-Z_]+) \|\| ''/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'CLOUDFLARE_ZONE');
assert.ok(requiredInventoryEnv.includes('SOURCE_SHA'), 'inventory script should still require SOURCE_SHA');

const jobEnv = rollout.slice(rollout.indexOf('    env:'), rollout.indexOf('    steps:'));
for (const name of requiredInventoryEnv) {
  assert.match(jobEnv, new RegExp(`^      ${name}:`, 'm'),
    `${name} must be job-scoped so every inventory invocation inherits it`);
}
assert.match(jobEnv, /SOURCE_SHA: \$\{\{ github\.event\.before \}\}/,
  'the inventory source SHA must be the approved canonical SHA, not the trigger commit');

const inventoryInvocations = (rollout.match(/cloudflare-production-inventory\.mjs/g) || []).length;
assert.equal(inventoryInvocations, 3,
  'preflight, readback and rollback each read Cloudflare fresh');

// ---------------------------------------------------------------------------
// Proof that something actually shipped, and a way back
// ---------------------------------------------------------------------------

assert.match(rollout, /refusing to deploy without a rollback target/,
  'a deploy must not start without a known previous version to roll back to');
assert.match(rollout, /afterVersion === process\.env\.BEFORE_VERSION/,
  'readback must fail when the active Worker version did not change');
assert.match(rollout, /npx wrangler rollback "\$BEFORE_VERSION" --name "\$WORKER_NAME" --yes/,
  'a failed readback must roll the Worker back to the recorded previous version');
assert.match(rollout, /if: failure\(\) && steps\.readback\.outcome == 'failure'/,
  'rollback must be scoped to a readback failure');
assert.match(rollout, /Rollback did not restore the previous version/,
  'the rollback itself must be read back rather than assumed');

// The edge answers 401 before it routes, so these probes prove the boundary is
// closed, not which routes exist. They must stay closed for the new inbox
// paths too.
for (const probe of [
  'probe 200 "https://\\$CORE_HOST/privacy"',
  'probe 401 "https://\\$CORE_HOST/v1/clients"',
  'probe 401 "https://\\$COMMUNICATIONS_HOST/v1/communications/conversations"',
  'probe 401 "https://\\$COMMUNICATIONS_HOST/v1/communications/conversations/\\$fake/messages"',
]) {
  assert.match(rollout, new RegExp(probe), `readback must probe: ${probe}`);
}
assert.match(rollout, /401 before it routes/,
  'the workflow must record why an unauthenticated probe is not route coverage');

console.log('GPT Worker rollout tests passed: reusable canonical-only admission, no DB/binding/secret mutation, fixed three-domain topology, proven version change and version rollback.');
