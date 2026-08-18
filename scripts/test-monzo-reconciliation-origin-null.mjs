import assert from 'node:assert/strict';
import { __testing as setupTesting } from '../workers/lib/monzo-setup-flow.js';

function makeEnv() {
  return {
    MONZO_OAUTH_CLIENT_ID: 'oauth-client-recovery',
    MONZO_OAUTH_REDIRECT_URI: 'https://monzo.example.test/oauth/monzo/callback',
    MONZO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString('base64url'),
  };
}

function connectedRecord(now) {
  return {
    alias: 'vladimir',
    artistId: 'a1111111-1111-4111-8111-111111111111',
    providerAccountKey: 'monzo_ebt_a1111111111141118111111111111111',
    clientId: 'oauth-client-recovery',
    userId: 'user_recovery_1',
    accountId: 'acc_recovery1',
    webhookId: 'webhook_recovery1',
    expiresAt: now + 60 * 60 * 1000,
  };
}

const env = makeEnv();
const now = Date.parse('2026-08-18T09:15:00Z');
const record = connectedRecord(now);
const ownerEmail = 'owner@example.test';
const syncToken = await setupTesting.createSyncConfirmationToken(
  env,
  'vladimir',
  ownerEmail,
  record,
  now,
);

function request(headers = {}) {
  return new Request('https://monzo.example.test/oauth/monzo/setup/vladimir', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams({ action: 'sync_recent', sync_token: syncToken }),
  });
}

assert.equal(
  await setupTesting.readSyncForm(
    request({ Origin: 'null' }),
    env,
    'vladimir',
    ownerEmail,
    record,
    now + 1_000,
  ),
  true,
  'opaque mobile Origin must be accepted only after signed confirmation verification',
);

await assert.rejects(
  setupTesting.readSyncForm(
    request({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }),
    env,
    'vladimir',
    ownerEmail,
    record,
    now + 1_000,
  ),
  (error) => error?.code === 'same_origin_required' && error?.status === 403,
  'browser-declared cross-site requests must fail even with opaque Origin',
);

await assert.rejects(
  setupTesting.readSyncForm(
    request({ Origin: 'https://attacker.example' }),
    env,
    'vladimir',
    ownerEmail,
    record,
    now + 1_000,
  ),
  (error) => error?.code === 'same_origin_required' && error?.status === 403,
  'explicit foreign origins must remain rejected',
);

console.log('Monzo opaque mobile Origin recovery tests passed.');
