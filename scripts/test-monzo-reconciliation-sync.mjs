import assert from 'node:assert/strict';
import { syncRecentMonzoReconciliation, __testing as syncTesting } from '../workers/lib/monzo-reconciliation-sync.js';
import { __testing as setupTesting } from '../workers/lib/monzo-setup-flow.js';
import { saveMonzoTokenRecord } from '../workers/lib/monzo-token-store.js';

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

function makeEnv() {
  return {
    VISHAR_ENVIRONMENT: 'test',
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-recovery',
    MONZO_OAUTH_CLIENT_SECRET: 'oauth-secret-test',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_CRM_RETURN_URL: 'https://crm.example.test/#/payments',
    MONZO_WEBHOOK_BASE_URL: 'https://monzo.example.test/',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString('base64url'),
    MONZO_OAUTH_TOKENS: new FakeKv(),
    MONZO_RECONCILIATION_ENABLED: 'true',
    VLADIMIR_ARTIST_ID: 'a1111111-1111-4111-8111-111111111111',
    KRISTINA_ARTIST_ID: 'a2222222-2222-4222-8222-222222222222',
    SUPABASE_URL: 'https://synthetic-recovery.supabase.co',
    SUPABASE_SECRET_KEY: 'sb' + '_secret_' + 'test-only-recovery',
  };
}

function connectedRecord(now, overrides = {}) {
  return {
    alias: 'vladimir',
    connectionState: 'webhook_registered',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-recovery',
    userId: 'user_recovery_1',
    accessToken: 'access-token-recovery-synthetic',
    refreshToken: 'refresh-token-recovery-synthetic',
    expiresAt: now + 60 * 60 * 1000,
    connectedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    accountId: 'acc_recovery1',
    accountLabel: 'Recovery Business Account',
    webhookKey: 'w'.repeat(48),
    webhookId: 'webhook_recovery1',
    ...overrides,
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

await test('connected page exposes bounded recovery with an encrypted owner-bound confirmation and no provider identifiers', async () => {
  const env = makeEnv();
  const now = Date.parse('2026-08-18T08:45:00Z');
  const record = connectedRecord(now);
  const syncToken = await setupTesting.createSyncConfirmationToken(
    env,
    'vladimir',
    'owner@example.test',
    record,
    now,
  );
  const page = setupTesting.connectedPage(env, 'vladimir', 'Recovery <Business>', syncToken, {
    scanned: 4,
    eligible: 1,
    verified: 1,
    registered: 1,
    replayed: 0,
  });
  assert.match(page, /Sync recent transfers/);
  assert.match(page, /name="action" value="sync_recent"/);
  assert.match(page, new RegExp(`name="sync_token" value="${syncToken}"`));
  assert.match(page, /never marks a payment as paid/);
  assert.match(page, /Recovery &lt;Business&gt;/);
  assert.ok(!page.includes(record.accountId));
  assert.ok(!page.includes(record.userId));
  assert.ok(!page.includes(record.webhookId));
  assert.ok(!page.includes(record.webhookKey));
  assert.ok(!page.includes('owner@example.test'));
  assert.ok(!page.includes('tx_'));
});

await test('recovery POST accepts iOS-style missing Origin only with the signed confirmation and rejects cross-origin or forged submissions', async () => {
  const env = makeEnv();
  const now = Date.parse('2026-08-18T08:45:00Z');
  const record = connectedRecord(now);
  const syncToken = await setupTesting.createSyncConfirmationToken(
    env,
    'vladimir',
    'owner@example.test',
    record,
    now,
  );

  const formBody = () => new URLSearchParams({ action: 'sync_recent', sync_token: syncToken });
  const safariStyle = new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(),
  });
  assert.equal(
    await setupTesting.readSyncForm(
      safariStyle,
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    true,
  );

  const normalBrowser = new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
    method: 'POST',
    headers: {
      Origin: 'https://monzo.example.test',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody(),
  });
  assert.equal(
    await setupTesting.readSyncForm(
      normalBrowser,
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    true,
  );

  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody(),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'same_origin_required' && error?.status === 403,
  );

  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'sync_recent' }),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'sync_confirmation_required',
  );

  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'sync_recent',
          sync_token: syncToken,
          account_id: 'acc_attacker',
        }),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'sync_confirmation_required',
  );

  const tamperIndex = Math.floor(syncToken.length / 2);
  const tampered = `${syncToken.slice(0, tamperIndex)}${syncToken[tamperIndex] === 'A' ? 'B' : 'A'}${syncToken.slice(tamperIndex + 1)}`;
  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'sync_recent', sync_token: tampered }),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'sync_confirmation_invalid_or_expired',
  );

  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      }),
      env,
      'vladimir',
      'other-owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'sync_confirmation_invalid_or_expired',
  );

  const setupToken = await setupTesting.createSetupConfirmationToken(
    env,
    'vladimir',
    'owner@example.test',
    record,
    now,
  );
  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'sync_recent', sync_token: setupToken }),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + 1_000,
    ),
    (error) => error?.code === 'sync_confirmation_invalid_or_expired',
  );

  await assert.rejects(
    setupTesting.readSyncForm(
      new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      }),
      env,
      'vladimir',
      'owner@example.test',
      record,
      now + setupTesting.SETUP_TTL_SECONDS * 1000 + 1,
    ),
    (error) => error?.code === 'sync_confirmation_invalid_or_expired',
  );
});

