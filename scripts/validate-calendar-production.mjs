import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const deployReady = process.argv.includes('--deploy-ready');
const configPath = resolve(process.cwd(), 'wrangler.calendar.production.toml');
const source = readFileSync(configPath, 'utf8');
const workflowPath = resolve(
  process.cwd(),
  '.github/workflows/deploy-private-production-calendar.yml',
);
const workflow = readFileSync(workflowPath, 'utf8');

// Retained staging values. Every one of these must be absent from the
// production configuration. They are listed explicitly rather than matched by
// a loose "staging" substring so that a renamed staging resource cannot quietly
// pass, and so a reviewer can see exactly what is being excluded.
const RETAINED_STAGING = {
  supabaseRef: 'gwaliusblwrzisrwnsvs',
  supabaseUrl: 'https://gwaliusblwrzisrwnsvs.supabase.co',
  calendarHost: 'calendar-staging.vishartattoo.com',
  accessAud: '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013',
  kvStateId: 'dd43224461504e898addeba5b7915142',
  kvTokensId: '93302bc4f35242c38358a16fcd4ab9a2',
  workerName: 'vishar-calendar-staging',
};

// Assertions about a TOML file must describe its directives, not its prose, so
// that an explanatory comment can neither satisfy nor fail a check meant to be
// about actual configuration. The `#` inside the CRM hash routes is preceded by
// `/` rather than whitespace or line start, so it survives this.
const active = source
  .split(/\r?\n/)
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean)
  .join('\n');

function exactValue(key) {
  const match = active.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, 'm'));
  return match?.[1] ?? null;
}

