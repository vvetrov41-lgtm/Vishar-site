import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/gpt-production-full-management-rollout.yml', import.meta.url),
  'utf8',
);
const monzoWorkflow = readFileSync(
  new URL('../.github/workflows/gpt-production-monzo-reconciliation-rollout.yml', import.meta.url),
  'utf8',
);

assert.match(workflow, /release\/private-crm-rc31-gpt-full-management/);
assert.match(workflow, /environment: crm-production/);
assert.match(workflow, /PRODUCT_BRANCH: agent\/gpt-full-crm-management/);
assert.match(workflow, /PROJECT_REF: \$\{\{ vars\.CRM_PRODUCTION_SUPABASE_PROJECT_REF \}\}/);
assert.match(workflow, /\[ "\$PROJECT_REF" = 'vfjexhfdbrjmuxfdvbdx' \]/);
assert.match(workflow, /\[ "\$PROJECT_REF" != 'gwaliusblwrzisrwnsvs' \]/);
assert.match(workflow, /git ls-remote origin "refs\/heads\/\$PRODUCT_BRANCH"/);
assert.match(workflow, /Static Validation/);
assert.match(workflow, /CRM and booking validation/);
assert.match(workflow, /npm run test:gpt-production/);
assert.match(workflow, /npm run check:gpt-production-bundle/);
assert.match(workflow, /npm run scan:secrets/);
assert.match(workflow, /supabase db push --dry-run/);
assert.match(workflow, /Apply canonical production migrations/);
assert.match(workflow, /local_version == "0053" && remote_version == "0053"/);
assert.match(workflow, /local_version == "0054"/);
assert.match(workflow, /local_version == "0055"/);
assert.match(workflow, /local_version == "0056"/);
assert.match(workflow, /remote_0054 != "" \|\| remote_0055 != "" \|\| remote_0056 != ""/);
assert.match(workflow, /deployed_0054/);
assert.match(workflow, /deployed_0055/);
assert.match(workflow, /deployed_0056/);
assert.match(workflow, /Verify migration 0056 is recorded remotely/);
assert.match(workflow, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.match(workflow, /GPT_ACTIONS_ENABLED:true/);
assert.match(workflow, /"\$privacy" = 200/);
assert.match(workflow, /"\$oauth" = 400/);
assert.match(workflow, /"\$clients" = 401/);
assert.match(workflow, /"\$projects" = 401/);
assert.match(workflow, /"\$payments" = 401/);

assert.doesNotMatch(workflow, /pull_request|refs\/pull\//);
assert.doesNotMatch(workflow, /STAGING_SUPABASE_DB_PASSWORD|gwaliusblwrzisrwnsvs\.supabase\.co/);
assert.doesNotMatch(workflow, /configure_gpt_full_management/,
  'deployment workflow must not enable owner-controlled full-management capabilities');
assert.doesNotMatch(workflow, /update\s+crm_private\.gpt_action_clients/i,
  'deployment workflow must not directly mutate GPT bindings');
assert.doesNotMatch(workflow, /service_role|SUPABASE_SECRET_KEY|sb_secret_/i);

// Current Monzo GPT rollout is a single exact-head production gate. Production
// is expected at 0063, then the corrected artist destination model (0064),
// Multiple Sessions deposits (0065) and only then GPT wrappers (0066) are applied
// before the existing GPT Worker exposes the four Operations routes.
assert.match(monzoWorkflow, /release\/private-crm-rc73-gpt-monzo-reconciliation/);
assert.match(monzoWorkflow, /environment: crm-production/);
assert.match(monzoWorkflow, /PRODUCT_BRANCH: agent\/gpt-monzo-reconciliation-v2/);
assert.match(monzoWorkflow, /EXPECTED_PR: '371'/);
assert.match(monzoWorkflow, /SUPABASE_PROJECT_REF: \$\{\{ vars\.CRM_PRODUCTION_SUPABASE_PROJECT_REF \}\}/);
assert.match(monzoWorkflow, /test "\$SUPABASE_PROJECT_REF" = 'vfjexhfdbrjmuxfdvbdx'/);
assert.match(monzoWorkflow, /test "\$SUPABASE_PROJECT_REF" != 'gwaliusblwrzisrwnsvs'/);
assert.match(monzoWorkflow, /test "\$DB_DEPLOY_ENABLED" = true/);
assert.match(monzoWorkflow, /git ls-remote origin "refs\/heads\/\$PRODUCT_BRANCH"/);
for (const check of ['Static Validation', 'CRM and booking validation', 'Gmail production validation']) {
  assert.match(monzoWorkflow, new RegExp(check));
}
assert.match(monzoWorkflow, /supabase\/migrations\/0064_monzo_artist_payment_destinations\.sql/);
assert.match(monzoWorkflow, /supabase\/migrations\/0065_monzo_multiple_session_deposits\.sql/);
assert.match(monzoWorkflow, /supabase\/migrations\/0066_gpt_monzo_reconciliation\.sql/);
assert.match(monzoWorkflow, /supabase db reset --local --no-seed/);
assert.match(monzoWorkflow, /supabase test db/);
assert.match(monzoWorkflow, /supabase db lint --local --schema public,crm_private --level error --fail-on error/);
assert.match(monzoWorkflow, /verify remote head 0063/i);
assert.match(monzoWorkflow, /local_version == "0063" && remote_version == "0063"/);
assert.match(monzoWorkflow, /local_version == "0064" && remote_version == ""/);
assert.match(monzoWorkflow, /local_version == "0065" && remote_version == ""/);
assert.match(monzoWorkflow, /local_version == "0066" && remote_version == ""/);
assert.match(monzoWorkflow, /remote_version ~ \/\^\[0-9\]\+\$\//);
assert.match(monzoWorkflow, /newer_remote/);
assert.match(monzoWorkflow, /supabase db push --dry-run/);
assert.match(monzoWorkflow, /Apply production migrations 0064 then 0065 then 0066/);
assert.match(monzoWorkflow, /supabase db push\n/);
assert.match(monzoWorkflow, /local_version == "0064" && remote_version == "0064"/);
assert.match(monzoWorkflow, /local_version == "0065" && remote_version == "0065"/);
assert.match(monzoWorkflow, /local_version == "0066" && remote_version == "0066"/);
assert.match(monzoWorkflow, /deployed_0064/);
assert.match(monzoWorkflow, /deployed_0065/);
assert.match(monzoWorkflow, /deployed_0066/);
assert.match(monzoWorkflow, /wrangler deploy --config wrangler\.gpt-actions\.production\.toml/);
assert.match(monzoWorkflow, /\/v1\/payments\/monzo\/reconciliation/);
assert.match(monzoWorkflow, /"\$ops_monzo" = 401/);
assert.match(monzoWorkflow, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.match(monzoWorkflow, /GPT_ACTIONS_ENABLED:true/);
assert.match(monzoWorkflow, /Match settlement: no/);
assert.match(monzoWorkflow, /Confirm settlement: separate explicit consequential action/);

const dryRunIndex = monzoWorkflow.indexOf('Dry-run exact 0064 to 0066 migration chain');
const applyIndex = monzoWorkflow.indexOf('Apply production migrations 0064 then 0065 then 0066');
const workerIndex = monzoWorkflow.indexOf('Deploy existing production GPT Worker with Monzo Operations routes');
assert.ok(dryRunIndex >= 0 && applyIndex > dryRunIndex && workerIndex > applyIndex,
  'Monzo rollout must verify production 0063, dry-run, apply 0064/0065/0066, then deploy the GPT Worker');

assert.doesNotMatch(monzoWorkflow, /pull_request|refs\/pull\//);
assert.doesNotMatch(monzoWorkflow, /STAGING_SUPABASE/,
  'Monzo rollout must never use retained-staging secrets or variables');
assert.doesNotMatch(monzoWorkflow, /configure_gpt_full_management|configure_gpt_action_client|update\s+crm_private\.gpt_action_clients/i,
  'Monzo rollout must not create, enable or mutate GPT OAuth bindings');
assert.doesNotMatch(monzoWorkflow, /service_role|SUPABASE_SECRET_KEY|sb_secret_/i);

console.log('GPT rollout config tests passed: legacy RC31 boundary plus guarded RC73 0063->0064->0065->0066 Monzo GPT rollout.');
