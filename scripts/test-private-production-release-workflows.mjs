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
expectIncludes(team, 'node scripts/test-team-admin-worker.mjs', 'Team admin');
expectIncludes(team, 'npm run check:team-admin-bundle', 'Team admin');
expectIncludes(team, "'DEPLOY_PRIVATE_CRM_TEAM_ADMIN'", 'Team admin');
expectIncludes(team, 'wrangler secret list', 'Team admin');
expectIncludes(team, "names.has('SUPABASE_SECRET_KEY')", 'Team admin');
expectIncludes(team, '--config wrangler.team-admin.toml', 'Team admin');
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

console.log('Private production release workflow boundaries: passed');
