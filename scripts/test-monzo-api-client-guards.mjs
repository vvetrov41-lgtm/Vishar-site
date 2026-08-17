import assert from 'node:assert/strict';
import {
  ensureMonzoAccessToken,
  exchangeMonzoAuthorizationCode,
  isIncomingGbpTransferCredit,
  listMonzoAccounts,
  monzoWhoAmI,
  registerMonzoWebhook,
  MonzoApiError,
} from '../workers/lib/monzo-api-client.js';

const currentRecord = {
  alias: 'vladimir',
  connectionState: 'oauth_authorized',
  artistId: 'a1111111-1111-4111-8111-111111111111',
  providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
  clientId: 'oauth-client-current-test',
  userId: 'user_guard_1',
  accessToken: 'access-guard-test',
  refreshToken: 'refresh-guard-test',
  expiresAt: Date.now() + 60 * 60 * 1000,
  connectedAt: new Date().toISOString(),
  accountId: null,
  accountLabel: null,
  webhookKey: 'g'.repeat(48),
  webhookId: null,
};

let fetchCalled = false;
await assert.rejects(
  ensureMonzoAccessToken(
    { MONZO_OAUTH_CLIENT_ID: 'oauth-client-other-test' },
    currentRecord,
    async () => {
      fetchCalled = true;
      throw new Error('network must not be called for a stale OAuth client binding');
    },
  ),
  (error) => error instanceof MonzoApiError
    && error.code === 'monzo_account_mismatch'
    && error.status === 403,
);
assert.equal(fetchCalled, false);

for (const callbackUrl of [
  `https://monzo-webhook.example.test:8443/webhooks/monzo/${'p'.repeat(48)}`,
  `https://monzo-webhook.example.test/webhooks/monzo/${'q'.repeat(48)}?next=unexpected`,
]) {
  let called = false;
  await assert.rejects(
    registerMonzoWebhook(
      'access-guard-test',
      'acc_guard123',
      callbackUrl,
      async () => {
        called = true;
        throw new Error('network must not be called for an invalid callback URL');
      },
    ),
    (error) => error instanceof MonzoApiError
      && error.code === 'monzo_webhook_configuration_invalid'
      && error.status === 503,
  );
  assert.equal(called, false);
}

// Token endpoint failures are intentionally reduced to a small stable set of
// internal categories. Never reflect Monzo's raw provider message/code because
// those strings are external input and may contain operational detail.
const oauthEnv = {
  MONZO_OAUTH_CLIENT_ID: 'oauth-client-current-test',
  MONZO_OAUTH_CLIENT_SECRET: 'client-secret-test',
  MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
};
for (const [status, body, expected] of [
  [400, { code: 'bad_request.client_not_enabled' }, 'monzo_oauth_client_not_enabled'],
  [400, { code: 'bad_request.could_not_authenticate', error: 'invalid_request' }, 'monzo_oauth_client_rejected'],
  [400, { error: 'invalid_client' }, 'monzo_oauth_client_rejected'],
  [400, { code: 'bad_request.bad_param.redirect_uri' }, 'monzo_oauth_redirect_uri_rejected'],
  [400, { code: 'bad_request.authorization_code.invalid' }, 'monzo_authorization_code_rejected'],
  [401, { code: 'unauthorized' }, 'monzo_token_exchange_unauthorized'],
  [400, { message: 'do not reflect provider detail or secret-shaped content' }, 'monzo_token_exchange_bad_request'],
  [403, { message: 'do not reflect provider detail' }, 'monzo_token_exchange_forbidden'],
  [418, { message: 'unclassified provider detail' }, 'monzo_token_exchange_failed'],
  [500, {}, 'monzo_provider_unavailable'],
]) {
  let submitted = null;
  await assert.rejects(
    exchangeMonzoAuthorizationCode(
      oauthEnv,
      'authorization-code-test',
      async (url, options) => {
        assert.equal(url, 'https://api.monzo.com/oauth2/token');
        submitted = new URLSearchParams(options.body);
        return Response.json(body, { status });
      },
    ),
    (error) => error instanceof MonzoApiError && error.code === expected,
  );
  assert.equal(submitted.get('grant_type'), 'authorization_code');
  assert.equal(submitted.get('client_id'), oauthEnv.MONZO_OAUTH_CLIENT_ID);
  assert.equal(submitted.get('client_secret'), oauthEnv.MONZO_OAUTH_CLIENT_SECRET);
  assert.equal(submitted.get('redirect_uri'), oauthEnv.MONZO_OAUTH_REDIRECT_URI);
  assert.equal(submitted.get('code'), 'authorization-code-test');
}

const validTokenPayload = {
  access_token: 'access-token-test',
  refresh_token: 'refresh-token-test',
  token_type: 'Bearer',
  client_id: oauthEnv.MONZO_OAUTH_CLIENT_ID,
  user_id: 'user-token-test',
  expires_in: 21600,
};
const accepted = await exchangeMonzoAuthorizationCode(
  oauthEnv,
  'authorization-code-test',
  async () => Response.json(validTokenPayload),
);
assert.deepEqual(accepted, validTokenPayload);

// RFC 6749 defines token_type as case-insensitive. Do not reject a valid
// Bearer token solely because a provider changes the response casing.
const lowercaseBearerPayload = { ...validTokenPayload, token_type: 'bearer' };
const lowercaseBearerAccepted = await exchangeMonzoAuthorizationCode(
  oauthEnv,
  'authorization-code-test',
  async () => Response.json(lowercaseBearerPayload),
);
assert.deepEqual(lowercaseBearerAccepted, lowercaseBearerPayload);