function crmUrl(key, allowedHashes) {
  const value = exactValue(key);
  assert.ok(value, `${key} is required`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${key} must use HTTPS`);
  assert.equal(url.hostname, 'crm.vishartattoo.com', `${key} must target the private CRM origin`);
  assert.equal(url.pathname, '/', `${key} must preserve the hash-router root path`);
  assert.equal(url.username, '', `${key} must not contain credentials`);
  assert.equal(url.password, '', `${key} must not contain credentials`);
  assert.equal(url.search, '', `${key} must not contain a committed query string`);
  assert.ok(allowedHashes.includes(url.hash), `${key} has an unexpected CRM hash route`);
  return url;
}

// --- Worker identity -------------------------------------------------------

assert.equal(exactValue('name'), 'vishar-calendar-production', 'unexpected Worker name');
assert.notEqual(exactValue('name'), RETAINED_STAGING.workerName, 'production must not reuse the staging Worker name');

const workerEntrypoint = exactValue('main');
assert.equal(workerEntrypoint, 'workers/calendar-oauth.js', 'unexpected Worker entrypoint');
assert.ok(
  existsSync(resolve(process.cwd(), workerEntrypoint)),
  'configured Calendar Worker entrypoint must exist in the exact checkout',
);

// --- No public exposure ----------------------------------------------------

assert.match(active, /^workers_dev\s*=\s*false$/m, 'workers.dev must remain disabled');
assert.match(active, /^preview_urls\s*=\s*false$/m, 'preview URLs must remain disabled');
assert.doesNotMatch(active, /^workers_dev\s*=\s*true$/m, 'workers.dev must never be enabled');
assert.doesNotMatch(active, /^preview_urls\s*=\s*true$/m, 'preview URLs must never be enabled');

// --- Doubly inert drain ----------------------------------------------------

assert.equal(
  exactValue('CALENDAR_DRAIN_ENABLED'),
  'false',
  'the initial production Calendar deployment must keep the drain disabled',
);
assert.doesNotMatch(active, /^\[triggers\]$/m, 'the initial production deployment must declare no cron triggers');
assert.doesNotMatch(active, /^crons\s*=/m, 'the initial production deployment must declare no cron schedule');

// --- Route -----------------------------------------------------------------

const routeMatches = [...active.matchAll(/\{\s*pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true\s*\}/g)];
assert.equal(routeMatches.length, 1, 'exactly one custom-domain route is required');
assert.equal(routeMatches[0][1], 'calendar.vishartattoo.com', 'unexpected production custom domain');
assert.doesNotMatch(active, /pattern\s*=\s*"\*/, 'wildcard routes are not permitted');

// --- Google OAuth ----------------------------------------------------------

const redirect = exactValue('GOOGLE_OAUTH_REDIRECT_URI');
assert.equal(
  redirect,
  'https://calendar.vishartattoo.com/oauth/google/callback',
  'production OAuth redirect URI must be exact',
);
const redirectUrl = new URL(redirect);
assert.equal(redirectUrl.protocol, 'https:', 'the OAuth redirect URI must use HTTPS');
assert.equal(redirectUrl.hostname, 'calendar.vishartattoo.com', 'the OAuth redirect URI host must be the production connector');
assert.equal(redirectUrl.search, '', 'the OAuth redirect URI must not carry a query string');
assert.equal(redirectUrl.hash, '', 'the OAuth redirect URI must not carry a fragment');
assert.ok(!redirect.includes('*'), 'wildcard Google redirect URIs are not permitted');
assert.ok(!/\/$/.test(redirect), 'the OAuth redirect URI must not have a trailing slash variant');

// --- CRM return targets ----------------------------------------------------

crmUrl('CRM_RETURN_URL', ['#/integrations/calendar']);
crmUrl('CRM_APPOINTMENTS_URL', ['#/appointments']);

// --- Owner access ----------------------------------------------------------

assert.equal(
  exactValue('CALENDAR_ACCESS_TEAM_DOMAIN'),
  'https://vishar-site-pages.cloudflareaccess.com',
  'unexpected Cloudflare Access team domain',
);
assert.equal(exactValue('CALENDAR_OWNER_EMAILS'), 'vvetrov41@gmail.com', 'unexpected Calendar owner allow-list');

// --- Artist routing --------------------------------------------------------
//
// Artist identity, expected Google account and event presentation are resolved
// per request from Supabase. A per-artist variable here would be a second copy
// of the access graph that silently drifts, and it would put onboarding an
// artist behind a Worker deployment.

const artistBinding = active.match(/^\s*([A-Z][A-Z0-9_]*)_(ARTIST_ID|GOOGLE_EMAIL|GOOGLE_EVENT_[A-Z_]+)\s*=/m);
assert.equal(
  artistBinding,
  null,
  `per-artist Worker variables are not permitted: ${artistBinding?.[0]?.trim() ?? ''}`,
);

// --- Isolated Worker rate limiter ------------------------------------------

assert.match(active, /^\[\[ratelimits\]\]$/m, 'the production Worker must declare its own rate limiter');
assert.equal(
  (active.match(/^\[\[ratelimits\]\]$/gm) || []).length,
  1,
  'exactly one rate limiter binding is expected',
);
assert.match(active, /^name\s*=\s*"CALENDAR_RATE_LIMIT"$/m, 'the rate limiter binding name must be CALENDAR_RATE_LIMIT');
assert.match(active, /^namespace_id\s*=\s*"\d+"$/m, 'the rate limiter namespace id must be a positive-integer string');

const limiter = active.match(/^simple\s*=\s*\{\s*limit\s*=\s*(\d+)\s*,\s*period\s*=\s*(\d+)\s*\}$/m);
assert.ok(limiter, 'the rate limiter must declare an inline simple limit and period');
const limiterLimit = Number(limiter[1]);
const limiterPeriod = Number(limiter[2]);
assert.ok([10, 60].includes(limiterPeriod), 'the rate limiter period must be 10 or 60 seconds');
assert.ok(limiterLimit > 0 && limiterLimit <= 60, 'the rate limiter must stay tight enough to bound automation');

// --- Values that must be injected, never committed -------------------------
//
// The Cloudflare objects behind these do not exist yet. Committing a
// placeholder would produce a config that reads as deployable and is not, so
// the tracked file must not carry them at all.

assert.doesNotMatch(active, /^SUPABASE_URL\s*=/m, 'SUPABASE_URL must be injected from protected environment configuration');
assert.doesNotMatch(active, /^CALENDAR_ACCESS_AUD\s*=/m, 'CALENDAR_ACCESS_AUD must be injected from protected environment configuration');
assert.doesNotMatch(active, /^\[\[kv_namespaces\]\]$/m, 'KV namespace ids must be injected from protected environment configuration');

// --- Retained staging must never appear ------------------------------------

for (const [label, value] of Object.entries(RETAINED_STAGING)) {
  assert.ok(
    !source.includes(value),
    `production Calendar configuration must not reference retained staging ${label} (${value})`,
  );
}
assert.ok(!/pages\.dev/i.test(source), 'production Calendar configuration must not reference a pages.dev origin');
assert.ok(
  !/[a-z0-9-]+-staging\.vishartattoo\.com/i.test(source),
  'production Calendar configuration must not reference a staging hostname',
);

// --- Staging configuration must remain untouched ---------------------------

const stagingConfig = readFileSync(resolve(process.cwd(), 'wrangler.calendar.staging.toml'), 'utf8');
assert.ok(
  !stagingConfig.includes('[[ratelimits]]'),
  'retained staging must keep its existing controls and declare no rate limiter binding',
);
assert.ok(
  !stagingConfig.includes('calendar.vishartattoo.com') || stagingConfig.includes('calendar-staging.vishartattoo.com'),
  'retained staging must not adopt the production hostname',
);

// --- Deploy harness --------------------------------------------------------

if (deployReady) {
  const generatorPath = resolve(process.cwd(), 'scripts/generate-calendar-production-deploy-config.mjs');
  assert.ok(existsSync(generatorPath), 'the production deploy-config generator must exist');
  const generator = readFileSync(generatorPath, 'utf8');

  const requiredWorkflowFragments = [
    ['environment: crm-production', 'the deploy job must run in the protected crm-production environment'],
    ['release/private-crm-rc*', 'the workflow must only run from an approved release branch'],
    ['approved_sha', 'the workflow must pin an explicitly approved SHA'],
    ["'DEPLOY_PRIVATE_CRM_CALENDAR'", 'the workflow must require the exact Calendar approval phrase'],
    ['CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED', 'the workflow must require an explicit deploy-enabled flag'],
    ['npm run validate:calendar-production', 'the workflow must validate the production configuration'],
    ['npm run check:calendar-production-bundle', 'the workflow must compile the Worker before deploying'],
    ['npm run scan:secrets', 'the workflow must scan for committed secrets'],
    ['node scripts/test-calendar-rate-limit.mjs', 'the workflow must test the isolated rate limiter'],
    ['node scripts/test-calendar-production-config.mjs', 'the workflow must exercise the deploy-config generator, not merely grep it'],
    ['secret list --config wrangler.calendar.production.toml', 'the secret preflight must target the Calendar production config, not the root site config'],
    ['node scripts/generate-calendar-production-deploy-config.mjs', 'the workflow must build the deploy config through the tracked generator'],
    ['--dry-run', 'the workflow must compile the generated config before a live deploy'],
    ['--strict', 'the workflow must deploy strictly'],
  ];
  for (const [fragment, message] of requiredWorkflowFragments) {
    assert.ok(workflow.includes(fragment), message);
  }

  // Every retained-staging value must be named as a refusal somewhere in the
  // harness. The generator owns the injected values, the workflow owns the
  // environment inputs, so either file naming it satisfies the requirement.
  const harness = `${workflow}\n${generator}`;
  for (const [label, value] of Object.entries(RETAINED_STAGING)) {
    if (label === 'workerName' || label === 'calendarHost') continue;
    assert.ok(
      harness.includes(value),
      `the deploy harness must explicitly refuse retained staging ${label}`,
    );
  }

  const forbiddenWorkflowFragments = [
    ['wrangler pages deploy', 'the Calendar workflow must not deploy any Pages project'],
    ['supabase db push', 'the Calendar workflow must not apply migrations'],
    ['supabase db reset', 'the Calendar workflow must not reset any database'],
    ['wrangler secret put', 'the Calendar workflow must not write secrets'],
    ['wrangler secret bulk', 'the Calendar workflow must not write secrets'],
    ['wrangler kv namespace create', 'the Calendar workflow must not create KV namespaces'],
    ['wrangler.calendar.staging.toml', 'the Calendar workflow must not touch retained staging configuration'],
    ['wrangler.team-admin', 'the Calendar workflow must not touch the Team admin Worker'],
    ['wrangler.telegram', 'the Calendar workflow must not touch the Telegram drain Worker'],
    ['rulesets', 'the Calendar workflow must not touch zone WAF or rate-limiting rules'],
    ['/accounts/', 'the Calendar workflow must not call the Cloudflare account API directly'],
  ];
  for (const [fragment, message] of forbiddenWorkflowFragments) {
    assert.ok(!workflow.includes(fragment), message);
  }

  // Flags are matched as flags rather than as substrings, so that a comment
  // explaining why a flag is absent cannot fail its own check.
  const forbiddenFlags = [
    [/(^|\s)--keep-vars(\s|$)/m, 'the Calendar workflow must own the full var set so the drain flag cannot drift'],
    [/(^|\s)--domain(\s|=)/m, 'the Calendar workflow must not create or change a Custom Domain'],
    [/(^|\s)--route(\s|=)/m, 'the Calendar workflow must not create or change a route'],
  ];
  const workflowCommands = workflow
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  for (const [pattern, message] of forbiddenFlags) {
    assert.doesNotMatch(workflowCommands, pattern, message);
  }

  assert.match(
    workflow,
    /deploy_config="\$GITHUB_WORKSPACE\/\.wrangler\.calendar\.production\.deploy\.toml"/,
    'the generated deploy config must stay in the checkout root so the relative main path resolves',
  );

  // The generator, not the workflow, owns the fail-closed guarantees. Assert
  // them where they actually live.
  const requiredGeneratorGuards = [
    ['Generated deploy config lost the exact production Custom Domain', 'the generator must preserve and re-check the exact pre-provisioned Custom Domain'],
    ['Generated deploy config lost the disabled Calendar drain', 'the generator must re-check the disabled drain after injection'],
    ['Generated deploy config must declare no cron trigger', 'the generator must re-check that no cron trigger is introduced'],
    ['Generated deploy config lost the isolated Worker rate limiter', 'the generator must re-check the rate limiter binding'],
    ['workers.dev must remain disabled in deploy config', 'the generator must re-check that workers.dev stays disabled'],
    ['preview URLs must remain disabled in deploy config', 'the generator must re-check that preview URLs stay disabled'],
    ['Refusing to target the retained staging Supabase project', 'the generator must refuse the retained staging Supabase project'],
    ['Refusing to reuse the retained staging Calendar Access audience', 'the generator must refuse the retained staging Access audience'],
    ['must not share one KV namespace', 'the generator must refuse a shared state/token KV namespace'],
  ];
  for (const [fragment, message] of requiredGeneratorGuards) {
    assert.ok(generator.includes(fragment), message);
  }
}

console.log(
  `Calendar production configuration: passed (${deployReady ? 'deploy-ready' : 'config-only'}; `
  + `limiter ${limiterLimit}/${limiterPeriod}s, drain disabled, no cron)`,
);
