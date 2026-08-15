import assert from 'node:assert/strict';
import {
  ensureMonzoAccessToken,
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

console.log('Monzo API client guard tests passed: 3 cases.');
