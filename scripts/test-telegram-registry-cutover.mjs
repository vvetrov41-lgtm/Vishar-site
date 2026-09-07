import assert from 'node:assert/strict';
import { drainTelegramOutboxById } from '../workers/lib/telegram-drain.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';

const outboxId = 'd9111111-1111-4111-8111-111111111111';
const enquiryId = 'd9211111-1111-4111-8111-111111111111';
const artistId = 'a1111111-1111-4111-8111-111111111111';
const workerId = 'telegram-worker-cutover';
const sharedToken = 'shared-production-bot-token-1234567890';
const legacyToken = 'legacy-bot-token';
const legacyChatId = '-1009999999999';
const integrationKey = 'vladimir-production';
const legacyBinding = bindingNameFor('telegram', integrationKey);

const claimedJob = {
  outbox_id: outboxId,
  artist_id: artistId,
  kind: 'telegram_notification',
  enquiry_id: enquiryId,
  attempt_count: 1,
  max_attempts: 8,
  reference_number: 'ENQ-2026-9001',
  file_count: 1,
  client_conflict: false,
  job_valid: true,
};

const route = {
  outbox_id: outboxId,
  artist_id: artistId,
  kind: 'telegram_notification',
  integration_type: 'telegram',
  provider: 'telegram',
  integration_key: integrationKey,
  external_account_label: 'Vladimir production Telegram',
  configuration: {},
};

function makeHarness({
  routed = true,
  notificationCount = routed ? 1 : 0,
  errorCode = routed ? null : 'telegram_destination_unavailable',
  routeStatus = 200,
  withSharedToken = true,
  environment = 'production',
} = {}) {
  const rpcCalls = [];
  const telegramCalls = [];
  const env = {
    VISHAR_ENVIRONMENT: environment,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
    ...(withSharedToken ? { TELEGRAM_BOT_TOKEN: sharedToken } : {}),
    [legacyBinding]: JSON.stringify({ botToken: legacyToken, chatId: legacyChatId }),
  };
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_telegram_outbox_by_id') return Response.json([claimedJob]);
      if (name === 'service_route_telegram_enquiry_notification') {
        if (routeStatus !== 200) return Response.json({ message: 'unavailable' }, { status: routeStatus });
        return Response.json({ routed, notification_count: notificationCount, error_code: errorCode });
      }
      if (name === 'resolve_outbox_route') return Response.json([route]);
      if (name === 'record_telegram_outbox_result') return Response.json({ ok: true });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value.startsWith('https://api.telegram.org/bot')) {
      telegramCalls.push({ url: value, body: JSON.parse(init.body || '{}') });
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  return { env, fetchImpl, rpcCalls, telegramCalls };
}

{
  const h = makeHarness();
  const result = await drainTelegramOutboxById(h.env, { outboxId, workerId, fetchImpl: h.fetchImpl });
  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.equal(h.telegramCalls.length, 0, 'outbox routing must not call Telegram directly');
  assert.deepEqual(h.rpcCalls.map((call) => call.name), [
    'claim_telegram_outbox_by_id',
    'service_route_telegram_enquiry_notification',
    'record_telegram_outbox_result',
  ]);
  assert.deepEqual(h.rpcCalls[1].args, { p_outbox_id: outboxId, p_worker_id: workerId });
}

{
  const h = makeHarness({ routed: false });
  const result = await drainTelegramOutboxById(h.env, { outboxId, workerId, fetchImpl: h.fetchImpl });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'telegram_destination_unavailable');
  assert.equal(h.telegramCalls.length, 0);
  assert.ok(h.rpcCalls.some((call) => call.name === 'record_telegram_outbox_result'
    && call.args.p_succeeded === false));
}

{
  const h = makeHarness({ routeStatus: 503 });
  const result = await drainTelegramOutboxById(h.env, { outboxId, workerId, fetchImpl: h.fetchImpl });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'database_unavailable');
  assert.equal(h.telegramCalls.length, 0);
}

{
  const h = makeHarness({ withSharedToken: false });
  const result = await drainTelegramOutboxById(h.env, { outboxId, workerId, fetchImpl: h.fetchImpl });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'telegram_shared_bot_not_configured');
  assert.equal(h.telegramCalls.length, 0);
}

{
  const h = makeHarness({ withSharedToken: false, environment: 'staging' });
  const result = await drainTelegramOutboxById(h.env, { outboxId, workerId, fetchImpl: h.fetchImpl });
  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.equal(h.telegramCalls.length, 1);
  assert.equal(h.telegramCalls[0].body.chat_id, legacyChatId);
  assert.ok(h.rpcCalls.some((call) => call.name === 'resolve_outbox_route'));
  assert.ok(!h.rpcCalls.some((call) => call.name === 'service_route_telegram_enquiry_notification'));
}

console.log('Telegram single-profile routing tests passed: production outbox routing is provider-free and the personal delivery queue owns the only Telegram send.');
