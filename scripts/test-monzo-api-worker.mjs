import assert from 'node:assert/strict';
import monzoWorker, { __testing as workerTesting } from '../workers/monzo-api.js';
import {
  ensureMonzoAccessToken,
  registerMonzoWebhook,
  verifyTransactionBelongsToAccount,
  MonzoApiError,
} from '../workers/lib/monzo-api-client.js';
import {
  buildMonzoOAuthState,
  consumeMonzoOAuthState,
  monzoCrmReturnUrl,
  monzoOAuthRedirectUri,
  monzoReadiness,
  storeMonzoOAuthState,
  MonzoSecurityError,
} from '../workers/lib/monzo-oauth-security.js';
import {
  decryptMonzoTokenRecord,
  encryptMonzoTokenRecord,
  loadMonzoTokenRecord,
  saveMonzoTokenRecord,
  MonzoTokenError,
} from '../workers/lib/monzo-token-store.js';
import { createMonzoSupabaseClient } from '../workers/lib/monzo-supabase.js';

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

class FakeKv {
  constructor(entries = []) {
    this.map = new Map(entries);
    this.putOptions = new Map();
    this.getCalls = 0;
  }

  async get(key, type) {
    this.getCalls += 1;
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    if (type === 'json') return JSON.parse(value);
    return value;
  }

  async put(key, value, options = undefined) {
    this.map.set(key, value);
    if (options) this.putOptions.set(key, options);
  }

