import assert from 'node:assert/strict';
import { handleMonzoSetup, __testing as setupTesting } from '../workers/lib/monzo-setup-flow.js';
import { loadMonzoTokenRecord, saveMonzoTokenRecord } from '../workers/lib/monzo-token-store.js';

class FakeKv {
  constructor() {
    this.map = new Map();
    this.putOptions = new Map();
  }
  async get(key, type) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value, options = undefined) {
    this.map.set(key, value);
    if (options) this.putOptions.set(key, options);
  }
  async delete(key) { this.map.delete(key); }
}

class RejectSetupStateKv {
  async get() { throw new Error('setup confirmation must not read Workers KV'); }
  async put() { throw new Error('setup confirmation must not write Workers KV'); }
  async delete() { throw new Error('setup confirmation must not delete Workers KV'); }
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
Object.assign(publicJwk, { kid: 'monzo-setup-test', alg: 'RS256', use: 'sig' });

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-monzo-setup.cloudflareaccess.com',
    aud: ['monzo-setup-audience'],
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
const certUrl = 'https://vishar-monzo-setup.cloudflareaccess.com/cdn-cgi/access/certs';

function ownerRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Cf-Access-Jwt-Assertion', ownerJwt);
  headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  return new Request(url, { ...init, headers });
}

function makeEnv() {
  return {
    VISHAR_ENVIRONMENT: 'test',
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar-monzo-setup.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-setup-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-setup',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
  };
}

function tokenRecord(overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'oauth_authorized',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-setup',
    userId: 'user_setup_1',
    accessToken: 'access-token-setup-synthetic',
    refreshToken: 'refresh-token-setup-synthetic',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date().toISOString(),
    accountId: null,
    accountLabel: null,
    webhookKey: 'w'.repeat(48),
    webhookId: null,
    ...overrides,
  };
}

function fetchRouter(routes = {}) {
  return async (input, options = {}) => {
    const url = String(input);
    if (url === certUrl) return Response.json({ keys: [publicJwk] });
    for (const [matcher, handler] of Object.entries(routes)) {
      if (matcher.endsWith('*') ? url.startsWith(matcher.slice(0, -1)) : url === matcher) {
        return handler(url, options);
      }
    }
    throw new Error(`unexpected setup fetch: ${url}`);
  };
}

function setupTokenFrom(page) {
  return page.match(/name="setup_token" value="([A-Za-z0-9_-]+)"/)?.[1];
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

await test('setup is owner-only and a disconnected artist gets only an exact OAuth start link', async () => {
  const env = makeEnv();
  await assert.rejects(
    handleMonzoSetup(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir'),
      'vladimir',
      env,
      fetchRouter(),
    ),
    (error) => error?.code === 'owner_access_required' && error?.status === 404,
  );

  const response = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir'),
    'vladimir',
    env,
    fetchRouter(),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  const page = await response.text();
  assert.match(page, /href="https:\/\/monzo[.]example[.]test\/oauth\/monzo\/start\/vladimir"/);
  assert.match(page, /href="https:\/\/crm[.]example[.]test\/#\/payments"/);
  assert.ok(!page.includes(env.MONZO_OAUTH_CLIENT_SECRET));
  assert.ok(!page.includes(env.MONZO_TOKEN_ENCRYPTION_KEY));
});

await test('approval-pending response shows SCA guidance and persists only safe encrypted connection state', async () => {
  const env = makeEnv();
  const record = tokenRecord();
  await saveMonzoTokenRecord(env, record);
  const response = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir'),
    'vladimir',
    env,
    fetchRouter({
      'https://api.monzo.com/ping/whoami': async () => Response.json({
        authenticated: true,
        client_id: record.clientId,
        user_id: record.userId,
      }),
      'https://api.monzo.com/accounts': async () => Response.json({ error: 'bad_request' }, { status: 403 }),
    }),
  );
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Approve access in the Monzo app/);
  assert.match(page, /PIN, Face ID or Touch ID/);
  assert.ok(!page.includes(record.accessToken));
  assert.ok(!page.includes(record.refreshToken));
  assert.ok(!page.includes(record.webhookKey));
  const saved = await loadMonzoTokenRecord(env, record.artistId);
  assert.equal(saved.connectionState, 'approval_pending');
});

await test('account selection uses an opaque owner-bound token without Workers KV read-after-write', async () => {
  const env = makeEnv();
  env.MONZO_OAUTH_STATE = new RejectSetupStateKv();
  const record = tokenRecord();
  await saveMonzoTokenRecord(env, record);
  const response = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir'),
    'vladimir',
    env,
    fetchRouter({
      'https://api.monzo.com/ping/whoami': async () => Response.json({
        authenticated: true,
        client_id: record.clientId,
        user_id: record.userId,
      }),
      'https://api.monzo.com/accounts': async () => Response.json({ accounts: [
        { id: 'acc_setup1', description: 'Business <Current> & Main' },
        { id: 'acc_setup2', description: 'Tax Pot' },
      ] }),
    }),
  );
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Business &lt;Current&gt; &amp; Main/);
  assert.ok(!page.includes('Business <Current> & Main'));
  const token = setupTokenFrom(page);
  assert.match(token, setupTesting.SETUP_TOKEN_PATTERN);
  assert.ok(!page.includes(record.accessToken));
  assert.ok(!page.includes(record.refreshToken));
  assert.ok(!page.includes(record.webhookKey));
  assert.ok(!page.includes(record.userId));
  assert.ok(!page.includes('owner@example.test'));
});

