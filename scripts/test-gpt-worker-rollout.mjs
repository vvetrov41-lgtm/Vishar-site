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
assert.match(rollout, /Canonical Vishar CRM head moved after admission; refusing a stale GPT Worker deploy\./,
  'canonical must be re-read immediately before the production mutation');
assert.match(rollout, /GPT Worker release branch moved after admission; refusing production mutation\./,
  'the release trigger branch must also still point to the admitted trigger commit');

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
assert.match(rollout, /Production migration state changed after preflight; refusing GPT edge mutation\./,
  'migration drift must be checked again immediately before the edge mutation');

assert.doesNotMatch(rollout, /wrangler secret|configure_gpt_action_client|gpt_action_clients|can_manage_(?:crm|finance|communications)/i,
  'a Worker rollout must not touch secrets, GPT OAuth clients or capability ceilings');
assert.doesNotMatch(rollout, /gwaliusblwrzisrwnsvs|gpt-actions-staging/,
  'the production Worker rollout must never target the retained staging project');
assert.match(rollout, /\[ "\$SUPABASE_PROJECT_REF" = 'vfjexhfdbrjmuxfdvbdx' \]/,
  'the production Supabase target must be pinned exactly');

// Topology is a precondition here, never an outcome: the third custom domain
// was established by the one-shot rollout and this path only ships code.
const topologyAssertions = rollout.match(/JSON\.stringify\(hosts\) !== JSON\.stringify\(expected\)/g) || [];
assert.ok(topologyAssertions.length >= 4,
  'preflight, readback and both rollback paths must each assert the exact three-domain topology');
assert.doesNotMatch(rollout, /needs_deploy/,
  'this path is not conditional on domain count; it always ships the approved code');
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 3);
assert.match(rollout, /\[ "\$\(grep -c 'custom_domain = true' wrangler\.gpt-actions\.production\.toml\)" -eq 3 \]/,
  'the deployed config must still declare exactly the three current custom domains');

// Runtime readback must prove the non-secret production bindings that matter to
// safety rather than merely assuming wrangler applied the tracked config.
assert.ok((rollout.match(/bindings\.get\('SUPABASE_URL'\)/g) || []).length >= 3,
  'preflight, readback and rollback must verify the exact production Supabase URL binding');
assert.ok((rollout.match(/bindings\.get\('GPT_RATE_LIMIT'\)/g) || []).length >= 3,
  'preflight, readback and rollback must verify the GPT rate-limit binding');
assert.match(rollout, /rateLimit\?\.type !== 'ratelimit'/,
  'Cloudflare inventory normalizes rate-limit bindings as ratelimit');
assert.doesNotMatch(rollout, /rateLimit\?\.type !== 'rate_limit'/,
  'the rollout must not use the non-existent rate_limit inventory type');
assert.match(rollout, /String\(rateLimit\.namespace_id\) !== '1002'/,
  'the rate-limit namespace must be pinned to the tracked production resource');
assert.match(rollout, /Number\(rateLimit\.simple\?\.limit\) !== 30/);
assert.match(rollout, /Number\(rateLimit\.simple\?\.period\) !== 60/);

// ---------------------------------------------------------------------------
// Cross-workflow trigger isolation
//
// private-production-release.yml fires on every release/private-crm-rc* push
// and mutates the database, the CRM and Telegram. A Worker-only rollout branch
// that also matched it would run the full release in parallel, which is how
// migration 0125 came to be applied by a branch push on rc582. The claim that
// this rollout ships Worker code and nothing else only holds if the broad
// release workflow cannot be triggered by the same ref.
//
// The excluded pattern is derived from the rollout's own trigger rather than
// written twice, so renaming one cannot silently unguard the other.
// ---------------------------------------------------------------------------

const release = readFileSync(new URL('../.github/workflows/private-production-release.yml', import.meta.url), 'utf8');

const rolloutBranchPattern = rollout.match(/^ {6}- '(release\/private-crm-rc\*-gpt-worker)'$/m)?.[1];
assert.ok(rolloutBranchPattern, 'the rollout must declare its release branch pattern as a quoted trigger');

assert.ok(
  release.includes(`- '!${rolloutBranchPattern}'`),
  'private-production-release.yml must exclude the GPT Worker rollout branch from its push trigger',
);

// A trigger exclusion alone is one edit away from being lost, and workflow_dispatch
// bypasses it entirely, so every runtime ref guard must refuse the ref too.
const guards = [...release.matchAll(/case "\$GITHUB_REF_NAME" in\n([\s\S]*?)\n\s+esac/g)].map((m) => m[1]);
assert.ok(guards.length >= 4, `expected the release workflow to keep its runtime ref guards, found ${guards.length}`);
for (const [index, guard] of guards.entries()) {
  const excluded = guard.indexOf('release/private-crm-rc*-gpt-worker)');
  const catchAll = guard.indexOf('release/private-crm-rc*) ;;');
  assert.notEqual(excluded, -1, `release guard ${index + 1} does not refuse the GPT Worker rollout ref`);
  assert.notEqual(catchAll, -1, `release guard ${index + 1} lost its catch-all arm`);
  assert.ok(excluded < catchAll,
    `release guard ${index + 1} matches the catch-all before the GPT Worker exclusion, so the exclusion never fires`);
}

// ---------------------------------------------------------------------------
// Everything the Cloudflare inventory needs must be in scope where it runs
//
// The inventory script fails closed on a missing variable, so a rollout that
// omits one is not partially broken, it never reaches Cloudflare at all. These
// live at job scope deliberately: a per-step copy is how one goes missing from
// the readback or the rollback while the preflight still looks fine.
// ---------------------------------------------------------------------------

const inventory = readFileSync(new URL('./cloudflare-production-inventory.mjs', import.meta.url), 'utf8');
assert.match(inventory, /case 'ratelimit':/,
  'Cloudflare inventory must preserve ratelimit namespace and simple limit/period details');
assert.doesNotMatch(inventory, /case 'rate_limit':/,
  'Cloudflare inventory must not use the stale rate_limit binding type');
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
assert.equal(inventoryInvocations, 4,
  'preflight, readback and both rollback paths each read Cloudflare fresh');

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
  'readback failure must roll back to the recorded previous version');
assert.match(rollout, /if: failure\(\) && steps\.deploy\.outcome == 'failure'/,
  'a failed deploy command must also reassert the recorded previous version in case the transport failed after mutation');
assert.match(rollout, /Rollback did not restore the previous version/,
  'the readback-failure rollback itself must be read back rather than assumed');
assert.match(rollout, /Deploy-failure rollback did not restore the previous version/,
  'the deploy-failure rollback itself must be read back rather than assumed');

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

console.log('GPT Worker rollout tests passed: reusable canonical-only admission, final mutation fresh-check, exact runtime bindings, no DB/secret mutation, fixed three-domain topology, proven version change and rollback on readback or deploy failure.');
