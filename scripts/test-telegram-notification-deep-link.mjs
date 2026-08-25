import assert from 'node:assert/strict';
import { drainPersonalTelegramNotifications } from '../workers/lib/telegram-drain.js';

const deliveryId = '11111111-1111-4111-8111-111111111111';
const notificationId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const artistId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const chatId = '500002';
const workerId = 'telegram-deep-link-test';
const sharedToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';

function claimed(overrides = {}) {
  return {
    delivery_id: deliveryId,
    notification_id: notificationId,
    profile_id: profileId,
    chat_id: chatId,
    title: 'Client requested reschedule',
    body: 'Open the appointment to review the request.',
    priority: 'normal',
    artist_id: artistId,
    workspace_id: null,
    entity_type: 'session',
    entity_id: sessionId,
    ...overrides,
  };
}

function mockFetch(row) {
  const rpcCalls = [];
  const telegramCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'service_claim_telegram_notifications') return Response.json([row]);
      if (name === 'service_record_telegram_notification_result') return Response.json({ ok: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith('https://api.telegram.org/bot')) {
      const body = JSON.parse(init.body || '{}');
      telegramCalls.push({ url: value, body });
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  return { fetchImpl, rpcCalls, telegramCalls };
}

const productionEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  TELEGRAM_BOT_TOKEN: sharedToken,
  VISHAR_ENVIRONMENT: 'production',
  CRM_ORIGIN: 'https://crm.vishartattoo.com',
};

{
  const mock = mockFetch(claimed());
  const result = await drainPersonalTelegramNotifications(productionEnv, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(mock.rpcCalls[0].name, 'service_claim_telegram_notifications');
  assert.equal(mock.telegramCalls.length, 1);
  assert.match(
    mock.telegramCalls[0].body.text,
    new RegExp(`Open in CRM: https://crm\\.vishartattoo\\.com/#/appointments/${sessionId}`),
  );
}

{
  // Simulate the new Worker running briefly against a pre-0101 DB response.
  // The same RPC lacks entity fields, so delivery must continue without a link.
  const { entity_type, entity_id, ...legacyRow } = claimed();
  const mock = mockFetch(legacyRow);
  const result = await drainPersonalTelegramNotifications(productionEnv, {
    workerId,
    limit: 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(mock.rpcCalls[0].name, 'service_claim_telegram_notifications');
  assert.equal(mock.telegramCalls.length, 1);
  assert.doesNotMatch(mock.telegramCalls[0].body.text, /Open in CRM:/);
}

console.log('Telegram appointment notification deep-link tests passed: one RPC renders the exact production appointment link after 0101 and remains compatible with the pre-0101 response shape.');
