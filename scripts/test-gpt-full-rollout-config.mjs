import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/gpt-production-full-management-rollout.yml', import.meta.url),
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

const communicationsWorkflow = readFileSync(
  new URL('../.github/workflows/gpt-production-communications-domain-rollout.yml', import.meta.url),
  'utf8',
);
const rollbackPrepare = communicationsWorkflow.indexOf('Prepare and validate rollback config before mutation');
const productionDeploy = communicationsWorkflow.indexOf('Deploy existing GPT Worker on the third custom domain');

assert.ok(rollbackPrepare >= 0, 'communications rollout must prepare rollback before mutation');
assert.ok(productionDeploy > rollbackPrepare, 'rollback config validation must run before the production deploy step');
assert.match(communicationsWorkflow, /rollback_config="\$GITHUB_WORKSPACE\/\.wrangler\.gpt-rollback\.toml"/);
assert.match(communicationsWorkflow, /path\.resolve\(path\.dirname\(configPath\), match\[1\]\)/);
assert.match(communicationsWorkflow, /if \(!fs\.existsSync\(entrypoint\)\) throw new Error/);
assert.match(communicationsWorkflow, /npx wrangler deploy --config "\$rollback_config"/);
assert.doesNotMatch(communicationsWorkflow, /\$RUNNER_TEMP\/wrangler\.gpt-rollback\.toml/,
  'rollback config must stay beside the production config so relative Wrangler paths remain resolvable');

console.log('GPT rollout config tests passed: full-management gates remain closed and Communications rollback config is path-safe before mutation.');
