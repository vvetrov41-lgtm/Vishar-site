/**
 * Builds the deployable production Calendar Wrangler configuration.
 *
 * The tracked `wrangler.calendar.production.toml` is deliberately not
 * deployable: the production Supabase URL, the Access audience and the two KV
 * namespace ids name Cloudflare and Supabase objects that are provisioned
 * outside this repository, and committing placeholders would produce a config
 * that reads as deployable and is not.
 *
 * This script injects those values from already-validated environment
 * configuration and strips the dashboard-owned Custom Domain route, then
 * re-asserts every safety property on the generated artefact itself so that a
 * malformed input cannot smuggle a cron trigger, an enabled drain, public
 * exposure or a missing rate limiter past the canonical-config validation.
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

const fail = (message) => {
  throw new Error(message);
};

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
 * The production Custom Domain is provisioned once, outside the deployment.
 * `--strict` compares routes, so leaving the declared route in the deploy
 * config would read as "change the production route" on a domain the workflow
 * must never create or alter.
 */
export function stripRoutes(source) {
  const output = [];
  let skipping = false;
  let removed = false;
  for (const line of source.split(/\r?\n/)) {
    if (!skipping && /^routes\s*=\s*\[\s*$/.test(line)) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === ']') skipping = false;
      continue;
    }
    output.push(line);
  }
  if (skipping || !removed) {
    fail('Expected exactly one top-level routes array in the canonical production config');
  }
  const text = `${output.join('\n').trimEnd()}\n`;
  if (text.includes('custom_domain') || /^routes\s*=/m.test(text)) {
    fail('Dashboard-managed routes were not removed from deploy config');
  }
  return text;
}

export function buildDeployConfig(canonical, inputs) {
  const withoutRoutes = stripRoutes(canonical);

  // The injected variables are appended as bare key/value pairs, so they belong
  // to whichever table is open at the end of the file. Assert that `[vars]` is
  // the last table, otherwise a future section added after it would silently
  // capture the production Supabase URL and Access audience.
  const tables = [...withoutRoutes.matchAll(/^\s*(\[\[?[^\]]+\]\]?)\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith('#'));
  if (tables[tables.length - 1] !== '[vars]') {
    fail('`[vars]` must be the final table in the canonical production config');
  }

  const text = `${withoutRoutes}
SUPABASE_URL = "${inputs.supabaseUrl}"
CALENDAR_ACCESS_AUD = "${inputs.accessAud}"

[[kv_namespaces]]
binding = "CALENDAR_OAUTH_STATE"
id = "${inputs.kvStateId}"

[[kv_namespaces]]
binding = "CALENDAR_OAUTH_TOKENS"
id = "${inputs.kvTokensId}"
`;

  const active = text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

  if (!/^CALENDAR_DRAIN_ENABLED\s*=\s*"false"$/m.test(active)) {
    fail('Generated deploy config lost the disabled Calendar drain');
  }
  if (/^\[triggers\]$/m.test(active) || /^crons\s*=/m.test(active)) {
    fail('Generated deploy config must declare no cron trigger');
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
