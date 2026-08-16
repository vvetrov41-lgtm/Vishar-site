import assert from 'node:assert/strict';
import { __testing as workerTesting } from '../workers/monzo-api.js';
import { buildMonzoOAuthState, storeMonzoOAuthState } from '../workers/lib/monzo-oauth-security.js';
import { loadMonzoTokenRecord, saveMonzoTokenRecord, MonzoTokenError } from '../workers/lib/monzo-token-store.js';

class FakeKv {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value, options = undefined) {
    this.map.set(key, value);
    if (options) this.lastPutOptions = options;
  }
  async delete(key) { this.map.delete(key); }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

const accessKeys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', accessKeys.publicKey);
Object.assign(publicJwk, { kid: 'monzo-lifecycle-test', alg: 'RS256', use: 'sig' });

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-monzo-lifecycle.cloudflareaccess.com',
    aud: ['monzo-lifecycle-audience'],
    email: 'owner@example.test',
    iat: now - 10,
    exp: now + 600,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    accessKeys.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

const ownerJwt = await accessToken();
const certUrl = 'https://vishar-monzo-lifecycle.cloudflareaccess.com/cdn-cgi/access/certs';

function ownerRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Cf-Access-Jwt-Assertion', ownerJwt);
  headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  return new Request(url, { ...init, headers });
}

function makeEnv() {
  return {
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar-monzo-lifecycle.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-lifecycle-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-lifecycle',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
  };
}

function connectedRecord(overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'webhook_registered',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-lifecycle',
    userId: 'user_lifecycle_1',
    accessToken: 'old-access-synthetic',
    refreshToken: 'old-refresh-synthetic',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date(Date.now() - 60_000).toISOString(),
    accountId: 'acc_lifecycle1',
    accountLabel: 'Business Current Account',
    webhookKey: 'w'.repeat(48),
    webhookId: 'webhook_lifecycle1',
    webhookRegisteredAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  };
}

async function storeConnected(env, record = connectedRecord()) {
  await saveMonzoTokenRecord(env, record);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${record.webhookKey}`, JSON.stringify({
    alias: record.alias,
    artistId: record.artistId,
    providerAccountKey: record.providerAccountKey,
    accountId: record.accountId,
  }));
  return record;
}

function fetchRouter(routes = {}) {
  return async (input, options = {}) => {
    const url = String(input);
    if (url === certUrl) return Response.json({ keys: [publicJwk] });
    const route = routes[url];
    if (!route) throw new Error(`unexpected lifecycle fetch: ${url}`);
    return route(options);
  };
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

await test('same-user reauthorization preserves the selected account, route and registered webhook', async () => {
  const env = makeEnv();
  const previous = await storeConnected(env);
  const state = 's'.repeat(48);
  await storeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, buildMonzoOAuthState('vladimir', 'owner@example.test', env.MONZO_OAUTH_CLIENT_ID));
  const calls = [];

  const response = await workerTesting.oauthCallback(
    ownerRequest(`https://monzo.example.test/oauth/monzo/callback?state=${state}&code=reauth-code`),
    env,
    fetchRouter({
      'https://api.monzo.com/oauth2/token': async () => {
        calls.push('token');
        return Response.json({
          access_token: 'new-access-synthetic',
          client_id: env.MONZO_OAUTH_CLIENT_ID,
          expires_in: 21600,
          refresh_token: 'new-refresh-synthetic',
          token_type: 'Bearer',
          user_id: previous.userId,
        });
      },
      'https://api.monzo.com/ping/whoami': async () => {
        calls.push('whoami');
        return Response.json({ authenticated: true, client_id: env.MONZO_OAUTH_CLIENT_ID, user_id: previous.userId });
      },
    }),
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /[?&]monzo=connected(?:&|$)/);
  assert.match(response.headers.get('location'), /[?&]artist=vladimir(?:&|#|$)/);
  assert.deepEqual(calls, ['token', 'whoami']);

  const saved = await loadMonzoTokenRecord(env, previous.artistId);
  assert.equal(saved.accessToken, 'new-access-synthetic');
  assert.equal(saved.refreshToken, 'new-refresh-synthetic');
  assert.equal(saved.accountId, previous.accountId);
  assert.equal(saved.accountLabel, previous.accountLabel);
  assert.equal(saved.webhookKey, previous.webhookKey);
  assert.equal(saved.webhookId, previous.webhookId);
  assert.equal(saved.connectionState, 'webhook_registered');
  assert.equal(saved.connectedAt, previous.connectedAt);
  assert.ok(saved.reauthorizedAt);
  assert.deepEqual(
    await env.MONZO_WEBHOOK_ROUTES.get(`route:${previous.webhookKey}`, 'json'),
    {
      alias: previous.alias,
      artistId: previous.artistId,
      providerAccountKey: previous.providerAccountKey,
      accountId: previous.accountId,
    },
  );
});

