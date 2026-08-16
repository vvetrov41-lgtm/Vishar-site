import assert from 'node:assert/strict';
import { __testing as workerTesting } from '../workers/monzo-api.js';
import { loadMonzoTokenRecord, saveMonzoTokenRecord } from '../workers/lib/monzo-token-store.js';

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
Object.assign(publicJwk, { kid: 'monzo-activation-test', alg: 'RS256', use: 'sig' });

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-monzo-activation.cloudflareaccess.com',
    aud: ['monzo-activation-audience'],
    email: 'owner@example.test',
    iat: now - 10,
    exp: now + 600,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    accessKeys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function ownerRequest(token) {
  return new Request('https://monzo.example.test/oauth/monzo/register-webhook/vladimir', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Cf-Access-Authenticated-User-Email': 'owner@example.test',
    },
  });
}

function makeEnv() {
  return {
    VISHAR_ENVIRONMENT: 'test',
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar-monzo-activation.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-activation-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-synthetic',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
  };
}

function selectedRecord() {
  return {
    alias: 'vladimir',
    connectionState: 'account_selected',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-synthetic',
    userId: 'user_synthetic_1',
    accessToken: 'access-token-synthetic',
    refreshToken: 'refresh-token-synthetic',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date().toISOString(),
    accountId: 'acc_synthetic1',
    accountLabel: 'Synthetic Business Account',
    webhookKey: 'w'.repeat(48),
    webhookId: null,
  };
}

const certUrl = 'https://vishar-monzo-activation.cloudflareaccess.com/cdn-cgi/access/certs';
const jwt = await accessToken();
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

await test('selected account webhook registration is owner-only and stores only safe connection metadata', async () => {
  const env = makeEnv();
  const record = selectedRecord();
  await saveMonzoTokenRecord(env, record);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${record.webhookKey}`, JSON.stringify({
    alias: record.alias,
    artistId: record.artistId,
    providerAccountKey: record.providerAccountKey,
    accountId: record.accountId,
  }));

  const providerCalls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    if (url === certUrl) return Response.json({ keys: [publicJwk] });
    providerCalls.push({ url, options });
    if (url === 'https://api.monzo.com/ping/whoami') {
      return Response.json({ authenticated: true, client_id: record.clientId, user_id: record.userId });
    }
    if (url === 'https://api.monzo.com/accounts') {
      return Response.json({ accounts: [{ id: record.accountId, description: record.accountLabel }] });
    }
    if (url === 'https://api.monzo.com/webhooks') {
      const form = new URLSearchParams(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(form.get('account_id'), record.accountId);
      assert.equal(form.get('url'), `https://monzo.example.test/webhooks/monzo/${record.webhookKey}`);
      return Response.json({ webhook: {
        id: 'webhook_synthetic1',
        account_id: record.accountId,
        url: `https://monzo.example.test/webhooks/monzo/${record.webhookKey}`,
      } });
    }
    throw new Error(`unexpected provider call: ${url}`);
  };

  await assert.rejects(
    workerTesting.registerSelectedAccountWebhook(
      new Request('https://monzo.example.test/oauth/monzo/register-webhook/vladimir', { method: 'POST' }),
      'vladimir', env, fetchImpl,
    ),
    (error) => error?.code === 'owner_access_required',
  );

  const response = await workerTesting.registerSelectedAccountWebhook(ownerRequest(jwt), 'vladimir', env, fetchImpl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    artist: 'vladimir',
    state: 'connected',
    account_label: record.accountLabel,
    webhook_registered: true,
    replayed: false,
  });
  assert.equal(providerCalls.length, 3);

  const saved = await loadMonzoTokenRecord(env, record.artistId);
  assert.equal(saved.webhookId, 'webhook_synthetic1');
  assert.equal(saved.connectionState, 'connected');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(saved.accessToken));
  assert.ok(!serialized.includes(saved.refreshToken));
  assert.ok(!serialized.includes(saved.webhookKey));
  assert.ok(!serialized.includes(saved.accountId));

  providerCalls.length = 0;
  const replay = await workerTesting.registerSelectedAccountWebhook(ownerRequest(jwt), 'vladimir', env, fetchImpl);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(providerCalls.length, 0);
});

await test('route mismatch fails closed before any Monzo provider call', async () => {
  const env = makeEnv();
  const record = selectedRecord();
  await saveMonzoTokenRecord(env, record);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${record.webhookKey}`, JSON.stringify({
    alias: 'kristina',
    artistId: record.artistId,
    providerAccountKey: record.providerAccountKey,
    accountId: record.accountId,
  }));
  let providerCalls = 0;
  const fetchImpl = async (input) => {
    if (String(input) === certUrl) return Response.json({ keys: [publicJwk] });
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  await assert.rejects(
    workerTesting.registerSelectedAccountWebhook(ownerRequest(jwt), 'vladimir', env, fetchImpl),
    (error) => error?.code === 'provider_route_invalid',
  );
  assert.equal(providerCalls, 0);
});

if (failures) {
  console.error(`Monzo account activation tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Monzo account activation tests: ${passes} passed, ${failures} failed`);
