import assert from 'node:assert/strict';
import { __testing as workerTesting } from '../workers/monzo-api.js';
import { artistMonzoConfig } from '../workers/lib/monzo-oauth-security.js';
import { monzoTokenKey, saveMonzoTokenRecord } from '../workers/lib/monzo-token-store.js';

/**
 * Vladimir and Kristina must be independently routed with no global Monzo
 * fallback. These regressions prove the isolation that the other Monzo suites
 * only touch incidentally:
 *
 *   - each alias derives a distinct artist id, provider account key and
 *     encrypted-envelope storage key;
 *   - a connected artist never lends a credential to an unconnected one;
 *   - one artist's opaque webhook key never reconciles into the other's ledger;
 *   - a webhook route claiming the wrong artist fails closed before any
 *     provider call.
 */

class FakeKv {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

const accessKeys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', accessKeys.publicKey);
Object.assign(publicJwk, { kid: 'monzo-isolation-test', alg: 'RS256', use: 'sig' });

const TEAM_DOMAIN = 'https://vishar-monzo-isolation.cloudflareaccess.com';
const certUrl = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: TEAM_DOMAIN,
    aud: ['monzo-isolation-audience'],
    email: 'owner@example.test',
    iat: now - 10,
    exp: now + 600,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', accessKeys.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

const ownerJwt = await accessToken();

function ownerRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Cf-Access-Jwt-Assertion', ownerJwt);
  headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  return new Request(url, { ...init, headers });
}

const VLADIMIR_ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ARTIST_ID = 'a2222222-2222-4222-8222-222222222222';

function makeEnv() {
  return {
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    MONZO_ACCESS_AUD: 'monzo-isolation-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-isolation',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    MONZO_RECONCILIATION_ENABLED: 'true',
    SUPABASE_URL: 'https://synthetic-project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test-only',
    VLADIMIR_ARTIST_ID,
    KRISTINA_ARTIST_ID,
  };
}

function vladimirRecord(overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'webhook_registered',
    artistId: VLADIMIR_ARTIST_ID,
    providerAccountKey: artistMonzoConfig('vladimir', makeEnv()).providerAccountKey,
    clientId: 'oauth-client-isolation',
    userId: 'user_vladimir',
    accessToken: 'vladimir-access-synthetic',
    refreshToken: 'vladimir-refresh-synthetic',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date().toISOString(),
    accountId: 'acc_vladimir1',
    accountLabel: 'Vladimir Business Current Account',
    webhookKey: 'v'.repeat(48),
    webhookId: 'webhook_vladimir1',
    ...overrides,
  };
}

