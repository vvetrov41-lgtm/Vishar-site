import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/private-production-release.yml');
const observer = read('.github/workflows/private-production-release-observer.yml');
const telegramRollback = read('.github/workflows/deploy-private-production-telegram.yml');

const expectIncludes = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (text, needle, label) => {
  if (text.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};
const count = (text, needle) => text.split(needle).length - 1;
const expectOrder = (text, first, second, label) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  if (a < 0 || b < 0 || a >= b) {
    throw new Error(`${label}: expected ${first} before ${second}`);
  }
};

expectIncludes(workflow, "- 'release/private-crm-rc*'", 'release trigger');
expectIncludes(workflow, "- '!release/private-crm-rc*-inventory-*'", 'read-only inventory trigger exclusion');
expectIncludes(workflow, 'release/private-crm-rc*-inventory-*)', 'read-only inventory runtime exclusion');
expectIncludes(workflow, 'workflow_dispatch:', 'release trigger');
expectExcludes(workflow, 'approved_sha:', 'zero-input release');
expectExcludes(workflow, 'approval_phrase:', 'zero-input release');
expectExcludes(workflow, 'linking_approval_phrase:', 'zero-input release');
expectExcludes(workflow, 'linking_rollback_phrase:', 'zero-input release');

if (count(workflow, 'environment: crm-production') !== 1) {
  throw new Error('release gate: exactly one crm-production environment gate is required');
}

const deployMarker = '\n  deploy:\n';
const deployIndex = workflow.indexOf(deployMarker);
if (deployIndex < 0) throw new Error('release workflow: deploy job missing');
const validationSection = workflow.slice(0, deployIndex);
const deploySection = workflow.slice(deployIndex);

expectExcludes(validationSection, 'secrets.', 'validation jobs');
expectExcludes(validationSection, 'environment: crm-production', 'validation jobs');
expectIncludes(deploySection, 'needs:', 'deploy job');
expectIncludes(deploySection, '- validate-release', 'deploy job');
expectIncludes(deploySection, '- validate-crm', 'deploy job');
expectIncludes(deploySection, '- validate-database', 'deploy job');
expectIncludes(deploySection, 'environment: crm-production', 'deploy job');
expectIncludes(deploySection, 'if: github.actor == github.repository_owner', 'release authorization');
expectIncludes(deploySection, '[ "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER" ]', 'release authorization');

expectIncludes(workflow, 'REQUIRED_RELEASE_FOUNDATION_SHA: cbcb5fa1e5e8559fadd98c9681c6de7ea8549687', 'release lineage');
expectIncludes(workflow, 'git merge-base --is-ancestor "$REQUIRED_RELEASE_FOUNDATION_SHA" "$GITHUB_SHA"', 'release lineage');
expectIncludes(workflow, 'git ls-remote origin', 'release immutability');
expectIncludes(workflow, 'refs/heads/${GITHUB_REF_NAME}', 'release immutability');
expectIncludes(workflow, '[ "$remote_sha" = "$GITHUB_SHA" ]', 'release immutability');
expectIncludes(workflow, 'CRM_PRODUCTION_DB_DEPLOY_ENABLED', 'database kill switch');
expectIncludes(workflow, 'CRM_PRODUCTION_DEPLOY_ENABLED', 'CRM kill switch');

expectIncludes(deploySection, "RETAINED_STAGING_PROJECT_REF='gwaliusblwrzisrwnsvs'", 'production target');
expectIncludes(deploySection, '[ "$PROJECT_URL" = "https://${PROJECT_REF}.supabase.co" ]', 'production target');
expectExcludes(deploySection, 'db reset --linked', 'production database');
expectExcludes(deploySection, '--include-seed', 'production database');
expectOrder(workflow, '- name: Dry-run production migrations', '- name: Apply production migrations', 'database rollout');
expectOrder(workflow, '- name: Preflight Cloudflare Pages target before mutation', '- name: Apply production migrations', 'pre-mutation Pages control-plane check');
expectOrder(workflow, '- name: Verify exact Telegram production Worker secret names before mutation', '- name: Apply production migrations', 'pre-mutation Telegram secret inventory');
expectOrder(workflow, '- name: Telegram production preflight before mutation', '- name: Apply production migrations', 'pre-mutation Telegram control-plane check');
expectOrder(workflow, '- name: Apply production migrations', '- name: Verify no production migrations remain', 'database readback');
expectIncludes(deploySection, 'supabase db push --dry-run', 'database rollout');
expectIncludes(deploySection, 'Production Cloudflare Pages target preflight failed', 'pre-mutation Pages control-plane check');