// OAuth defines expires_in as a positive lifetime in seconds and does not set
// an upper bound. A client may refresh earlier, but must not invent a provider
// maximum and reject a valid response.
const longLivedPayload = { ...validTokenPayload, expires_in: 172800 };
const longLivedAccepted = await exchangeMonzoAuthorizationCode(
  oauthEnv,
  'authorization-code-test',
  async () => Response.json(longLivedPayload),
);
assert.deepEqual(longLivedAccepted, longLivedPayload);

for (const [body, expected] of [
  [{ ...validTokenPayload, access_token: undefined }, 'monzo_access_token_missing'],
  [{ ...validTokenPayload, refresh_token: undefined }, 'monzo_refresh_token_missing'],
  [{ ...validTokenPayload, client_id: 'oauth-client-other-test' }, 'monzo_token_client_mismatch'],
  [{ ...validTokenPayload, token_type: 'MAC' }, 'monzo_token_type_invalid'],
  [{ ...validTokenPayload, user_id: undefined }, 'monzo_user_id_missing'],
  [{ ...validTokenPayload, expires_in: '21600' }, 'monzo_token_expiry_invalid'],
  [{ ...validTokenPayload, expires_in: 0 }, 'monzo_token_expiry_invalid'],
]) {
  await assert.rejects(
    exchangeMonzoAuthorizationCode(
      oauthEnv,
      'authorization-code-test',
      async () => Response.json(body),
    ),
    (error) => error instanceof MonzoApiError && error.code === expected,
  );
}

// Monzo may issue the token pair before the separate in-app SCA approval has
// completed. /ping/whoami is then expected to be 403. The identity probe must
// preserve the token for the OAuth callback, but it must explicitly report
// that identity is still pending rather than pretending verification occurred.
const pendingIdentity = await monzoWhoAmI(
  'access-guard-test',
  oauthEnv.MONZO_OAUTH_CLIENT_ID,
  'user-token-test',
  async () => Response.json({ code: 'forbidden.verification_required' }, { status: 403 }),
);
assert.deepEqual(pendingIdentity, {
  clientId: oauthEnv.MONZO_OAUTH_CLIENT_ID,
  userId: 'user-token-test',
  approvalPending: true,
});

const verifiedIdentity = await monzoWhoAmI(
  'access-guard-test',
  oauthEnv.MONZO_OAUTH_CLIENT_ID,
  'user-token-test',
  async () => Response.json({
    authenticated: true,
    client_id: oauthEnv.MONZO_OAUTH_CLIENT_ID,
    user_id: 'user-token-test',
  }),
);
assert.deepEqual(verifiedIdentity, {
  clientId: oauthEnv.MONZO_OAUTH_CLIENT_ID,
  userId: 'user-token-test',
  approvalPending: false,
});
await assert.rejects(
  monzoWhoAmI(
    'access-guard-test',
    oauthEnv.MONZO_OAUTH_CLIENT_ID,
    'user-token-test',
    async () => Response.json({
      authenticated: true,
      client_id: oauthEnv.MONZO_OAUTH_CLIENT_ID,
      user_id: 'user-other-test',
    }),
  ),
  (error) => error instanceof MonzoApiError && error.code === 'monzo_account_mismatch',
);

// The live Monzo API answers an invalid or expired bearer token with HTTP 400
// and `code: "bad_request.invalid_token"`, not the documented 401. That must
// still route to reauthorisation instead of a generic provider rejection. A
// 403 on an account endpoint remains fail-closed while SCA approval is pending.
for (const [status, body, expected] of [
  [400, { code: 'bad_request.invalid_token', message: 'Token is invalid' }, 'monzo_reauthorization_required'],
  [400, { error: 'invalid_token' }, 'monzo_reauthorization_required'],
  [401, { code: 'unauthorized' }, 'monzo_reauthorization_required'],
  [403, { code: 'forbidden.verification_required' }, 'monzo_approval_pending'],
  [400, { code: 'bad_request.bad_param.account_id' }, 'monzo_provider_rejected'],
  [500, {}, 'monzo_provider_unavailable'],
]) {
  await assert.rejects(
    listMonzoAccounts('access-guard-test', async () => Response.json(body, { status })),
    (error) => error instanceof MonzoApiError && error.code === expected,
  );
}

// Only a proven inbound GBP bank credit is a client deposit candidate.
assert.equal(isIncomingGbpTransferCredit({ amount: 25000, currency: 'GBP' }), true);
assert.equal(
  isIncomingGbpTransferCredit({ amount: 25000, currency: 'GBP', scheme: 'payport_faster_payments' }),
  true,
);
for (const transaction of [
  { amount: -25000, currency: 'GBP' },
  { amount: 0, currency: 'GBP' },
  { amount: 25000, currency: 'EUR' },
  { amount: 25000, currency: 'GBP', is_load: true },
  { amount: 25000, currency: 'GBP', merchant: { id: 'merch_1' } },
  { amount: 25000, currency: 'GBP', decline_reason: 'OTHER' },
  { amount: 25000, currency: 'GBP', scheme: 'mastercard' },
  { amount: 25000, currency: 'GBP', scheme: 'uk_retail_pot' },
  { amount: 25000, currency: 'GBP', scheme: 'topup' },
  { amount: 25000.5, currency: 'GBP' },
]) {
  assert.equal(isIncomingGbpTransferCredit(transaction), false, JSON.stringify(transaction));
}

console.log('Monzo API client guard tests passed, including token exchange diagnostics and SCA race handling.');