await test('recovery sync re-fetches one recent incoming transfer and writes only the existing candidate RPC', async () => {
  const env = makeEnv();
  const now = Date.parse('2026-08-18T00:00:00Z');
  const record = connectedRecord(now);
  await saveMonzoTokenRecord(env, record);

  const authoritative = {
    id: 'tx_recovery001',
    account_id: record.accountId,
    amount: 25000,
    currency: 'GBP',
    created: '2026-08-17T21:05:00Z',
    decline_reason: '',
    is_load: false,
    merchant: null,
    scheme: 'faster_payments',
  };
  const recoverySince = new Date(now - syncTesting.RECOVERY_WINDOW_MS).toISOString();
  const calls = [];
  let rpcPayload = null;

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), options });

    if (url.origin === 'https://api.monzo.com' && url.pathname === '/ping/whoami') {
      assert.equal(options.headers.Authorization, `Bearer ${record.accessToken}`);
      return Response.json({
        authenticated: true,
        client_id: record.clientId,
        user_id: record.userId,
      });
    }

    if (url.origin === 'https://api.monzo.com' && url.pathname === '/transactions') {
      assert.equal(url.searchParams.get('account_id'), record.accountId);
      if (url.searchParams.get('since') === recoverySince) {
        assert.equal(url.searchParams.get('limit'), String(syncTesting.MAX_LISTED_TRANSACTIONS));
        assert.equal(url.searchParams.get('before'), new Date(now + 60_000).toISOString());
        return Response.json({ transactions: [
          authoritative,
          { ...authoritative },
          {
            id: 'tx_recovery_debit',
            account_id: record.accountId,
            amount: -1000,
            currency: 'GBP',
            created: '2026-08-17T22:00:00Z',
            is_load: false,
            merchant: null,
            scheme: 'faster_payments',
          },
          {
            id: 'tx_recovery_refund',
            account_id: record.accountId,
            amount: 500,
            currency: 'GBP',
            created: '2026-08-17T22:10:00Z',
            is_load: false,
            merchant: { id: 'merchant_synthetic' },
            scheme: 'mastercard',
          },
        ] });
      }
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json({ transactions: [authoritative] });
    }

    if (url.origin === 'https://api.monzo.com' && url.pathname === `/transactions/${authoritative.id}`) {
      return Response.json({ transaction: authoritative });
    }

    if (
      url.origin === env.SUPABASE_URL
      && url.pathname === '/rest/v1/rpc/register_monzo_reconciliation_candidate'
    ) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
      rpcPayload = JSON.parse(options.body);
      return Response.json({
        candidate_id: 'candidate-synthetic',
        artist_id: record.artistId,
        status: 'unmatched',
        replayed: false,
      });
    }

    throw new Error(`unexpected recovery fetch: ${url}`);
  };

  const result = await syncRecentMonzoReconciliation('vladimir', env, fetchImpl, now);
  assert.deepEqual(result, {
    scanned: 4,
    eligible: 1,
    verified: 1,
    registered: 1,
    replayed: 0,
  });
  assert.deepEqual(rpcPayload, {
    p_provider_account_key: record.providerAccountKey,
    p_provider_event_id: `monzo:transaction.created:${authoritative.id}`,
    p_provider_transaction_id: authoritative.id,
    p_amount: 250,
    p_currency: 'GBP',
    p_occurred_at: authoritative.created,
  });
  assert.deepEqual(Object.keys(result).sort(), ['eligible', 'registered', 'replayed', 'scanned', 'verified']);
  assert.ok(calls.some((call) => call.url.includes(`/transactions/${authoritative.id}`)));
});

await test('recovery cannot bypass reconciliation feature flag', async () => {
  const env = makeEnv();
  env.MONZO_RECONCILIATION_ENABLED = 'false';
  let networkCalls = 0;
  await assert.rejects(
    syncRecentMonzoReconciliation('vladimir', env, async () => {
      networkCalls += 1;
      throw new Error('network must not be reached');
    }),
    (error) => error?.code === 'reconciliation_disabled' && error?.status === 503,
  );
  assert.equal(networkCalls, 0);
});

if (failures) {
  console.error(`${failures} Monzo reconciliation recovery test(s) failed; ${passes} passed.`);
  process.exit(1);
}
console.log(`Monzo reconciliation recovery tests passed (${passes}).`);
