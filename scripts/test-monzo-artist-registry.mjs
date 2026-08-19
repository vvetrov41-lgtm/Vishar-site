import assert from 'node:assert/strict';
import {
  MONZO_ARTIST_ALIASES,
  MONZO_ARTIST_REGISTRY,
  isMonzoArtistAlias,
  monzoAliasPathPattern,
  monzoArtistDisplayName,
  monzoArtistOAuthCredentials,
  monzoArtistOAuthEnv,
} from '../workers/lib/monzo-artist-registry.js';
import { artistMonzoConfig, monzoReadiness } from '../workers/lib/monzo-oauth-security.js';
import { MONZO_CONNECTOR_ALIASES } from './test-support/monzo-crm-aliases.mjs';

/**
 * Onboarding another Monzo artist must be a configuration change, not an
 * engineering project. These regressions prove:
 *
 *   - every routable artist comes from one registry, so no surface can know
 *     about an artist another surface does not;
 *   - no artist is a hardcoded default and no artist is a fallback;
 *   - the OAuth client is shared by default but already resolvable per artist,
 *     so a future artist-specific client is configuration, not a rewrite;
 *   - a half-configured per-artist OAuth override fails closed instead of
 *     mixing one artist's client id with another's secret.
 */

const VLADIMIR_ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ARTIST_ID = 'a2222222-2222-4222-8222-222222222222';

function baseEnv() {
  return {
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-shared',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-shared-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-audience',
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_OAUTH_STATE: {},
    MONZO_OAUTH_TOKENS: {},
    MONZO_WEBHOOK_ROUTES: {},
    VLADIMIR_ARTIST_ID,
    KRISTINA_ARTIST_ID,
  };
}

let passes = 0;
let failures = 0;
function test(name, run) {
  try {
    run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
  }
}

test('the registry is the single list of routable artists', () => {
  assert.deepEqual([...MONZO_ARTIST_ALIASES], ['vladimir', 'kristina']);
  assert.equal(monzoAliasPathPattern(), '(vladimir|kristina)');

  // Both the Worker route pattern and the CRM launcher must agree, otherwise
  // an artist becomes reachable in one surface and invisible in the other.
  assert.deepEqual([...MONZO_CONNECTOR_ALIASES], [...MONZO_ARTIST_ALIASES]);

  for (const alias of MONZO_ARTIST_ALIASES) {
    assert.ok(isMonzoArtistAlias(alias));
    assert.ok(monzoArtistDisplayName(alias));
  }
  assert.equal(isMonzoArtistAlias('someone-else'), false);
  assert.equal(monzoArtistDisplayName('someone-else'), '');

  // Every entry names its own bindings; none of them is shared with another
  // artist and none of them is a default.
  const bindings = MONZO_ARTIST_REGISTRY.flatMap((item) => [
    item.artistIdBinding,
    item.oauthClientIdBinding,
    item.oauthClientSecretBinding,
  ]);
  assert.equal(new Set(bindings).size, bindings.length);
});

test('every registered artist derives an independent scope', () => {
  const env = baseEnv();
  const configs = MONZO_ARTIST_ALIASES.map((alias) => artistMonzoConfig(alias, env));

  assert.equal(new Set(configs.map((c) => c.artistId)).size, configs.length);
  assert.equal(new Set(configs.map((c) => c.providerAccountKey)).size, configs.length);
  for (const config of configs) {
    assert.match(config.providerAccountKey, /^monzo_ebt_[0-9a-f]{32}$/i);
    assert.equal(config.providerAccountKey, `monzo_ebt_${config.artistId.replace(/-/g, '')}`);
  }
});

test('an unconfigured artist fails closed instead of borrowing another artist', () => {
  const env = baseEnv();
  for (const alias of MONZO_ARTIST_ALIASES) {
    const entry = MONZO_ARTIST_REGISTRY.find((item) => item.alias === alias);
    const missing = { ...env, [entry.artistIdBinding]: undefined };
    assert.throws(
      () => artistMonzoConfig(alias, missing),
      (error) => error.code === 'artist_route_unconfigured',
    );
  }
  assert.throws(
    () => artistMonzoConfig('someone-else', env),
    (error) => error.code === 'artist_route_unconfigured',
  );
});

test('the OAuth client is shared by default and artist-resolvable already', () => {
  const env = baseEnv();
  for (const alias of MONZO_ARTIST_ALIASES) {
    const credentials = monzoArtistOAuthCredentials(alias, env);
    assert.equal(credentials.scoped, false);
    assert.equal(credentials.clientId, 'oauth-client-shared');
    assert.equal(credentials.clientSecret, 'oauth-secret-shared-test');
    assert.equal(artistMonzoConfig(alias, env).oauthClientId, 'oauth-client-shared');
  }

  // A per-artist override is configuration only, and only for that artist.
  const scoped = {
    ...env,
    MONZO_OAUTH_CLIENT_ID_KRISTINA: 'oauth-client-kristina',
    MONZO_OAUTH_CLIENT_SECRET_KRISTINA: 'oauth-secret-kristina-test',
  };
  assert.equal(artistMonzoConfig('kristina', scoped).oauthClientId, 'oauth-client-kristina');
  assert.equal(artistMonzoConfig('vladimir', scoped).oauthClientId, 'oauth-client-shared');
  assert.equal(
    monzoArtistOAuthEnv('kristina', scoped).MONZO_OAUTH_CLIENT_SECRET,
    'oauth-secret-kristina-test',
  );
  assert.equal(
    monzoArtistOAuthEnv('vladimir', scoped).MONZO_OAUTH_CLIENT_SECRET,
    'oauth-secret-shared-test',
  );
});

test('a half-configured per-artist OAuth override fails closed', () => {
  const env = baseEnv();
  for (const half of [
    { MONZO_OAUTH_CLIENT_ID_KRISTINA: 'oauth-client-kristina' },
    { MONZO_OAUTH_CLIENT_SECRET_KRISTINA: 'oauth-secret-kristina-test' },
  ]) {
    const credentials = monzoArtistOAuthCredentials('kristina', { ...env, ...half });
    assert.equal(credentials.scoped, true);
    // Never mix one artist's client id with the shared secret, and never fall
    // back to the shared client id under an artist-specific secret.
    assert.equal(credentials.clientId, '');
    assert.equal(credentials.clientSecret, '');
    assert.equal(artistMonzoConfig('kristina', { ...env, ...half }).oauthClientId, '');
    // The other artist is untouched.
    assert.equal(
      artistMonzoConfig('vladimir', { ...env, ...half }).oauthClientId,
      'oauth-client-shared',
    );
  }
});

test('readiness reports artists only when every registered artist is distinct', () => {
  const env = baseEnv();
  assert.equal(monzoReadiness(env).configuration.artists, true);
  assert.equal(
    monzoReadiness({ ...env, KRISTINA_ARTIST_ID: undefined }).configuration.artists,
    false,
  );
  assert.equal(
    monzoReadiness({ ...env, KRISTINA_ARTIST_ID: VLADIMIR_ARTIST_ID }).configuration.artists,
    false,
  );
  // No secret or artist identifier leaves the readiness surface.
  const readiness = JSON.stringify(monzoReadiness(env));
  assert.ok(!readiness.includes('oauth-secret-shared-test'));
  assert.ok(!readiness.includes(VLADIMIR_ARTIST_ID));
  assert.ok(!readiness.includes(KRISTINA_ARTIST_ID));
});

if (failures) {
  console.error(`Monzo artist registry tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Monzo artist registry tests: ${passes} passed, ${failures} failed`);
