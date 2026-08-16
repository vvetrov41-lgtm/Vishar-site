import assert from 'node:assert/strict';
import {
  ensureMonzoAccessToken,
  isIncomingGbpTransferCredit,
  listMonzoAccounts,
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

// The live Monzo API answers an invalid or expired bearer token with HTTP 400
// and `code: "bad_request.invalid_token"`, not the documented 401. That must
// still route to reauthorisation instead of a generic provider rejection.
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

console.log('Monzo API client guard tests passed: 5 cases.');