await test('reauthorization with a different Monzo user is rejected without replacing the existing connection', async () => {
  const env = makeEnv();
  const previous = await storeConnected(env);
  const state = 'u'.repeat(48);
  await storeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, buildMonzoOAuthState('vladimir', 'owner@example.test', env.MONZO_OAUTH_CLIENT_ID));
  let logoutCalls = 0;

  await assert.rejects(
    workerTesting.oauthCallback(
      ownerRequest(`https://monzo.example.test/oauth/monzo/callback?state=${state}&code=wrong-user-code`),
      env,
      fetchRouter({
        'https://api.monzo.com/oauth2/token': async () => Response.json({
          access_token: 'other-access-synthetic',
          client_id: env.MONZO_OAUTH_CLIENT_ID,
          expires_in: 21600,
          refresh_token: 'other-refresh-synthetic',
          token_type: 'Bearer',
          user_id: 'user_other_2',
        }),
        'https://api.monzo.com/ping/whoami': async () => Response.json({
          authenticated: true,
          client_id: env.MONZO_OAUTH_CLIENT_ID,
          user_id: 'user_other_2',
        }),
        'https://api.monzo.com/oauth2/logout': async () => {
          logoutCalls += 1;
          return new Response(null, { status: 200 });
        },
      }),
    ),
    (error) => error?.code === 'monzo_user_mismatch' && error?.status === 409,
  );

  const saved = await loadMonzoTokenRecord(env, previous.artistId);
  assert.equal(saved.accessToken, previous.accessToken);
  assert.equal(saved.refreshToken, previous.refreshToken);
  assert.equal(saved.webhookId, previous.webhookId);
  assert.equal(logoutCalls, 1);
});

await test('disconnect is single-use, removes local authority and attempts provider cleanup', async () => {
  const env = makeEnv();
  const previous = await storeConnected(env);
  const providerCalls = [];
  const providerFetch = fetchRouter({
    'https://api.monzo.com/webhooks/webhook_lifecycle1': async (options) => {
      providerCalls.push(['webhook', options.method]);
      return new Response(null, { status: 200 });
    },
    'https://api.monzo.com/oauth2/logout': async (options) => {
      providerCalls.push(['logout', options.method]);
      return new Response(null, { status: 200 });
    },
  });

  const confirmation = await workerTesting.disconnect(
    ownerRequest('https://monzo.example.test/oauth/monzo/disconnect/vladimir'),
    'vladimir', env, providerFetch,
  );
  assert.equal(confirmation.status, 200);
  assert.match(confirmation.headers.get('content-security-policy'), /form-action 'self'/);
  const page = await confirmation.text();
  const token = page.match(/name="disconnect_token" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.match(token, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(env.MONZO_OAUTH_STATE.lastPutOptions.expirationTtl, 600);

  const form = new URLSearchParams({ confirm: 'disconnect', disconnect_token: token });
  const response = await workerTesting.disconnect(
    ownerRequest('https://monzo.example.test/oauth/monzo/disconnect/vladimir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
    'vladimir', env, providerFetch,
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /[?&]monzo=disconnected(?:&|$)/);
  assert.deepEqual(providerCalls, [['webhook', 'DELETE'], ['logout', 'POST']]);
  assert.equal(await env.MONZO_WEBHOOK_ROUTES.get(`route:${previous.webhookKey}`), null);
  await assert.rejects(
    loadMonzoTokenRecord(env, previous.artistId),
    (error) => error instanceof MonzoTokenError && error.code === 'monzo_not_connected',
  );

  await assert.rejects(
    workerTesting.disconnect(
      ownerRequest('https://monzo.example.test/oauth/monzo/disconnect/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      'vladimir', env, providerFetch,
    ),
    (error) => error?.code === 'disconnect_confirmation_invalid_or_expired',
  );
});

if (failures) {
  console.error(`Monzo connection lifecycle tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Monzo connection lifecycle tests: ${passes} passed, ${failures} failed`);