  async delete(key) {
    this.map.delete(key);
  }
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
Object.assign(publicJwk, { kid: 'monzo-access-test', alg: 'RS256', use: 'sig' });

async function accessToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({
    alg: 'RS256',
    kid: publicJwk.kid,
    typ: 'JWT',
  }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-monzo-test.cloudflareaccess.com',
    aud: ['monzo-access-audience'],
    email: 'owner@example.test',
    iat: now - 10,
    exp: now + 600,
    ...overrides,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    accessKeys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function ownerRequest(url, token, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Cf-Access-Jwt-Assertion', token);
  headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  return new Request(url, { ...init, headers });
}

function tokenRecord(overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'oauth_authorized',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-synthetic',
    userId: 'user_synthetic_1',
    accessToken: 'access-token-synthetic',
    refreshToken: 'refresh-token-synthetic',
    expiresAt: Date.now() + 60 * 60 * 1000,
    connectedAt: new Date().toISOString(),
    accountId: null,
    accountLabel: null,
    webhookKey: 'w'.repeat(48),
    webhookId: null,
    ...overrides,
  };
}

function makeEnv() {
  return {
    VISHAR_ENVIRONMENT: 'test',
    MONZO_OWNER_EMAILS: 'owner@example.test',
    MONZO_ACCESS_TEAM_DOMAIN: 'https://vishar-monzo-test.cloudflareaccess.com',
    MONZO_ACCESS_AUD: 'monzo-access-audience',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-synthetic',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-synthetic',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo-oauth.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo-webhook.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    MONZO_OAUTH_STATE: new FakeKv(),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_WEBHOOK_ROUTES: new FakeKv(),
    MONZO_RECONCILIATION_ENABLED: 'false',
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
    SUPABASE_URL: 'https://synthetic-project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test-only',
  };
}

const certUrl = 'https://vishar-monzo-test.cloudflareaccess.com/cdn-cgi/access/certs';
function fetchRouter(routes = {}) {
  return async (input, options = {}) => {
    const url = String(input);
    if (url === certUrl) return Response.json({ keys: [publicJwk] });
    for (const [matcher, handler] of Object.entries(routes)) {
      if (matcher.endsWith('*') ? url.startsWith(matcher.slice(0, -1)) : url === matcher) {
        return handler(url, options);
      }
    }
    throw new Error(`unexpected synthetic fetch: ${url}`);
  };
}

const ownerJwt = await accessToken();

await test('Monzo token custody encrypts credentials and detects tampering', async () => {
  const env = makeEnv();
  const record = tokenRecord();
  const envelope = await encryptMonzoTokenRecord(record, env.MONZO_TOKEN_ENCRYPTION_KEY);
  assert.ok(!envelope.includes(record.accessToken));
  assert.ok(!envelope.includes(record.refreshToken));
  assert.deepEqual(
    await decryptMonzoTokenRecord(envelope, env.MONZO_TOKEN_ENCRYPTION_KEY),
    record,
  );

  const parsed = JSON.parse(envelope);
  parsed.data = `${parsed.data.slice(0, -1)}${parsed.data.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(
    decryptMonzoTokenRecord(JSON.stringify(parsed), env.MONZO_TOKEN_ENCRYPTION_KEY),
    (error) => error instanceof MonzoTokenError && error.code === 'monzo_token_invalid',
  );
});

await test('OAuth and CRM URLs are exact HTTPS configuration, never implicit fallbacks', () => {
  const env = makeEnv();
  assert.equal(
    monzoOAuthRedirectUri(env),
    'https://monzo-oauth.example.test/oauth/monzo/callback',
  );
  assert.equal(monzoCrmReturnUrl(env), 'https://crm.example.test/#/payments');
  assert.equal(monzoCrmReturnUrl({ ...env, MONZO_CRM_RETURN_URL: 'https://crm.example.test/' }), '');
  assert.equal(monzoOAuthRedirectUri({ ...env, MONZO_OAUTH_REDIRECT_URI: 'http://monzo-oauth.example.test/oauth/monzo/callback' }), '');
});

await test('OAuth start requires verified owner Access and stores one short-lived state without the client secret', async () => {
  const env = makeEnv();
  await assert.rejects(
    workerTesting.startOAuth(
      new Request('https://monzo-oauth.example.test/oauth/monzo/start/vladimir'),
      'vladimir',
      env,
      fetchRouter(),
    ),
    (error) => error.code === 'owner_access_required',
  );

  const response = await workerTesting.startOAuth(
    ownerRequest('https://monzo-oauth.example.test/oauth/monzo/start/vladimir', ownerJwt),
    'vladimir',
    env,
    fetchRouter(),
  );
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, 'https://auth.monzo.com');
  assert.equal(destination.searchParams.get('response_type'), 'code');
  assert.equal(destination.searchParams.get('client_id'), env.MONZO_OAUTH_CLIENT_ID);
  assert.equal(destination.searchParams.get('redirect_uri'), env.MONZO_OAUTH_REDIRECT_URI);
  const state = destination.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43,128}$/);
  assert.ok(env.MONZO_OAUTH_STATE.map.has(`state:${state}`));
  assert.equal(env.MONZO_OAUTH_STATE.putOptions.get(`state:${state}`).expirationTtl, 600);
  assert.ok(!destination.toString().includes(env.MONZO_OAUTH_CLIENT_SECRET));
});

await test('OAuth state is owner-bound and strictly single-use', async () => {
  const env = makeEnv();
  const state = 's'.repeat(48);
  await storeMonzoOAuthState(
    env.MONZO_OAUTH_STATE,
    state,
    buildMonzoOAuthState('vladimir', 'owner@example.test'),
  );
  assert.equal(
    (await consumeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, 'owner@example.test')).alias,
    'vladimir',
  );
  await assert.rejects(
    consumeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, 'owner@example.test'),
    (error) => error instanceof MonzoSecurityError && error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('OAuth callback exchanges server-side secret, verifies whoami, encrypts tokens and returns no credential', async () => {
  const env = makeEnv();
  const state = 'c'.repeat(48);
  await storeMonzoOAuthState(
    env.MONZO_OAUTH_STATE,
    state,
    buildMonzoOAuthState('vladimir', 'owner@example.test'),
  );
  const calls = [];
  const providerFetch = fetchRouter({
    'https://api.monzo.com/oauth2/token': async (url, options) => {
      calls.push({ url, options });
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), env.MONZO_OAUTH_CLIENT_ID);
      assert.equal(form.get('client_secret'), env.MONZO_OAUTH_CLIENT_SECRET);
      assert.equal(form.get('redirect_uri'), env.MONZO_OAUTH_REDIRECT_URI);
      assert.equal(form.get('code'), 'code-synthetic');
      return Response.json({
        access_token: 'provider-access-synthetic',
        client_id: env.MONZO_OAUTH_CLIENT_ID,
        expires_in: 21600,
        refresh_token: 'provider-refresh-synthetic',
        token_type: 'Bearer',
        user_id: 'user_synthetic_1',
      });
    },
    'https://api.monzo.com/ping/whoami': async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer provider-access-synthetic');
      return Response.json({
        authenticated: true,
        client_id: env.MONZO_OAUTH_CLIENT_ID,
        user_id: 'user_synthetic_1',
      });
    },
  });

  const response = await workerTesting.oauthCallback(
    ownerRequest(
      `https://monzo-oauth.example.test/oauth/monzo/callback?state=${state}&code=code-synthetic`,
      ownerJwt,
    ),
    env,
    providerFetch,
  );
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^https:\/\/crm[.]example[.]test\/?\?monzo=authorized&artist=vladimir#\/payments$/);
  assert.ok(!location.includes('provider-access-synthetic'));
  assert.ok(!location.includes('provider-refresh-synthetic'));
  assert.equal(calls.length, 2);

