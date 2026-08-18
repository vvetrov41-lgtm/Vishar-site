import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passes = 0;
let failures = 0;

function test(name, run) {
  try {
    run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const PRODUCTION_PATH = 'wrangler.monzo-api.production.toml';
const production = readFileSync(resolve(process.cwd(), PRODUCTION_PATH), 'utf8');
const dormant = readFileSync(resolve(process.cwd(), 'wrangler.monzo-api.toml'), 'utf8');
const directives = production
  .split(/\r?\n/)
  .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
  .filter(Boolean);
const body = directives.join('\n');

const RETAINED_STAGING = {
  supabaseUrl: 'https://gwaliusblwrzisrwnsvs.supabase.co',
  supabaseRef: 'gwaliusblwrzisrwnsvs',
  accessAud: 'aace3f92b458d0669564d0ee65ecc41fe488dca2ad2299b5dda8e4cabd46764e',
  webhookBypassAud: 'acbfc61aa59e59ba516e96aae1d0f7b532a078190303f643ebdc25516288bf84',
  kvStateId: '76104bcedcd74dbe8d532aac7e1914a6',
  kvTokensId: 'fe71d0fe80a84ef6b58efc4468f59ff1',
  kvRoutesId: '6589b018a5fa42478c0a2f5092676130',
  hostname: 'monzo-staging.vishartattoo.com',
  rateLimitNamespace: '1101',
};

const value = (name) => {
  const match = body.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"$`, 'm'));
  return match ? match[1] : null;
};

test('the production Worker is dedicated, isolated and has no developer surface', () => {
  assert.equal(value('name'), 'vishar-monzo-api-production');
  assert.equal(value('main'), 'workers/monzo-api-gateway.js');
  assert.match(body, /^workers_dev = false$/m);
  assert.match(body, /^preview_urls = false$/m);
});

test('the entrypoint is the bounded gateway, never the bare API Worker', () => {
  assert.notEqual(value('main'), 'workers/monzo-api.js');
});

test('production routes are exactly two isolated Custom Domains', () => {
  const routes = body.match(/routes = \[[\s\S]*?\]/);
  assert.ok(routes, 'production routes must be declared so --strict can verify them');
  const patterns = [...routes[0].matchAll(/pattern = "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(patterns, [
    'monzo.vishartattoo.com',
    'pay.vishartattoo.com',
  ]);
  assert.equal((routes[0].match(/custom_domain = true/g) || []).length, 2);
  assert.equal((routes[0].match(/enabled = true/g) || []).length, 2);
  assert.equal((routes[0].match(/previews_enabled = false/g) || []).length, 2);
  assert.equal((routes[0].match(/zone_name = "vishartattoo\.com"/g) || []).length, 2);
  assert.doesNotMatch(routes[0], /vishartattoo\.com\/pay-by-bank-transfer/);
  assert.doesNotMatch(routes[0], new RegExp(RETAINED_STAGING.hostname.replace(/\./g, '\\.')));
});

test('nothing is scheduled', () => {
  assert.doesNotMatch(body, /\[triggers\]/);
  assert.doesNotMatch(body, /crons\s*=/);
});

test('candidate-only reconciliation is explicitly enabled in production', () => {
  assert.equal(value('MONZO_RECONCILIATION_ENABLED'), 'true');
});

test('webhook and payment redirect rate limiters are both bound and isolated', () => {
  const limiters = [...body.matchAll(/\[\[ratelimits\]\][\s\S]*?simple = \{[^}]*\}/g)].map((match) => match[0]);
  assert.equal(limiters.length, 2);
  const webhook = limiters.find((entry) => entry.includes('name = "MONZO_WEBHOOK_RATE_LIMIT"'));
  const payment = limiters.find((entry) => entry.includes('name = "PAYMENT_REDIRECT_RATE_LIMIT"'));
  assert.ok(webhook);
  assert.ok(payment);
  const webhookNamespace = webhook.match(/namespace_id = "(\d+)"/);
  const paymentNamespace = payment.match(/namespace_id = "(\d+)"/);
  assert.ok(webhookNamespace);
  assert.ok(paymentNamespace);
  assert.notEqual(webhookNamespace[1], RETAINED_STAGING.rateLimitNamespace);
  assert.notEqual(webhookNamespace[1], '1001');
  assert.notEqual(paymentNamespace[1], webhookNamespace[1]);
  assert.notEqual(paymentNamespace[1], '1001');
});

test('all three KV namespaces are bound to distinct production namespaces', () => {
  const bindings = [...body.matchAll(/binding = "(MONZO_[A-Z_]+)"\nid = "([0-9a-f]{32})"/g)]
    .map(([, binding, id]) => ({ binding, id }));
  assert.deepEqual(
    bindings.map((entry) => entry.binding).sort(),
    ['MONZO_OAUTH_STATE', 'MONZO_OAUTH_TOKENS', 'MONZO_WEBHOOK_ROUTES'],
  );
  const ids = bindings.map((entry) => entry.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) {
    assert.ok(![RETAINED_STAGING.kvStateId, RETAINED_STAGING.kvTokensId, RETAINED_STAGING.kvRoutesId].includes(id));
  }
});

test('production targets production Supabase, never retained staging', () => {
  const supabase = value('SUPABASE_URL');
  assert.match(supabase, /^https:\/\/[a-z0-9]{20}\.supabase\.co$/);
  assert.notEqual(supabase, RETAINED_STAGING.supabaseUrl);
  assert.ok(!supabase.includes(RETAINED_STAGING.supabaseRef));
});

test('owner Access is pinned to the production application, never the staging one', () => {
  assert.equal(value('MONZO_ACCESS_TEAM_DOMAIN'), 'https://vishar-site-pages.cloudflareaccess.com');
  const aud = value('MONZO_ACCESS_AUD');
  assert.match(aud, /^[0-9a-f]{64}$/);
  assert.notEqual(aud, RETAINED_STAGING.accessAud);
  assert.notEqual(aud, RETAINED_STAGING.webhookBypassAud);
  assert.ok(value('MONZO_OWNER_EMAILS').includes('@'));
});

test('every configured production URL is exact, HTTPS and on an owned host', () => {
  const redirect = new URL(value('MONZO_OAUTH_REDIRECT_URI'));
  assert.equal(redirect.protocol, 'https:');
  assert.equal(redirect.hostname, 'monzo.vishartattoo.com');
  assert.equal(redirect.pathname, '/oauth/monzo/callback');
  assert.equal(redirect.search, '');

  const webhookBase = new URL(value('MONZO_WEBHOOK_BASE_URL'));
  assert.equal(webhookBase.protocol, 'https:');
  assert.equal(webhookBase.hostname, 'monzo.vishartattoo.com');
  assert.equal(webhookBase.pathname, '/');

  const crmReturn = new URL(value('MONZO_CRM_RETURN_URL'));
  assert.equal(crmReturn.protocol, 'https:');
  assert.equal(crmReturn.hostname, 'crm.vishartattoo.com');
  assert.equal(crmReturn.pathname, '/');
  assert.equal(crmReturn.hash, '#/payments');
});

test('the two artists are independently routed', () => {
  const vladimir = value('VLADIMIR_ARTIST_ID');
  const kristina = value('KRISTINA_ARTIST_ID');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(vladimir, uuid);
  assert.match(kristina, uuid);
  assert.notEqual(vladimir, kristina);
});

test('no provider credential, service key or encryption key is tracked', () => {
  for (const forbidden of [
    'MONZO_OAUTH_CLIENT_ID',
    'MONZO_OAUTH_CLIENT_SECRET',
    'MONZO_TOKEN_ENCRYPTION_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    assert.doesNotMatch(body, new RegExp(`^${forbidden}\\s*=`, 'm'));
  }
});

test('the dormant template stays dormant and is not confused with production', () => {
  const dormantDirectives = dormant
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  assert.match(dormantDirectives, /^name = "vishar-monzo-api"$/m);
  assert.doesNotMatch(dormantDirectives, /routes\s*=/);
  assert.doesNotMatch(dormantDirectives, /\[\[kv_namespaces\]\]/);
  assert.doesNotMatch(dormantDirectives, /MONZO_RECONCILIATION_ENABLED\s*=\s*"true"/);
});

if (failures > 0) {
  console.error(`\n${failures} Monzo production config test(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`Monzo production config tests passed: ${passes} cases.`);
