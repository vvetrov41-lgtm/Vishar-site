import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETAINED_CALENDAR = {
  accessAud: '2a0569d2cc1acb785ccf190585be7ca9cad70fe6db7042a8094bf39160a26013',
  kvStateId: 'dd43224461504e898addeba5b7915142',
  kvTokensId: '93302bc4f35242c38358a16fcd4ab9a2',
};

const REQUIRED_LINES = [
  'name = "vishar-monzo-api-staging"',
  'main = "workers/monzo-api-gateway.js"',
  'compatibility_date = "2026-08-01"',
  'workers_dev = false',
  'preview_urls = false',
  'name = "MONZO_WEBHOOK_RATE_LIMIT"',
  'namespace_id = "1101"',
  'simple = { limit = 60, period = 60 }',
  'VISHAR_ENVIRONMENT = "staging"',
  'MONZO_OAUTH_REDIRECT_URI = "https://monzo-staging.vishartattoo.com/oauth/monzo/callback"',
  'MONZO_CRM_RETURN_URL = "https://vishar-crm-staging.pages.dev/#/payments"',
  'MONZO_WEBHOOK_BASE_URL = "https://monzo-staging.vishartattoo.com"',
  'MONZO_ACCESS_TEAM_DOMAIN = "https://vishar-site-pages.cloudflareaccess.com"',
  'MONZO_OWNER_EMAILS = "vvetrov41@gmail.com"',
  'VLADIMIR_ARTIST_ID = "a1111111-1111-4111-8111-111111111111"',
  'KRISTINA_ARTIST_ID = "a2222222-2222-4222-8222-222222222222"',
  'SUPABASE_URL = "https://gwaliusblwrzisrwnsvs.supabase.co"',
  'MONZO_RECONCILIATION_ENABLED = "false"',
];

const FORBIDDEN_TRACKED_ASSIGNMENTS = [
  'MONZO_ACCESS_AUD',
  'MONZO_OAUTH_CLIENT_ID',
  'MONZO_OAUTH_CLIENT_SECRET',
  'MONZO_TOKEN_ENCRYPTION_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

function fail(message) {
  throw new Error(message);
}

function activeDirectives(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function countExactLine(active, expected) {
  return active.split('\n').filter((line) => line === expected).length;
}

function validatedActivationInputs(env) {
  const inputs = {
    accessAud: String(env.MONZO_ACCESS_AUD || '').trim(),
    kvStateId: String(env.MONZO_KV_STATE_ID || '').trim(),
    kvTokensId: String(env.MONZO_KV_TOKENS_ID || '').trim(),
    kvWebhookRoutesId: String(env.MONZO_KV_WEBHOOK_ROUTES_ID || '').trim(),
  };

  for (const [name, value] of Object.entries(inputs)) {
    if (!value) fail(`${name} is not configured`);
  }

  if (!/^[0-9a-f]{64}$/.test(inputs.accessAud)) {
    fail('MONZO_ACCESS_AUD must be a 64-character Access audience tag');
  }
  if (inputs.accessAud === RETAINED_CALENDAR.accessAud) {
    fail('Monzo staging must not reuse the Calendar staging Access audience');
  }

  const kvValues = [inputs.kvStateId, inputs.kvTokensId, inputs.kvWebhookRoutesId];
  for (const [name, value] of [
    ['MONZO_KV_STATE_ID', inputs.kvStateId],
    ['MONZO_KV_TOKENS_ID', inputs.kvTokensId],
    ['MONZO_KV_WEBHOOK_ROUTES_ID', inputs.kvWebhookRoutesId],
  ]) {
    if (!/^[0-9a-f]{32}$/.test(value)) {
      fail(`${name} must be a 32-character KV namespace id`);
    }
    if (value === RETAINED_CALENDAR.kvStateId || value === RETAINED_CALENDAR.kvTokensId) {
      fail(`${name} must not reuse a retained Calendar staging KV namespace`);
    }
  }
  if (new Set(kvValues).size !== kvValues.length) {
    fail('Monzo staging state, token and webhook-route KV namespaces must be distinct');
  }

  return inputs;
}

export function validateMonzoStagingConfig(source, options = {}) {
  const active = activeDirectives(source);
  const deployReady = options.deployReady === true;
  const env = options.env || process.env;

  for (const line of REQUIRED_LINES) {
    if (countExactLine(active, line) !== 1) {
      fail(`Monzo staging config must contain exactly one: ${line}`);
    }
  }

  if ((active.match(/^\[\[ratelimits\]\]$/gm) || []).length !== 1) {
    fail('Monzo staging config must declare exactly one isolated rate limiter');
  }
  if ((active.match(/^\[vars\]$/gm) || []).length !== 1) {
    fail('Monzo staging config must declare exactly one vars table');
  }

  if (/^routes?\s*=/m.test(active) || /^\[\[routes?\]\]$/m.test(active)) {
    fail('Tracked Monzo staging config must not declare a route or Custom Domain');
  }
  if (/^\[\[kv_namespaces\]\]$/m.test(active)) {
    fail('Tracked Monzo staging config must not contain KV namespace ids');
  }
  if (/^\[triggers\]$/m.test(active) || /^crons\s*=/m.test(active)) {
    fail('Monzo staging config must not declare scheduled triggers');
  }
  if (/^MONZO_RECONCILIATION_ENABLED\s*=\s*"true"$/m.test(active)) {
    fail('Tracked Monzo staging reconciliation must remain disabled');
  }

  for (const name of FORBIDDEN_TRACKED_ASSIGNMENTS) {
    if (new RegExp(`^${name}\\s*=`, 'm').test(active)) {
      fail(`${name} must not be committed in the tracked Monzo staging config`);
    }
  }

  if (/workers\.dev/i.test(active) || /preview_urls\s*=\s*true/i.test(active)) {
    fail('Monzo staging must not expose workers.dev or preview URLs');
  }

  const activation = deployReady ? validatedActivationInputs(env) : null;
  return {
    ok: true,
    deployReady,
    worker: 'vishar-monzo-api-staging',
    reconciliationEnabled: false,
    rateLimit: { limit: 60, period: 60, namespace: '1101' },
    activationIdentifiersPresent: Boolean(activation),
  };
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const source = readFileSync(resolve(process.cwd(), 'wrangler.monzo-api.staging.toml'), 'utf8');
  const result = validateMonzoStagingConfig(source, {
    deployReady: process.argv.includes('--deploy-ready'),
    env: process.env,
  });
  console.log(JSON.stringify(result));
}