  const raw = env.MONZO_OAUTH_TOKENS.map.get('artist:a1111111-1111-4111-8111-111111111111');
  assert.ok(raw);
  assert.ok(!raw.includes('provider-access-synthetic'));
  assert.ok(!raw.includes('provider-refresh-synthetic'));
  const saved = await loadMonzoTokenRecord(env, 'a1111111-1111-4111-8111-111111111111');
  assert.equal(saved.connectionState, 'oauth_authorized');
  assert.equal(saved.clientId, env.MONZO_OAUTH_CLIENT_ID);
  assert.equal(saved.userId, 'user_synthetic_1');
});

await test('owner status exposes only safe state and never account IDs, tokens or webhook keys', async () => {
  const env = makeEnv();
  await saveMonzoTokenRecord(env, tokenRecord({
    connectionState: 'account_selected',
    accountId: 'acc_123abc',
    accountLabel: 'Business Current Account',
  }));
  const response = await workerTesting.connectionStatus(
    ownerRequest('https://monzo-oauth.example.test/oauth/monzo/status/vladimir', ownerJwt),
    'vladimir',
    env,
    fetchRouter(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    artist: 'vladimir',
    state: 'account_selected',
    account_label: 'Business Current Account',
    webhook_registered: false,
  });
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('acc_123abc'));
  assert.ok(!serialized.includes('access-token-synthetic'));
  assert.ok(!serialized.includes('refresh-token-synthetic'));
  assert.ok(!serialized.includes('w'.repeat(48)));
});

await test('Monzo approval-pending response is persisted only inside encrypted token state', async () => {
  const env = makeEnv();
  await saveMonzoTokenRecord(env, tokenRecord());
  const providerFetch = fetchRouter({
    'https://api.monzo.com/ping/whoami': async () => Response.json({
      authenticated: true,
      client_id: env.MONZO_OAUTH_CLIENT_ID,
      user_id: 'user_synthetic_1',
    }),
    'https://api.monzo.com/accounts': async () => Response.json({ error: 'bad_request' }, { status: 403 }),
  });
  await assert.rejects(
    workerTesting.listAccounts(
      ownerRequest('https://monzo-oauth.example.test/oauth/monzo/accounts/vladimir', ownerJwt),
      'vladimir',
      env,
      providerFetch,
    ),
    (error) => error instanceof MonzoApiError && error.code === 'monzo_approval_pending',
  );
  assert.equal(
    (await loadMonzoTokenRecord(env, 'a1111111-1111-4111-8111-111111111111')).connectionState,
    'approval_pending',
  );
});

