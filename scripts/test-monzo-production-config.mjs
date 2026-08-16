import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The production Monzo connector is deployed straight from its tracked
 * configuration, so that file is the security boundary and this suite is what
 * proves it. Every assertion here corresponds to a production guarantee that a
 * future edit could silently remove:
 *
 *   - only the opaque webhook path is publicly reachable;
 *   - reconciliation ships dormant and can never settle a payment;
 *   - the encrypted token store is bound to the production KV namespace and
 *     never to retained staging;
 *   - no provider credential, Supabase service key or encryption key is
 *     tracked in the repository.
 */

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

// Comments carry the rationale for these controls, so every structural check
// runs against directives only. A guarantee that exists only inside a comment
// is not a guarantee.
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
  assert.doesNotMatch(body, /workers_dev\s*=\s*true/);
  assert.doesNotMatch(body, /preview_urls\s*=\s*true/);
});

test('the entrypoint is the rate-limiting gateway, never the bare API Worker', () => {
  // workers/monzo-api.js has no limiter of its own. Deploying it directly would
  // expose an unthrottled public webhook path.
  assert.notEqual(value('main'), 'workers/monzo-api.js');
});

test('exactly one production Custom Domain is declared, with previews disabled', () => {
  const routes = body.match(/routes = \[[\s\S]*?\]/);
  assert.ok(routes, 'production routes must be declared so --strict can verify them');
  const patterns = [...routes[0].matchAll(/pattern = "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(patterns, ['monzo.vishartattoo.com']);
  assert.match(routes[0], /custom_domain = true/);
  assert.match(routes[0], /previews_enabled = false/);
  assert.match(routes[0], /zone_name = "vishartattoo\.com"/);
  assert.doesNotMatch(routes[0], new RegExp(RETAINED_STAGING.hostname.replace(/\./g, '\\.')));
});

test('nothing is scheduled', () => {
  assert.doesNotMatch(body, /\[triggers\]/);
  assert.doesNotMatch(body, /crons\s*=/);
});

test('reconciliation ships dormant', () => {
  assert.equal(value('MONZO_RECONCILIATION_ENABLED'), 'false');
});

test('the public webhook rate limiter is bound and isolated from other surfaces', () => {
  assert.match(body, /\[\[ratelimits\]\]/);
  const limiter = body.match(/\[\[ratelimits\]\][\s\S]*?simple = \{[^}]*\}/);
  assert.ok(limiter);
  assert.match(limiter[0], /name = "MONZO_WEBHOOK_RATE_LIMIT"/);
  const namespace = limiter[0].match(/namespace_id = "(\d+)"/);
  assert.ok(namespace, 'the limiter must declare a namespace id');
  assert.notEqual(namespace[1], RETAINED_STAGING.rateLimitNamespace);
  assert.notEqual(namespace[1], '1001'); // Calendar connector limiter
});

test('all three KV namespaces are bound to distinct production namespaces', () => {
  const bindings = [...body.matchAll(/binding = "(MONZO_[A-Z_]+)"\nid = "([0-9a-f]{32})"/g)]
    .map(([, binding, id]) => ({ binding, id }));
  assert.deepEqual(
    bindings.map((entry) => entry.binding).sort(),
    ['MONZO_OAUTH_STATE', 'MONZO_OAUTH_TOKENS', 'MONZO_WEBHOOK_ROUTES'],
  );
  const ids = bindings.map((entry) => entry.id);
  assert.equal(new Set(ids).size, 3, 'state, tokens and routes must not share a namespace');
  for (const id of ids) {
    assert.ok(
      ![RETAINED_STAGING.kvStateId, RETAINED_STAGING.kvTokensId, RETAINED_STAGING.kvRoutesId].includes(id),
      `refusing to bind the retained staging Monzo KV namespace ${id}`,
    );
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
  // The webhook bypass application must never be accepted as owner proof.
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

  // The Worker's own validator requires the exact `/#/payments` fragment.
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
    assert.doesNotMatch(
      body,
      new RegExp(`^${forbidden}\\s*=`, 'm'),
      `${forbidden} must be an encrypted Worker secret, never tracked configuration`,
    );
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
