import assert from 'node:assert/strict';
import { __testing as workerTesting } from '../workers/monzo-api.js';
import {
  buildMonzoOAuthState,
  storeMonzoOAuthState,
} from '../workers/lib/monzo-oauth-security.js';
import {
  loadMonzoTokenRecord,
  saveMonzoTokenRecord,
  MonzoTokenError,
} from '../workers/lib/monzo-token-store.js';

class FakeKv {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
Object.assign(publicJwk, { kid: 'monzo-rollback-test', alg: 'RS256', use: 'sig' });

async function ownerToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-monzo-rollback.cloudflareaccess.com',
    aud: ['monzo-rollback-audience'],
    email: 'owner@example.test',
    iat: now - 10,
    exp: now + 600,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keys.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

const jwt = await ownerToken();

function ownerRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Cf-Access-Jwt-Assertion', jwt);
  headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  return new Request(url, { ...init, headers });
}

function env() {
  return {
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar-monzo-rollback.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-rollback-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-rollback-test',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo-oauth.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
  };
}

function record(overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'account_selected',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-rollback-test',
    userId: 'user_rollback_1',
    accessToken: 'old-access-test',
    refreshToken: 'old-refresh-test',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date().toISOString(),
    accountId: 'acc_old123',
    accountLabel: 'Old Account',
    webhookKey: 'r'.repeat(48),
    webhookId: null,
    ...overrides,
  };
}

function fetcher(routes = {}) {
  return async (input, options = {}) => {
    const url = String(input);
    if (url === 'https://vishar-monzo-rollback.cloudflareaccess.com/cdn-cgi/access/certs') {
      return Response.json({ keys: [publicJwk] });
    }
    if (routes[url]) return routes[url](options);
    throw new Error(`unexpected rollback test fetch: ${url}`);
  };
}

async function oauthPersistenceFailureFailsClosed() {
  const e = env();
  const previous = record();
  await saveMonzoTokenRecord(e, previous);
  await e.MONZO_WEBHOOK_ROUTES.put(`route:${previous.webhookKey}`, JSON.stringify({
    alias: previous.alias,
    artistId: previous.artistId,
    providerAccountKey: previous.providerAccountKey,
    accountId: previous.accountId,
  }));
  const state = 'o'.repeat(48);
  await storeMonzoOAuthState(
    e.MONZO_OAUTH_STATE,
    state,
    buildMonzoOAuthState('vladimir', 'owner@example.test', e.MONZO_OAUTH_CLIENT_ID),
  );

  const originalPut = e.MONZO_OAUTH_TOKENS.put.bind(e.MONZO_OAUTH_TOKENS);
  let failOnce = true;
  e.MONZO_OAUTH_TOKENS.put = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic token KV write failure');
    }
    return originalPut(...args);
  };
  let logoutCalls = 0;

  await assert.rejects(
    workerTesting.oauthCallback(
      ownerRequest(`https://monzo-oauth.example.test/oauth/monzo/callback?state=${state}&code=new-code-test`),
      e,
      fetcher({
        'https://api.monzo.com/oauth2/token': async () => Response.json({
          access_token: 'new-access-test',
          client_id: e.MONZO_OAUTH_CLIENT_ID,
          expires_in: 21600,
          refresh_token: 'new-refresh-test',
          token_type: 'Bearer',
          user_id: previous.userId,
        }),
        'https://api.monzo.com/ping/whoami': async () => Response.json({
          authenticated: true,
          client_id: e.MONZO_OAUTH_CLIENT_ID,
          user_id: previous.userId,
        }),
        'https://api.monzo.com/oauth2/logout': async () => {
          logoutCalls += 1;
          return new Response(null, { status: 200 });
        },
      }),
    ),
    /synthetic token KV write failure/,
  );

  await assert.rejects(
    loadMonzoTokenRecord(e, previous.artistId),
    (error) => error instanceof MonzoTokenError && error.code === 'monzo_not_connected',
  );
  assert.equal(await e.MONZO_WEBHOOK_ROUTES.get(`route:${previous.webhookKey}`), null);
  assert.equal(logoutCalls, 1);
}

async function accountRouteRollback() {
  const e = env();
  const previous = record();
  await saveMonzoTokenRecord(e, previous);
  const key = `route:${previous.webhookKey}`;
  const oldRoute = {
    alias: 'vladimir',
    artistId: previous.artistId,
    providerAccountKey: previous.providerAccountKey,
    accountId: previous.accountId,
  };
  await e.MONZO_WEBHOOK_ROUTES.put(key, JSON.stringify(oldRoute));

  const originalPut = e.MONZO_WEBHOOK_ROUTES.put.bind(e.MONZO_WEBHOOK_ROUTES);
  let failOnce = true;
  e.MONZO_WEBHOOK_ROUTES.put = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic route KV write failure');
    }
    return originalPut(...args);
  };

  await assert.rejects(
    workerTesting.selectAccount(
      ownerRequest(
        'https://monzo-oauth.example.test/oauth/monzo/select-account/vladimir',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: 'acc_new456' }),
        },
      ),
      'vladimir',
      e,
      fetcher({
        'https://api.monzo.com/accounts': async () => Response.json({ accounts: [
          { id: previous.accountId, description: previous.accountLabel },
          { id: 'acc_new456', description: 'New Account' },
        ] }),
      }),
    ),
    /synthetic route KV write failure/,
  );

  const restored = await loadMonzoTokenRecord(e, previous.artistId);
  assert.equal(restored.accountId, previous.accountId);
  assert.equal(restored.accountLabel, previous.accountLabel);
  assert.deepEqual(await e.MONZO_WEBHOOK_ROUTES.get(key, 'json'), oldRoute);
}

await oauthPersistenceFailureFailsClosed();
await accountRouteRollback();
console.log('Monzo rollback tests passed: 2 cases.');