await test('browser-proposed account is accepted only after authenticated /accounts revalidation', async () => {
  const env = makeEnv();
  await saveMonzoTokenRecord(env, tokenRecord());
  const accountsFetch = fetchRouter({
    'https://api.monzo.com/accounts': async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer access-token-synthetic');
      return Response.json({ accounts: [
        { id: 'acc_123abc', description: 'Business Current Account' },
        { id: 'acc_456def', description: 'Savings' },
      ] });
    },
  });

  const selected = await workerTesting.selectAccount(
    ownerRequest(
      'https://monzo-oauth.example.test/oauth/monzo/select-account/vladimir',
      ownerJwt,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: 'acc_123abc' }),
      },
    ),
    'vladimir',
    env,
    accountsFetch,
  );
  assert.equal(selected.status, 200);
  const saved = await loadMonzoTokenRecord(env, 'a1111111-1111-4111-8111-111111111111');
  assert.equal(saved.connectionState, 'account_selected');
  assert.equal(saved.accountId, 'acc_123abc');
  assert.equal(saved.accountLabel, 'Business Current Account');
  assert.deepEqual(
    await env.MONZO_WEBHOOK_ROUTES.get(`route:${saved.webhookKey}`, 'json'),
    {
      alias: 'vladimir',
      artistId: 'a1111111-1111-4111-8111-111111111111',
      providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
      accountId: 'acc_123abc',
    },
  );

  await assert.rejects(
    workerTesting.selectAccount(
      ownerRequest(
        'https://monzo-oauth.example.test/oauth/monzo/select-account/vladimir',
        ownerJwt,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: 'acc_forged999' }),
        },
      ),
      'vladimir',
      env,
      accountsFetch,
    ),
    (error) => error instanceof MonzoSecurityError && error.code === 'monzo_account_not_allowed',
  );
});

await test('expired token refresh rotates encrypted credentials and concurrent rotation accepts only newer KV state', async () => {
  const env = makeEnv();
  const expired = tokenRecord({ expiresAt: Date.now() - 1000 });
  const refreshed = await ensureMonzoAccessToken(
    env,
    expired,
    fetchRouter({
      'https://api.monzo.com/oauth2/token': async (url, options) => {
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('refresh_token'), expired.refreshToken);
        return Response.json({
          access_token: 'rotated-access-synthetic',
          client_id: env.MONZO_OAUTH_CLIENT_ID,
          expires_in: 21600,
          refresh_token: 'rotated-refresh-synthetic',
          token_type: 'Bearer',
          user_id: expired.userId,
        });
      },
    }),
  );
  assert.equal(refreshed.accessToken, 'rotated-access-synthetic');
  const stored = await loadMonzoTokenRecord(env, expired.artistId);
  assert.equal(stored.refreshToken, 'rotated-refresh-synthetic');

  const old = tokenRecord({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1000,
  });
  const newer = tokenRecord({
    accessToken: 'newer-access',
    refreshToken: 'newer-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  await saveMonzoTokenRecord(env, newer);
  const concurrent = await ensureMonzoAccessToken(
    env,
    old,
    fetchRouter({
      'https://api.monzo.com/oauth2/token': async () => Response.json({ error: 'invalid_grant' }, { status: 401 }),
    }),
  );
  assert.equal(concurrent.accessToken, 'newer-access');
  assert.equal(concurrent.record.refreshToken, 'newer-refresh');
});

await test('webhook path is fail-closed while reconciliation is disabled and unknown opaque routes are indistinguishable', async () => {
  const env = makeEnv();
  const key = 'z'.repeat(48);
  const disabled = await workerTesting.handleWebhook(
    new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transaction.created', data: { id: 'tx_abc' } }),
    }),
    key,
    env,
    async () => { throw new Error('provider must not be called'); },
  );
  assert.equal(disabled.status, 503);

  env.MONZO_RECONCILIATION_ENABLED = 'true';
  const unknown = await workerTesting.handleWebhook(
    new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transaction.created', data: { id: 'tx_abc' } }),
    }),
    key,
    env,
    async () => { throw new Error('provider must not be called'); },
  );
  assert.equal(unknown.status, 404);
});

