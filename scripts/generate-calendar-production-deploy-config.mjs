/**
 * Builds the deployable production Calendar Wrangler configuration.
 *
 * The tracked `wrangler.calendar.production.toml` remains deliberately inert:
 * no cron trigger and `CALENDAR_DRAIN_ENABLED=false`. This activation layer
 * starts from that fail-closed baseline, injects only the pre-provisioned
 * production identifiers, then creates the deploy-only runtime configuration
 * with the exact five-minute scheduled drain enabled.
 *
 * Keeping the tracked baseline inert makes accidental direct deploys harmless,
 * while the generated artefact is fully validated before `wrangler --strict`
 * can change the live Worker. Future deployments from this activation head keep
 * the same active drain instead of silently reverting it.
 *
 * Usage: node scripts/generate-calendar-production-deploy-config.mjs <out-path>
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RETAINED_STAGING = {
  supabaseUrl: 'https://gwaliusblwrzisrwnsvs.supabase.co',
  supabaseRef: 'gwaliusblwrzisrwnsvs',
  accessAud: '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013',
  kvStateId: 'dd43224461504e898addeba5b7915142',
  kvTokensId: '93302bc4f35242c38358a16fcd4ab9a2',
};

const PRODUCTION_CALENDAR_HOST = 'calendar.vishartattoo.com';
const PRODUCTION_CALENDAR_ZONE = 'vishartattoo.com';
const PRODUCTION_DRAIN_CRON = '*/5 * * * *';
const TRACKED_ROUTE = `  { pattern = "${PRODUCTION_CALENDAR_HOST}", custom_domain = true }`;
const DEPLOY_ROUTE = `  { pattern = "${PRODUCTION_CALENDAR_HOST}", zone_name = "${PRODUCTION_CALENDAR_ZONE}", custom_domain = true, enabled = true, previews_enabled = false }`;

const fail = (message) => {
  throw new Error(message);
};

function directivesOf(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

export function readInputs(env = process.env) {
  const inputs = {
    supabaseUrl: (env.SUPABASE_URL || '').trim(),
    accessAud: (env.CALENDAR_ACCESS_AUD || '').trim(),
    kvStateId: (env.CALENDAR_KV_STATE_ID || '').trim(),
    kvTokensId: (env.CALENDAR_KV_TOKENS_ID || '').trim(),
  };

  for (const [name, value] of Object.entries(inputs)) {
    if (!value) fail(`${name} is not configured`);
  }

  let supabase;
  try {
    supabase = new URL(inputs.supabaseUrl);
  } catch {
    fail('SUPABASE_URL must be an absolute URL');
  }
  if (
    supabase.protocol !== 'https:'
    || !/^[a-z0-9]{20}\.supabase\.co$/.test(supabase.hostname)
    || supabase.pathname !== '/'
    || supabase.search
    || supabase.hash
    || supabase.username
    || supabase.password
    || supabase.origin !== inputs.supabaseUrl
  ) fail('SUPABASE_URL must be an exact hosted Supabase project root');
  if (
    inputs.supabaseUrl === RETAINED_STAGING.supabaseUrl
    || supabase.hostname.startsWith(`${RETAINED_STAGING.supabaseRef}.`)
  ) fail('Refusing to target the retained staging Supabase project');

  if (!/^[0-9a-f]{64}$/.test(inputs.accessAud)) {
    fail('CALENDAR_ACCESS_AUD must be a 64-character Access audience tag');
  }
  if (inputs.accessAud === RETAINED_STAGING.accessAud) {
    fail('Refusing to reuse the retained staging Calendar Access audience');
  }

  const stagingKv = new Set([RETAINED_STAGING.kvStateId, RETAINED_STAGING.kvTokensId]);
  for (const name of ['kvStateId', 'kvTokensId']) {
    if (!/^[0-9a-f]{32}$/.test(inputs[name])) {
      fail(`${name} must be a 32-character KV namespace id`);
    }
    if (stagingKv.has(inputs[name])) {
      fail(`Refusing to bind a retained staging Calendar KV namespace via ${name}`);
    }
  }
  if (inputs.kvStateId === inputs.kvTokensId) {
    fail('PKCE state and encrypted token envelopes must not share one KV namespace');
  }

  return inputs;
}

/**
 * The production Custom Domain was provisioned before the real runtime. With
 * `wrangler deploy --strict`, omitting `routes` is interpreted as a request to
 * remove that remote domain. Cloudflare also returns three canonical metadata
 * fields for an existing Custom Domain. The tracked config intentionally keeps
 * the human-reviewable minimal declaration; only the generated deploy artefact
 * is expanded to the exact remote representation.
 */
export function preserveExactRoute(source) {
  const arrays = [...source.matchAll(/^routes\s*=\s*\[\s*\n([\s\S]*?)^\]\s*$/gm)];
  if (arrays.length !== 1) {
    fail('Generated deploy config must preserve exactly one production Custom Domain route array');
  }

  const entries = arrays[0][1].match(/\{[^}]*\}/g) || [];
  if (entries.length !== 1) {
    fail('Generated deploy config must preserve exactly one production Custom Domain route');
  }

  if (entries[0].trim() !== TRACKED_ROUTE.trim()) {
    fail('Generated deploy config lost the exact production Custom Domain');
  }

  const normalized = source.replace(TRACKED_ROUTE, DEPLOY_ROUTE);
  if (normalized === source || (normalized.match(new RegExp(PRODUCTION_CALENDAR_HOST.replaceAll('.', '\\.'), 'g')) || []).length !== 2) {
    fail('Generated deploy config could not normalize the production Custom Domain metadata');
  }

  return `${normalized.trimEnd()}\n`;
}

