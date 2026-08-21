import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const expectIncludes = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (text, needle, label) => {
  if (text.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};
const expectLineAbsent = (text, directive, label) => {
  if (text.split('\n').includes(directive)) throw new Error(`${label}: forbidden directive ${directive}`);
};

const crm = read('.github/workflows/deploy-private-production-crm.yml');
const database = read('.github/workflows/deploy-private-production-database.yml');
const team = read('.github/workflows/deploy-private-production-team-admin.yml');
const calendar = read('.github/workflows/deploy-private-production-calendar.yml');
const whatsapp = read('.github/workflows/deploy-private-production-whatsapp.yml');
const instagram = read('.github/workflows/deploy-private-production-instagram.yml');
const teamConfig = read('wrangler.team-admin.toml');

// Assertions about a TOML file must describe its directives, not its prose.
// Stripping comments keeps an explanatory comment from either satisfying or
// failing a check that is meant to be about actual configuration.
const directivesOf = (text) => text
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');
const teamProductionConfig = directivesOf(read('wrangler.team-admin.production.toml'));

for (const [label, text] of [
  ['CRM Pages', crm],
  ['production database', database],
  ['Team admin', team],
  ['Calendar connector', calendar],
  ['WhatsApp drain', whatsapp],
  ['Instagram connector', instagram],
]) {
  expectIncludes(text, 'environment: crm-production', label);
  expectIncludes(text, 'release/private-crm-rc*', label);
  expectIncludes(text, 'approved_sha', label);
  expectExcludes(text, 'environment: production\n', label);
}

expectIncludes(crm, 'npx wrangler pages deploy admin/dist', 'CRM Pages');
expectIncludes(crm, '--project-name "$CRM_PAGES_PROJECT"', 'CRM Pages');
expectExcludes(crm, 'supabase db push', 'CRM Pages');
expectExcludes(crm, 'wrangler deploy --env', 'CRM Pages');
expectExcludes(crm, 'wrangler.team-admin.toml', 'CRM Pages');
// The production Instagram connector is live. Its browser origin is an exact,
// repository-owned deployment constant so an absent environment variable
// cannot silently ship a successful CRM build with both connection controls
// disabled. The preflight and artifact check must also reject an empty value.
expectIncludes(
  crm,
  'VITE_INSTAGRAM_CONNECTOR_ORIGIN: https://instagram.vishartattoo.com',
  'CRM Pages',
);
expectExcludes(crm, 'vars.CRM_PRODUCTION_INSTAGRAM_CONNECTOR_ORIGIN', 'CRM Pages');
expectIncludes(
  crm,
  'if [ "$VITE_INSTAGRAM_CONNECTOR_ORIGIN" != \'https://instagram.vishartattoo.com\' ]; then',
  'CRM Pages',
);
expectExcludes(crm, 'if [ -n "$VITE_INSTAGRAM_CONNECTOR_ORIGIN" ]', 'CRM Pages');
expectIncludes(crm, 'grep -R -Fq "$VITE_INSTAGRAM_CONNECTOR_ORIGIN" admin/dist', 'CRM Pages');

expectIncludes(database, 'supabase db reset --local --no-seed', 'production database');
expectIncludes(database, 'supabase db push --dry-run', 'production database');
expectIncludes(database, "'DEPLOY_PRIVATE_CRM_DATABASE'", 'production database');
expectIncludes(database, "RETAINED_STAGING_PROJECT_REF='gwaliusblwrzisrwnsvs'", 'production database');
expectExcludes(database, '--include-seed', 'production database');
expectExcludes(database, 'db reset --linked', 'production database');
expectExcludes(database, 'wrangler deploy', 'production database');
expectExcludes(database, 'wrangler pages deploy', 'production database');

expectIncludes(teamConfig, 'workers_dev = false', 'Team admin config');

// The production deployment runs `wrangler deploy --strict`, which compares the
// generated local configuration against the deployed Worker. Every value that
// `--strict` compares must therefore be declared in the production config and
// match the production Worker exactly, otherwise the deployment aborts on a
// permanent conflict and the only "fix" left would be dropping `--strict`.
expectIncludes(teamProductionConfig, 'name = "vishar-team-admin-production"', 'Team admin production config');
expectIncludes(teamProductionConfig, 'main = "workers/team-admin.js"', 'Team admin production config');
expectIncludes(teamProductionConfig, 'workers_dev = false', 'Team admin production config');
expectIncludes(teamProductionConfig, 'preview_urls = false', 'Team admin production config');
expectExcludes(teamProductionConfig, 'workers_dev = true', 'Team admin production config');
expectExcludes(teamProductionConfig, 'preview_urls = true', 'Team admin production config');

// The Worker's production Custom Domain (team.vishartattoo.com) was
// provisioned once, directly against the Cloudflare dashboard, before this
// config existed. `--strict` compares routes too, so declaring none here
// read as "delete the production route" and permanently aborted every
// deploy. The route must be declared and must be exactly the pre-provisioned
// one — narrower or different values are still rejected, since either would
// itself be a silent `--strict` conflict or a widened route.
expectIncludes(teamProductionConfig, 'routes = [', 'Team admin production config');
expectIncludes(teamProductionConfig, 'pattern = "team.vishartattoo.com"', 'Team admin production config');
expectIncludes(teamProductionConfig, 'zone_name = "vishartattoo.com"', 'Team admin production config');
expectIncludes(teamProductionConfig, 'custom_domain = true', 'Team admin production config');
expectIncludes(teamProductionConfig, 'enabled = true', 'Team admin production config');
expectIncludes(teamProductionConfig, 'previews_enabled = false', 'Team admin production config');
expectLineAbsent(teamProductionConfig, 'enabled = false', 'Team admin production config');
expectLineAbsent(teamProductionConfig, 'previews_enabled = true', 'Team admin production config');
expectExcludes(teamProductionConfig, 'pattern = "*', 'Team admin production config');
expectExcludes(teamProductionConfig, 'crm.vishartattoo.com', 'Team admin production config');
expectExcludes(teamProductionConfig, 'vishartattoo.com/*', 'Team admin production config');

expectIncludes(team, 'node scripts/test-team-admin-worker.mjs', 'Team admin');
expectIncludes(team, 'npm run check:team-admin-production-bundle', 'Team admin');
expectIncludes(team, "'DEPLOY_PRIVATE_CRM_TEAM_ADMIN'", 'Team admin');
expectIncludes(team, 'wrangler secret list', 'Team admin');
expectIncludes(team, "names.has('SUPABASE_SECRET_KEY')", 'Team admin');
// Both the secret pre-flight and the deploy must target the production config.
expectIncludes(team, 'secret list --config wrangler.team-admin.production.toml', 'Team admin');
expectIncludes(team, '--config wrangler.team-admin.production.toml', 'Team admin');
expectExcludes(team, '--config wrangler.team-admin.toml', 'Team admin');
expectIncludes(team, '--keep-vars', 'Team admin');
expectIncludes(team, '--strict', 'Team admin');
expectExcludes(team, 'wrangler secret put', 'Team admin');
expectExcludes(team, 'wrangler secret bulk', 'Team admin');
expectExcludes(team, '--domain', 'Team admin');
expectExcludes(team, '--route', 'Team admin');
expectExcludes(team, 'wrangler.toml --env', 'Team admin');
expectExcludes(team, 'wrangler.telegram', 'Team admin');
expectExcludes(team, 'wrangler.calendar', 'Team admin');
expectExcludes(team, 'supabase db push', 'Team admin');

// The summary must describe the declared route accurately: it now exists in
// the production config and must match the pre-provisioned domain, rather
// than claiming no route/custom domain is involved.
expectIncludes(team, 'team.vishartattoo.com', 'Team admin');
expectIncludes(team, 'pre-provisioned', 'Team admin');
expectExcludes(team, 'not performed by this workflow', 'Team admin');

// The Calendar connector is the only production Worker whose deployable
// configuration is generated rather than tracked, because the KV namespace ids
// and the Access audience name objects that do not exist yet. The boundary that
// matters here is that the generation is the *only* difference: it must still
// deploy one Worker, from the tracked entrypoint, with no cron, no drain and no
// reach into any other production surface.
expectIncludes(calendar, "'DEPLOY_PRIVATE_CRM_CALENDAR'", 'Calendar connector');
expectIncludes(calendar, 'CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED', 'Calendar connector');
expectIncludes(calendar, 'node scripts/generate-calendar-production-deploy-config.mjs', 'Calendar connector');
expectIncludes(calendar, 'node scripts/test-calendar-production-config.mjs', 'Calendar connector');
expectIncludes(calendar, 'npm run validate:calendar-production', 'Calendar connector');
expectIncludes(calendar, 'npm run check:calendar-production-bundle', 'Calendar connector');
expectIncludes(calendar, 'wrangler secret list', 'Calendar connector');
expectIncludes(calendar, '--strict', 'Calendar connector');
expectIncludes(calendar, '--dry-run', 'Calendar connector');
expectExcludes(calendar, 'wrangler pages deploy', 'Calendar connector');
expectExcludes(calendar, 'supabase db push', 'Calendar connector');
expectExcludes(calendar, 'wrangler secret put', 'Calendar connector');
expectExcludes(calendar, 'wrangler secret bulk', 'Calendar connector');
expectExcludes(calendar, 'wrangler.team-admin', 'Calendar connector');
expectExcludes(calendar, 'wrangler.telegram', 'Calendar connector');
expectExcludes(calendar, 'wrangler.calendar.staging.toml', 'Calendar connector');
expectExcludes(calendar, 'rulesets', 'Calendar connector');

// The production Calendar configuration is only safe while it stays inert and
// carries no retained-staging identifier.
const calendarProductionConfig = directivesOf(read('wrangler.calendar.production.toml'));
expectIncludes(calendarProductionConfig, 'name = "vishar-calendar-production"', 'Calendar production config');
expectIncludes(calendarProductionConfig, 'main = "workers/calendar-oauth.js"', 'Calendar production config');
expectIncludes(calendarProductionConfig, 'workers_dev = false', 'Calendar production config');
expectIncludes(calendarProductionConfig, 'preview_urls = false', 'Calendar production config');
expectIncludes(calendarProductionConfig, 'CALENDAR_DRAIN_ENABLED = "false"', 'Calendar production config');
expectIncludes(calendarProductionConfig, 'pattern = "calendar.vishartattoo.com"', 'Calendar production config');
expectIncludes(calendarProductionConfig, '[[ratelimits]]', 'Calendar production config');
expectLineAbsent(calendarProductionConfig, '[triggers]', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'crons', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'workers_dev = true', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'preview_urls = true', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'CALENDAR_DRAIN_ENABLED = "true"', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'gwaliusblwrzisrwnsvs', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'calendar-staging', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'pages.dev', 'Calendar production config');
expectExcludes(calendarProductionConfig, 'dd43224461504e898addeba5b7915142', 'Calendar production config');
expectExcludes(calendarProductionConfig, '93302bc4f35242c38358a16fcd4ab9a2', 'Calendar production config');

// Retained staging keeps the controls it already has. A rate limiter binding
// appearing there would be an unrequested change to a live environment.
expectExcludes(read('wrangler.calendar.staging.toml'), '[[ratelimits]]', 'Calendar staging config');

// ---------------------------------------------------------------------------
// Monzo connector: the reusable production gate and its pre-merge operator path
// ---------------------------------------------------------------------------
//
// The gate is reachable by workflow_dispatch and by workflow_call. Both must
// land on the same crm-production approval and the same approval phrases, so
// these assertions describe the gate itself rather than either entry point.

// Both YAML and the embedded shell use `#`, so dropping whole comment lines
// keeps an explanatory note from failing a check about actual behaviour.
const withoutComments = (text) => text
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

const monzo = read('.github/workflows/deploy-private-production-monzo.yml');
const monzoDirectives = withoutComments(monzo);
const monzoOperator = read('.github/workflows/monzo-production-operator.yml');

expectIncludes(monzo, 'environment: crm-production', 'Monzo connector');
expectIncludes(monzo, 'release/private-crm-rc*', 'Monzo connector');
expectIncludes(monzo, 'approved_sha', 'Monzo connector');
expectIncludes(monzo, 'workflow_call:', 'Monzo connector');
expectIncludes(monzo, 'DEPLOY_PRIVATE_CRM_MONZO_ONLY', 'Monzo connector');
expectIncludes(monzo, 'BOOTSTRAP_PRIVATE_CRM_MONZO_INERT', 'Monzo connector');
expectIncludes(monzo, 'CRM_PRODUCTION_MONZO_DEPLOY_ENABLED', 'Monzo connector');
expectIncludes(monzo, 'wrangler.monzo-api.production.toml', 'Monzo connector');
expectIncludes(monzo, '--strict', 'Monzo connector');
expectExcludes(monzo, 'environment: production\n', 'Monzo connector');
expectExcludes(monzoDirectives, '--keep-vars', 'Monzo connector');
expectExcludes(monzoDirectives, 'wrangler pages deploy', 'Monzo connector');
expectExcludes(monzoDirectives, 'supabase db push', 'Monzo connector');

// The deployed entrypoint must stay the rate-limiting gateway. Deploying the
// bare router would expose an unthrottled public webhook path.
expectExcludes(monzoDirectives, 'config wrangler.monzo-api.toml', 'Monzo connector');

// Validation must never sit behind the production approval, and the deploy job
// must never run without it.
{
  const jobs = monzo.split(/^  (?=[a-z][a-z0-9_-]*:$)/m);
  const validateJob = jobs.find((job) => job.startsWith('validate:'));
  const deployJob = jobs.find((job) => job.startsWith('deploy:'));
  if (!validateJob || !deployJob) throw new Error('Monzo connector: expected separate validate and deploy jobs');
  expectExcludes(validateJob, 'environment:', 'Monzo validate job');
  expectExcludes(validateJob, 'CLOUDFLARE_API_TOKEN', 'Monzo validate job');
  expectExcludes(validateJob, 'wrangler deploy --config', 'Monzo validate job');
  expectExcludes(validateJob, 'wrangler secret put', 'Monzo validate job');
  expectIncludes(deployJob, 'environment: crm-production', 'Monzo deploy job');
  expectIncludes(deployJob, 'needs: validate', 'Monzo deploy job');
}

// The operator path exists only because a workflow_dispatch workflow is not
// registered off the default branch. It must remain a trigger, never a second
// implementation of the gate and never a generic command bridge.
expectIncludes(monzoOperator, 'types: [edited]', 'Monzo operator');
expectIncludes(monzoOperator, 'uses: ./.github/workflows/deploy-private-production-monzo.yml', 'Monzo operator');
expectIncludes(monzoOperator, 'RUN_MONZO_PRODUCTION_VALIDATE:{0}', 'Monzo operator');
expectIncludes(monzoOperator, 'RUN_MONZO_PRODUCTION_BOOTSTRAP:{0}', 'Monzo operator');
expectIncludes(monzoOperator, 'RUN_MONZO_PRODUCTION_ROLLOUT:{0}', 'Monzo operator');
expectIncludes(monzoOperator, 'github.event.pull_request.head.sha', 'Monzo operator');
expectIncludes(monzoOperator, 'draft == true', 'Monzo operator');
expectIncludes(monzoOperator, 'merged == false', 'Monzo operator');
expectIncludes(monzoOperator, "state == 'open'", 'Monzo operator');
expectIncludes(monzoOperator, 'head.repo.full_name == github.repository', 'Monzo operator');
expectIncludes(monzoOperator, 'release/private-crm-rc34-monzo-production', 'Monzo operator');

// A marker keyed on the branch name rather than the exact head SHA would stay
// valid across pushes and silently authorise a later tree.
expectExcludes(monzoOperator, 'RUN_MONZO_PRODUCTION_VALIDATE -->', 'Monzo operator');
expectExcludes(monzoOperator, 'RUN_MONZO_PRODUCTION_BOOTSTRAP -->', 'Monzo operator');
expectExcludes(monzoOperator, 'RUN_MONZO_PRODUCTION_ROLLOUT -->', 'Monzo operator');

// The operator must hold no credential and must not be able to mutate anything
// on its own, nor become reachable from an ordinary push or PR open.
expectExcludes(monzoOperator, 'CLOUDFLARE_API_TOKEN', 'Monzo operator');
expectExcludes(monzoOperator, 'SUPABASE_SECRET_KEY', 'Monzo operator');
expectExcludes(withoutComments(monzoOperator), 'wrangler', 'Monzo operator');
expectExcludes(monzoOperator, 'types: [opened', 'Monzo operator');
expectExcludes(monzoOperator, 'types: [synchronize', 'Monzo operator');
expectExcludes(withoutComments(monzoOperator), 'pull_request_target', 'Monzo operator');
expectExcludes(withoutComments(monzoOperator), 'workflow_dispatch', 'Monzo operator');

const monzoProductionConfig = directivesOf(read('wrangler.monzo-api.production.toml'));
expectIncludes(monzoProductionConfig, 'name = "vishar-monzo-api-production"', 'Monzo production config');
expectIncludes(monzoProductionConfig, 'main = "workers/monzo-api-gateway.js"', 'Monzo production config');
expectIncludes(monzoProductionConfig, 'workers_dev = false', 'Monzo production config');
expectIncludes(monzoProductionConfig, 'preview_urls = false', 'Monzo production config');
expectIncludes(monzoProductionConfig, 'pattern = "monzo.vishartattoo.com"', 'Monzo production config');
expectIncludes(monzoProductionConfig, '[[ratelimits]]', 'Monzo production config');
expectIncludes(monzoProductionConfig, 'MONZO_RECONCILIATION_ENABLED = "true"', 'Monzo production config');
expectLineAbsent(monzoProductionConfig, '[triggers]', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'crons', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'workers_dev = true', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'preview_urls = true', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'MONZO_RECONCILIATION_ENABLED = "false"', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'gwaliusblwrzisrwnsvs', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'monzo-staging', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'MONZO_OAUTH_CLIENT_SECRET', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'MONZO_TOKEN_ENCRYPTION_KEY', 'Monzo production config');
expectExcludes(monzoProductionConfig, 'SUPABASE_SECRET_KEY', 'Monzo production config');

console.log('Private production release workflow boundaries: passed');

// The Instagram connector is the only Worker that holds refreshable provider
// user tokens, so its release gate is checked for the properties that keep that
// store isolated: its own Worker, its own KV namespaces, no secret values in
// the workflow, and no reach into any other production surface.
const instagramConfig = directivesOf(read('wrangler.instagram.production.toml'));

expectIncludes(instagram, 'WORKER_NAME: vishar-instagram-production', 'Instagram connector');
expectIncludes(instagram, 'EXPOSE_PRIVATE_CRM_INSTAGRAM', 'Instagram connector');
expectIncludes(instagram, 'CRM_PRODUCTION_INSTAGRAM_DEPLOY_ENABLED', 'Instagram connector');
expectIncludes(instagram, 'generate-instagram-production-deploy-config.mjs', 'Instagram connector');
expectIncludes(instagram, 'npm run scan:secrets', 'Instagram connector');

// A release must never provision or print a credential, and must never reach
// another production surface from this gate.
for (const forbidden of [
  'wrangler secret put',
  'wrangler secret bulk',
  'wrangler kv namespace create',
  'supabase db push',
  'wrangler pages deploy',
  'wrangler.whatsapp',
  'wrangler.gmail',
  'wrangler.calendar',
  'wrangler.monzo',
]) {
  expectExcludes(instagram, forbidden, 'Instagram connector');
}

// The tracked template stays inert. Everything that makes the connector live is
// generated at release time from explicitly supplied, non-secret values.
expectIncludes(instagramConfig, 'name = "vishar-instagram-production"', 'Instagram production config');
expectIncludes(instagramConfig, 'main = "workers/instagram-production-entry.js"', 'Instagram production config');
expectIncludes(instagramConfig, 'workers_dev = false', 'Instagram production config');
expectIncludes(instagramConfig, 'preview_urls = false', 'Instagram production config');
expectIncludes(instagramConfig, 'pattern = "instagram.vishartattoo.com"', 'Instagram production config');
expectIncludes(instagramConfig, 'INSTAGRAM_OAUTH_ENABLED = "false"', 'Instagram production config');
expectIncludes(instagramConfig, 'INSTAGRAM_DRAIN_ENABLED = "false"', 'Instagram production config');
expectExcludes(instagramConfig, '[triggers]', 'Instagram production config');
expectExcludes(instagramConfig, '[[kv_namespaces]]', 'Instagram production config');
expectExcludes(instagramConfig, 'INSTAGRAM_APP_SECRET', 'Instagram production config');
expectExcludes(instagramConfig, 'SUPABASE_SECRET_KEY', 'Instagram production config');
expectLineAbsent(instagramConfig, 'workers_dev = true', 'Instagram production config');