expectIncludes(deploySection, "[ \"$CRM_ORIGIN\" = 'https://crm.vishartattoo.com' ]", 'CRM target');
expectIncludes(deploySection, 'wrangler pages deploy dist', 'CRM deploy');
expectIncludes(deploySection, '--commit-hash "$GITHUB_SHA"', 'CRM deploy');
expectIncludes(deploySection, '/pages/projects/${CRM_PAGES_PROJECT}/deployments', 'CRM readback');
expectIncludes(deploySection, 'deployment_trigger?.metadata?.commit_hash === process.env.GITHUB_SHA', 'CRM readback');
expectIncludes(deploySection, 'Exact production Pages commit was not found', 'CRM readback');

expectIncludes(deploySection, 'generate-telegram-production-deploy-config.mjs "$preflight_config" --enable-linking', 'Telegram linking preservation');
expectIncludes(deploySection, 'TELEGRAM_LINKING_ENABLED = "true"', 'Telegram linking preservation');
expectIncludes(deploySection, 'GMAIL_SHARED_DRAIN_ENABLED = "true"', 'Gmail shared drain preservation');
expectIncludes(deploySection, 'service = "vishar-gmail-production"', 'Gmail service binding preservation');
expectOrder(workflow, '- name: Telegram production preflight', '- name: Dry-run Telegram shared scheduler', 'Telegram rollout');
expectOrder(workflow, '- name: Dry-run Telegram shared scheduler', '- name: Deploy Telegram shared scheduler', 'Telegram rollout');
if (count(deploySection, 'node scripts/preflight-telegram-production.mjs') < 4) {
  throw new Error('Telegram rollout: preflight must run before the first production mutation, before deploy and after deploy');
}
expectIncludes(deploySection, 'WRANGLER_OUTPUT_FILE_PATH', 'Telegram version evidence');
expectIncludes(deploySection, 'wrangler versions list', 'Telegram version readback');
expectIncludes(deploySection, 'Verify live Telegram HTTP boundary', 'Telegram live readback');

expectIncludes(observer, "- 'release/private-crm-rc*'", 'release observer trigger');
expectIncludes(observer, "- '!release/private-crm-rc*-inventory-*'", 'release observer inventory exclusion');
expectIncludes(observer, 'release/private-crm-rc*-inventory-*)', 'release observer runtime inventory exclusion');
expectIncludes(observer, 'actions: read', 'release observer permissions');
expectIncludes(observer, 'statuses: write', 'release observer permissions');
expectIncludes(observer, 'if: github.actor == github.repository_owner', 'release observer authorization');
expectIncludes(observer, "context='vishar/private-production-release'", 'release observer status context');
expectIncludes(observer, 'statuses/${GITHUB_SHA}', 'release observer exact-SHA status');
expectIncludes(observer, 'actions/workflows/private-production-release.yml/runs?event=push&per_page=30', 'release observer exact workflow');
expectIncludes(observer, 'run?.head_sha === process.env.TARGET_SHA', 'release observer exact-SHA discovery');
expectIncludes(observer, 'run.head_sha !== process.env.TARGET_SHA', 'release observer exact-SHA readback');
expectIncludes(observer, 'runs_file="$RUNNER_TEMP/private-production-release-runs.json"', 'release observer bounded JSON handling');
expectIncludes(observer, 'run_file="$RUNNER_TEMP/private-production-release-run.json"', 'release observer bounded JSON handling');
expectIncludes(observer, "fs.readFileSync(process.argv[2], 'utf8')", 'release observer bounded JSON handling');
expectExcludes(observer, 'RUNS="$runs"', 'release observer ARG_MAX boundary');
expectExcludes(observer, 'RUN="$run"', 'release observer ARG_MAX boundary');
expectExcludes(observer, 'environment: crm-production', 'release observer isolation');
expectExcludes(observer, 'secrets.', 'release observer isolation');
for (const forbidden of [
  'supabase db push',
  'wrangler deploy',
  'wrangler pages deploy',
  'wrangler secret',
  'activate-telegram-webhook.mjs',
]) {
  expectExcludes(observer, forbidden, 'release observer mutation boundary');
}

for (const forbidden of [
  'activate-telegram-webhook.mjs',
  'wrangler secret put',
  'wrangler secret bulk',
  'supabase db reset --linked',
  'wrangler pages deploy ../',
  'wrangler.toml --env production',
]) {
  expectExcludes(workflow, forbidden, 'release mutation boundary');
}

// The automatic happy path must not remove the explicit emergency rollback path.
expectIncludes(telegramRollback, 'disable_linking:', 'Telegram rollback');
expectIncludes(telegramRollback, 'DISABLE_TELEGRAM_LINKING', 'Telegram rollback');
expectIncludes(telegramRollback, 'legacy_artist_fallback_retained: true', 'Telegram rollback');

console.log('Private production release orchestrator boundaries: passed');