await test('setup confirmation is bound to owner, artist, client/user record and ten-minute lifetime', async () => {
  const env = makeEnv();
  const record = tokenRecord();
  const issuedAt = 1_800_000_000_000;
  const token = await setupTesting.createSetupConfirmationToken(
    env,
    'vladimir',
    'owner@example.test',
    record,
    issuedAt,
  );
  assert.match(token, setupTesting.SETUP_TOKEN_PATTERN);
  assert.equal(
    await setupTesting.verifySetupConfirmationToken(
      env,
      token,
      'vladimir',
      'owner@example.test',
      record,
      issuedAt + 30_000,
    ),
    true,
  );

  const last = token.at(-1);
  const tampered = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  for (const [candidate, alias, owner, candidateRecord, now] of [
    [tampered, 'vladimir', 'owner@example.test', record, issuedAt + 30_000],
    [token, 'vladimir', 'other-owner@example.test', record, issuedAt + 30_000],
    [token, 'kristina', 'owner@example.test', record, issuedAt + 30_000],
    [token, 'vladimir', 'owner@example.test', tokenRecord({ userId: 'user_setup_other' }), issuedAt + 30_000],
    [token, 'vladimir', 'owner@example.test', tokenRecord({ clientId: 'oauth-client-other' }), issuedAt + 30_000],
    [token, 'vladimir', 'owner@example.test', record, issuedAt + setupTesting.SETUP_TTL_SECONDS * 1000 + 1],
  ]) {
    await assert.rejects(
      setupTesting.verifySetupConfirmationToken(env, candidate, alias, owner, candidateRecord, now),
      (error) => error?.code === 'setup_confirmation_invalid_or_expired',
    );
  }
});

await test('POST revalidates the selected account, registers the exact callback and replay is harmless', async () => {
  const env = makeEnv();
  env.MONZO_OAUTH_STATE = new RejectSetupStateKv();
  const record = tokenRecord();
  await saveMonzoTokenRecord(env, record);
  const getResponse = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir'),
    'vladimir',
    env,
    fetchRouter({
      'https://api.monzo.com/ping/whoami': async () => Response.json({
        authenticated: true,
        client_id: record.clientId,
        user_id: record.userId,
      }),
      'https://api.monzo.com/accounts': async () => Response.json({ accounts: [
        { id: 'acc_setup1', description: 'Business Current Account' },
      ] }),
    }),
  );
  const getPage = await getResponse.text();
  const setupToken = setupTokenFrom(getPage);
  assert.match(setupToken, setupTesting.SETUP_TOKEN_PATTERN);

  let webhookCalls = 0;
  const providerFetch = fetchRouter({
    'https://api.monzo.com/ping/whoami': async () => Response.json({
      authenticated: true,
      client_id: record.clientId,
      user_id: record.userId,
    }),
    'https://api.monzo.com/accounts': async () => Response.json({ accounts: [
      { id: 'acc_setup1', description: 'Business Current Account' },
    ] }),
    'https://api.monzo.com/webhooks': async (_url, options) => {
      webhookCalls += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(form.get('account_id'), 'acc_setup1');
      assert.equal(form.get('url'), `https://monzo.example.test/webhooks/monzo/${record.webhookKey}`);
      return Response.json({ webhook: {
        id: 'webhook_setup1',
        account_id: 'acc_setup1',
        url: `https://monzo.example.test/webhooks/monzo/${record.webhookKey}`,
      } });
    },
  });
  const form = new URLSearchParams({ setup_token: setupToken, account_id: 'acc_setup1' });
  const response = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
    'vladimir',
    env,
    providerFetch,
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /[?&]monzo=connected(?:&|$)/);
  assert.match(response.headers.get('location'), /[?&]artist=vladimir(?:&|#|$)/);
  assert.equal(webhookCalls, 1);
  const saved = await loadMonzoTokenRecord(env, record.artistId);
  assert.equal(saved.connectionState, 'webhook_registered');
  assert.equal(saved.accountId, 'acc_setup1');
  assert.equal(saved.accountLabel, 'Business Current Account');
  assert.equal(saved.webhookId, 'webhook_setup1');

  const replay = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
    'vladimir',
    env,
    providerFetch,
  );
  assert.equal(replay.status, 303);
  assert.equal(webhookCalls, 1);
});

await test('forged account selection is rejected after provider revalidation and cannot register a webhook', async () => {
  const env = makeEnv();
  const record = tokenRecord();
  await saveMonzoTokenRecord(env, record);
  const getResponse = await handleMonzoSetup(
    ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir'),
    'vladimir', env,
    fetchRouter({
      'https://api.monzo.com/ping/whoami': async () => Response.json({ authenticated: true, client_id: record.clientId, user_id: record.userId }),
      'https://api.monzo.com/accounts': async () => Response.json({ accounts: [{ id: 'acc_setup1', description: 'Business Current Account' }] }),
    }),
  );
  const page = await getResponse.text();
  const setupToken = setupTokenFrom(page);
  assert.match(setupToken, setupTesting.SETUP_TOKEN_PATTERN);
  let webhookCalls = 0;
  const providerFetch = fetchRouter({
    'https://api.monzo.com/ping/whoami': async () => Response.json({ authenticated: true, client_id: record.clientId, user_id: record.userId }),
    'https://api.monzo.com/accounts': async () => Response.json({ accounts: [{ id: 'acc_setup1', description: 'Business Current Account' }] }),
    'https://api.monzo.com/webhooks': async () => {
      webhookCalls += 1;
      throw new Error('webhook must not be registered for an unverified account');
    },
  });
  await assert.rejects(
    handleMonzoSetup(
      ownerRequest('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ setup_token: setupToken, account_id: 'acc_forged999' }),
      }),
      'vladimir', env, providerFetch,
    ),
    (error) => error?.code === 'monzo_account_not_allowed',
  );
  assert.equal(webhookCalls, 0);
});

if (failures) {
  console.error(`Monzo setup flow tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Monzo setup flow tests: ${passes} passed, ${failures} failed`);