/**
 * Activation is permitted only from the tracked inert baseline. A canonical
 * config that is already enabled, already scheduled, or otherwise drifted is
 * refused so the activation diff remains explicit and reviewable.
 *
 * The two legacy error strings below are retained deliberately because the
 * production validation harness asserts that the generator still proves the
 * inert baseline before it is allowed to activate it.
 */
export function activateScheduledDrain(source) {
  const active = directivesOf(source);
  if ((active.match(/^CALENDAR_DRAIN_ENABLED\s*=\s*"false"$/gm) || []).length !== 1) {
    fail('Generated deploy config lost the disabled Calendar drain');
  }
  if (/^\[triggers\]$/m.test(active) || /^crons\s*=/m.test(active)) {
    fail('Generated deploy config must declare no cron trigger');
  }

  const withDrain = source.replace(
    'CALENDAR_DRAIN_ENABLED = "false"',
    'CALENDAR_DRAIN_ENABLED = "true"',
  );
  if (withDrain === source) {
    fail('Could not activate the production Calendar drain from the inert baseline');
  }

  const limiterMarker = '[[ratelimits]]';
  if ((source.match(/^\[\[ratelimits\]\]$/gm) || []).length !== 1) {
    fail('Production Calendar activation requires exactly one isolated rate limiter');
  }
  const activated = withDrain.replace(
    limiterMarker,
    `[triggers]\ncrons = ["${PRODUCTION_DRAIN_CRON}"]\n\n${limiterMarker}`,
  );
  if (activated === withDrain) {
    fail('Could not add the production Calendar cron trigger');
  }

  return `${activated.trimEnd()}\n`;
}

export function buildDeployConfig(canonical, inputs) {
  const withExactRoute = preserveExactRoute(canonical);
  const activatedCanonical = activateScheduledDrain(withExactRoute);

  // The injected variables are appended as bare key/value pairs, so they belong
  // to whichever table is open at the end of the file. Assert that `[vars]` is
  // still the last table after activation; the cron is intentionally inserted
  // before the rate limiter and `[vars]` sections.
  const tables = [...activatedCanonical.matchAll(/^\s*(\[\[?[^\]]+\]\]?)\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith('#'));
  if (tables[tables.length - 1] !== '[vars]') {
    fail('`[vars]` must be the final table in the canonical production config');
  }

  const text = `${activatedCanonical}
SUPABASE_URL = "${inputs.supabaseUrl}"
CALENDAR_ACCESS_AUD = "${inputs.accessAud}"

[[kv_namespaces]]
binding = "CALENDAR_OAUTH_STATE"
id = "${inputs.kvStateId}"

[[kv_namespaces]]
binding = "CALENDAR_OAUTH_TOKENS"
id = "${inputs.kvTokensId}"
`;

  const active = directivesOf(text);

  const routeLines = active
    .split('\n')
    .filter((line) => line.includes('pattern = "calendar.vishartattoo.com"'));
  if (routeLines.length !== 1 || routeLines[0] !== DEPLOY_ROUTE.trim()) {
    fail('Generated deploy config lost the exact production Custom Domain');
  }
  if ((active.match(/^CALENDAR_DRAIN_ENABLED\s*=\s*"true"$/gm) || []).length !== 1) {
    fail('Generated deploy config lost the enabled Calendar drain');
  }
  if ((active.match(/^\[triggers\]$/gm) || []).length !== 1) {
    fail('Generated deploy config must declare exactly one cron trigger table');
  }
  if ((active.match(/^crons\s*=\s*\["\*\/5 \* \* \* \*"\]$/gm) || []).length !== 1) {
    fail('Generated deploy config lost the exact five-minute Calendar cron');
  }
  if ((active.match(/^crons\s*=/gm) || []).length !== 1) {
    fail('Generated deploy config must declare exactly one cron schedule');
  }
  if (!/^workers_dev\s*=\s*false$/m.test(active)) {
    fail('workers.dev must remain disabled in deploy config');
  }
  if (!/^preview_urls\s*=\s*false$/m.test(active)) {
    fail('preview URLs must remain disabled in deploy config');
  }
  if (!/^\[\[ratelimits\]\]$/m.test(active)) {
    fail('Generated deploy config lost the isolated Worker rate limiter');
  }
  if (/pages\.dev/i.test(active) || /[a-z0-9-]+-staging\.vishartattoo\.com/i.test(active)) {
    fail('Generated deploy config must not reference a staging or pages.dev origin');
  }

  return text;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('Usage: node scripts/generate-calendar-production-deploy-config.mjs <out-path>');
    process.exit(1);
  }
  const canonical = readFileSync(resolve(process.cwd(), 'wrangler.calendar.production.toml'), 'utf8');
  const resolved = resolve(process.cwd(), outPath);
  writeFileSync(resolved, buildDeployConfig(canonical, readInputs()), 'utf8');
  chmodSync(resolved, 0o600);
  console.log(`Generated production Calendar deploy configuration at ${outPath}`);
}