await test('webhook account hint mismatch is ignored before token, provider or database access', async () => {
  const env = makeEnv();
  env.MONZO_RECONCILIATION_ENABLED = 'true';
  const key = 'h'.repeat(48);
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${key}`, JSON.stringify({
    alias: 'vladimir',
    artistId: env.VLADIMIR_ARTIST_ID,
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    accountId: 'acc_123abc',
  }));
  const response = await workerTesting.handleWebhook(
    new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'transaction.created',
        data: { id: 'tx_hint1', account_id: 'acc_other999', amount: 999999 },
      }),
    }),
    key,
    env,
    async () => { throw new Error('provider must not be called'); },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, ignored: true });
});

await test('webhook amount is never trusted: authenticated transaction re-fetch drives the £250 candidate', async () => {
  const env = makeEnv();
  env.MONZO_RECONCILIATION_ENABLED = 'true';
  const key = 'k'.repeat(48);
  const accountId = 'acc_123abc';
  const transaction = {
    id: 'tx_verified250',
    account_id: accountId,
    amount: 25000,
    currency: 'GBP',
    created: '2026-08-12T01:00:00.000Z',
  };
  await saveMonzoTokenRecord(env, tokenRecord({
    connectionState: 'account_selected',
    accountId,
    accountLabel: 'Business Current Account',
    webhookKey: key,
  }));
  await env.MONZO_WEBHOOK_ROUTES.put(`route:${key}`, JSON.stringify({
    alias: 'vladimir',
    artistId: env.VLADIMIR_ARTIST_ID,
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    accountId,
  }));

  let reconciliationBody = null;
  const providerFetch = fetchRouter({
    'https://api.monzo.com/transactions/tx_verified250': async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer access-token-synthetic');
      return Response.json({ transaction });
    },
    'https://api.monzo.com/transactions?*': async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('account_id'), accountId);
      assert.equal(options.headers.Authorization, 'Bearer access-token-synthetic');
      return Response.json({ transactions: [transaction] });
    },
    'https://synthetic-project.supabase.co/rest/v1/rpc/register_monzo_reconciliation_candidate': async (url, options) => {
      assert.equal(options.headers.apikey, 'sb_secret_test-only');
      reconciliationBody = JSON.parse(options.body);
      return Response.json({ status: 'candidate' });
    },
  });

  const response = await workerTesting.handleWebhook(
    new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'transaction.created',
        data: {
          id: transaction.id,
          account_id: accountId,
          amount: 1,
          currency: 'USD',
        },
      }),
    }),
    key,
    env,
    providerFetch,
  );
  assert.equal(response.status, 202);
  assert.equal(reconciliationBody.p_amount, 250);
  assert.equal(reconciliationBody.p_currency, 'GBP');
  assert.equal(reconciliationBody.p_provider_transaction_id, transaction.id);
  assert.equal(reconciliationBody.p_occurred_at, transaction.created);
  assert.equal(reconciliationBody.p_provider_event_id, `monzo:transaction.created:${transaction.id}`);
});

await test('verified debits/non-GBP transactions never reach reconciliation', async () => {
  for (const transaction of [
    { id: 'tx_debit1', account_id: 'acc_123abc', amount: -25000, currency: 'GBP', created: '2026-08-12T01:01:00.000Z' },
    { id: 'tx_eur1', account_id: 'acc_123abc', amount: 25000, currency: 'EUR', created: '2026-08-12T01:02:00.000Z' },
  ]) {
    const env = makeEnv();
    env.MONZO_RECONCILIATION_ENABLED = 'true';
    const key = transaction.id.includes('debit') ? 'd'.repeat(48) : 'e'.repeat(48);
    await saveMonzoTokenRecord(env, tokenRecord({
      connectionState: 'account_selected',
      accountId: 'acc_123abc',
      accountLabel: 'Business Current Account',
      webhookKey: key,
    }));
    await env.MONZO_WEBHOOK_ROUTES.put(`route:${key}`, JSON.stringify({
      alias: 'vladimir',
      artistId: env.VLADIMIR_ARTIST_ID,
      providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
      accountId: 'acc_123abc',
    }));
    let dbCalled = false;
    const providerFetch = fetchRouter({
      [`https://api.monzo.com/transactions/${transaction.id}`]: async () => Response.json({ transaction }),
      'https://api.monzo.com/transactions?*': async () => Response.json({ transactions: [transaction] }),
      'https://synthetic-project.supabase.co/rest/v1/rpc/register_monzo_reconciliation_candidate': async () => {
        dbCalled = true;
        return Response.json({});
      },
    });
    const response = await workerTesting.handleWebhook(
      new Request(`https://monzo-webhook.example.test/webhooks/monzo/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'transaction.created', data: { id: transaction.id } }),
      }),
      key,
      env,
      providerFetch,
    );
    assert.equal(response.status, 202);
    assert.equal(dbCalled, false);
  }
});

await test('transaction must be proven inside the selected account, not merely returned by ID', async () => {
  const transaction = {
    id: 'tx_crossaccount1',
    amount: 25000,
    currency: 'GBP',
    created: '2026-08-12T01:03:00.000Z',
  };
  await assert.rejects(
    verifyTransactionBelongsToAccount(
      'access-token-synthetic',
      transaction,
      'acc_123abc',
      fetchRouter({
        'https://api.monzo.com/transactions?*': async () => Response.json({ transactions: [] }),
      }),
    ),
    (error) => error instanceof MonzoApiError && error.code === 'monzo_account_mismatch',
  );
});

await test('Monzo Supabase client can call only the candidate-only reconciliation RPC', async () => {
  const env = makeEnv();
  let called = false;
  const client = createMonzoSupabaseClient(env, async () => {
    called = true;
    return Response.json({});
  });
  await assert.rejects(
    client.rpc('set_monzo_api_connection_status', {}),
    /Monzo RPC is not allowed/,
  );
  assert.equal(called, false);
});

await test('provider webhook registration helper is validated but no Worker registration endpoint exists', async () => {
  let posted = null;
  const webhook = await registerMonzoWebhook(
    'access-token-synthetic',
    'acc_123abc',
    `https://monzo-webhook.example.test/webhooks/monzo/${'q'.repeat(48)}`,
    async (url, options) => {
      assert.equal(url, 'https://api.monzo.com/webhooks');
      posted = new URLSearchParams(options.body);
      return Response.json({ webhook: {
        id: 'webhook_abc123',
        account_id: 'acc_123abc',
        url: `https://monzo-webhook.example.test/webhooks/monzo/${'q'.repeat(48)}`,
      } });
    },
  );
  assert.equal(webhook.id, 'webhook_abc123');
  assert.equal(posted.get('account_id'), 'acc_123abc');

  const response = await monzoWorker.fetch(
    new Request('https://monzo-oauth.example.test/oauth/monzo/register-webhook/vladimir', { method: 'POST' }),
    makeEnv(),
  );
  assert.equal(response.status, 404);
});

await test('readiness is boolean-only and never serializes credentials or owner identity', () => {
  const env = makeEnv();
  const readiness = monzoReadiness(env);
  assert.equal(readiness.configuration.oauth, true);
  assert.equal(readiness.configuration.ownerAccess, true);
  assert.equal(readiness.configuration.webhookBase, true);
  assert.equal(readiness.configuration.artists, true);
  assert.equal(readiness.reconciliationEnabled, false);
  const serialized = JSON.stringify(readiness);
  for (const secret of [
    env.MONZO_OAUTH_CLIENT_SECRET,
    env.MONZO_OWNER_EMAILS,
    env.MONZO_ACCESS_AUD,
    env.SUPABASE_SECRET_KEY,
  ]) {
    assert.ok(!serialized.includes(secret));
  }
});

if (failures) {
  console.error(`\n${failures} Monzo API foundation test(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`Monzo API foundation tests passed: ${passes} cases.`);
