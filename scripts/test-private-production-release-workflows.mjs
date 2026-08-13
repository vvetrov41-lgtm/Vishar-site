import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const expectIncludes = (text, needle, label) => {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const expectExcludes = (text, needle, label) => {
  if (text.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

const crm = read('.github/workflows/deploy-private-production-crm.yml');
const database = read('.github/workflows/deploy-private-production-database.yml');
const team = read('.github/workflows/deploy-private-production-team-admin.yml');
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
expectExcludes(teamProductionConfig, 'enabled = false', 'Team admin production config');
expectExcludes(teamProductionConfig, 'previews_enabled = true', 'Team admin production config');
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

console.log('Private production release workflow boundaries: passed');