async function storeRoute(env, record) {
  await saveMonzoTokenRecord(env, record);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${record.webhookKey}`, JSON.stringify({
    alias: record.alias,
    artistId: record.artistId,
    providerAccountKey: record.providerAccountKey,
    accountId: record.accountId,
  }));
}

let passes = 0;
let failures = 0;
async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
  }
}

await test('each alias derives a distinct artist, provider account key and storage key', () => {
  const env = makeEnv();
  const vladimir = artistMonzoConfig('vladimir', env);
  const kristina = artistMonzoConfig('kristina', env);

  assert.notEqual(vladimir.artistId, kristina.artistId);
  assert.notEqual(vladimir.providerAccountKey, kristina.providerAccountKey);
  assert.notEqual(monzoTokenKey(vladimir.artistId), monzoTokenKey(kristina.artistId));

  // An unknown alias must not resolve to either artist.
  assert.throws(() => artistMonzoConfig('vladimir2', env), (error) => error.code === 'artist_route_unconfigured');
  assert.throws(() => artistMonzoConfig('', env), (error) => error.code === 'artist_route_unconfigured');

  // A missing artist id must fail closed rather than fall back.
  assert.throws(
    () => artistMonzoConfig('kristina', { ...env, KRISTINA_ARTIST_ID: undefined }),
    (error) => error.code === 'artist_route_unconfigured',
  );
});

await test('a connected artist never lends its credential to an unconnected one', async () => {
  const env = makeEnv();
  await storeRoute(env, vladimirRecord());

  const providerFetch = async (input) => {
    if (String(input) === certUrl) return Response.json({ keys: [publicJwk] });
    throw new Error('no provider call may be made for an unconnected artist');
  };

  // Kristina has no stored connection. Every owner surface must fail closed
  // rather than reach for Vladimir's envelope.
  const status = await workerTesting.connectionStatus(
    ownerRequest('https://monzo.example.test/oauth/monzo/status/kristina'),
    'kristina',
    env,
    providerFetch,
  );
  const body = await status.json();
  assert.equal(body.state, 'not_connected');
  assert.equal(body.webhook_registered, false);
  assert.equal(body.account_label, null);
  // Vladimir's account label must not leak through Kristina's status route.
  assert.ok(!JSON.stringify(body).includes('Vladimir'));

  await assert.rejects(
    workerTesting.listAccounts(
      ownerRequest('https://monzo.example.test/oauth/monzo/accounts/kristina'),
      'kristina',
      env,
      providerFetch,
    ),
    (error) => error.code === 'monzo_not_connected',
  );
});

await test("one artist's stored record cannot be served under the other alias", async () => {
  const env = makeEnv();
  const record = vladimirRecord();
  await storeRoute(env, record);

  // Simulate a mis-keyed envelope: Vladimir's record stored at Kristina's key.
  env.MONZO_OAUTH_TOKENS.map.set(
    monzoTokenKey(KRISTINA_ARTIST_ID),
    env.MONZO_OAUTH_TOKENS.map.get(monzoTokenKey(VLADIMIR_ARTIST_ID)),
  );

  await assert.rejects(
    workerTesting.connectionStatus(
      ownerRequest('https://monzo.example.test/oauth/monzo/status/kristina'),
      'kristina',
      env,
      async (input) => {
        if (String(input) === certUrl) return Response.json({ keys: [publicJwk] });
        throw new Error('no provider call may be made');
      },
    ),
    (error) => error.code === 'monzo_token_invalid' || error.code === 'provider_route_invalid',
  );
});

await test("a webhook on one artist's key never reconciles into the other artist", async () => {
  const env = makeEnv();
  const record = vladimirRecord();
  await storeRoute(env, record);

  const transaction = {
    id: 'tx_isolation1',
    account_id: record.accountId,
    amount: 25000,
    currency: 'GBP',
    created: '2026-08-16T10:00:00.000Z',
    is_load: false,
    scheme: 'payport_faster_payments',
  };

  let candidate = null;
  const providerFetch = async (input, options = {}) => {
    const url = String(input);
    if (url === certUrl) return Response.json({ keys: [publicJwk] });
    if (url === 'https://api.monzo.com/ping/whoami') {
      return Response.json({ authenticated: true, client_id: record.clientId, user_id: record.userId });
    }
    if (url === `https://api.monzo.com/transactions/${transaction.id}`) {
      assert.equal(options.headers.Authorization, `Bearer ${record.accessToken}`);
      return Response.json({ transaction });
    }
    if (url.startsWith('https://api.monzo.com/transactions?')) {
      assert.equal(new URL(url).searchParams.get('account_id'), record.accountId);
      return Response.json({ transactions: [transaction] });
    }
    if (url.endsWith('/rpc/register_monzo_reconciliation_candidate')) {
      candidate = JSON.parse(options.body);
      return Response.json({ status: 'candidate' });
    }
    throw new Error(`unexpected isolation fetch: ${url}`);
  };

  const response = await workerTesting.handleWebhook(
    new Request(`https://monzo.example.test/webhooks/monzo/${record.webhookKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The payload deliberately claims Kristina's provider account key shape.
      body: JSON.stringify({ type: 'transaction.created', data: { id: transaction.id } }),
    }),
    record.webhookKey,
    env,
    providerFetch,
  );

  assert.equal(response.status, 202);
  const kristina = artistMonzoConfig('kristina', env);
  assert.equal(candidate.p_provider_account_key, record.providerAccountKey);
  assert.notEqual(candidate.p_provider_account_key, kristina.providerAccountKey);
});

await test('a webhook route claiming the wrong artist fails closed before any provider call', async () => {
  const env = makeEnv();
  const record = vladimirRecord();
  await saveMonzoTokenRecord(env, record);

  // Route record poisoned to point at Kristina while the envelope is Vladimir's.
  const kristina = artistMonzoConfig('kristina', env);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${record.webhookKey}`, JSON.stringify({
    alias: 'kristina',
    artistId: kristina.artistId,
    providerAccountKey: kristina.providerAccountKey,
    accountId: record.accountId,
  }));

  let providerCalls = 0;
  const providerFetch = async (input) => {
    if (String(input) === certUrl) return Response.json({ keys: [publicJwk] });
    providerCalls += 1;
    throw new Error('provider must not be called for a poisoned route');
  };

  const response = await workerTesting.handleWebhook(
    new Request(`https://monzo.example.test/webhooks/monzo/${record.webhookKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transaction.created', data: { id: 'tx_isolation2' } }),
    }),
    record.webhookKey,
    env,
    providerFetch,
  ).catch((error) => error);

  // Kristina has no stored connection, so the route cannot be honoured.
  if (response instanceof Error) {
    assert.ok(['monzo_not_connected', 'provider_route_invalid'].includes(response.code), response.code);
  } else {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'provider_route_invalid');
  }
  assert.equal(providerCalls, 0);
});

if (failures) {
  console.error(`Monzo artist isolation tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Monzo artist isolation tests: ${passes} passed, ${failures} failed`);
