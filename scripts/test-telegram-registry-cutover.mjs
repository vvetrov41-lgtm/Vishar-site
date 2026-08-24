import assert from 'node:assert/strict';
import { drainTelegramOutboxById } from '../workers/lib/telegram-drain.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';

const outboxId = 'd9111111-1111-4111-8111-111111111111';
const enquiryId = 'd9211111-1111-4111-8111-111111111111';
const artistId = 'a1111111-1111-4111-8111-111111111111';
const destinationId = 'e1111111-1111-4111-8111-111111111111';
const workerId = 'telegram-worker-cutover';
const sharedToken = 'shared-production-bot-token-1234567890';
const sharedChatId = '-1001234567890';
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

function makeHarness({ registryResult = [{
  destination_id: destinationId,
  destination_kind: 'artist',
  chat_id: sharedChatId,
}], registryStatus = 200, withSharedToken = true } = {}) {
  const rpcCalls = [];
  const telegramCalls = [];
  const env = {
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
      if (name === 'resolve_outbox_route') return Response.json([route]);
      if (name === 'service_resolve_telegram_destination') {
        if (registryStatus !== 200) return Response.json({ message: 'unavailable' }, { status: registryStatus });
        return Response.json(registryResult);
      }
      if (name === 'service_record_telegram_notification_result') return Response.json({ ok: true });
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
  const result = await drainTelegramOutboxById(h.env, {
    outboxId,
    workerId,
    fetchImpl: h.fetchImpl,
  });
  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.equal(h.telegramCalls.length, 1);
  assert.equal(h.telegramCalls[0].body.chat_id, sharedChatId);
  assert.ok(h.telegramCalls[0].url.includes(sharedToken));
  assert.ok(!h.telegramCalls[0].url.includes(legacyToken));
  assert.ok(h.rpcCalls.some((call) => call.name === 'service_resolve_telegram_destination'));
  assert.ok(h.rpcCalls.some((call) => call.name === 'service_record_telegram_notification_result'
    && call.args.p_delivery_id === destinationId
    && call.args.p_succeeded === true));
}

for (const scenario of [
  { label: 'missing registry destination', registryResult: [] },
  { label: 'registry backend failure', registryStatus: 503 },
]) {
  const h = makeHarness(scenario);
  const result = await drainTelegramOutboxById(h.env, {
    outboxId,
    workerId,
    fetchImpl: h.fetchImpl,
  });
  assert.equal(result.claimed, true, scenario.label);
  assert.equal(result.outcome, 'failed', scenario.label);
  assert.equal(result.errorCode, 'telegram_destination_unavailable', scenario.label);
  assert.equal(h.telegramCalls.length, 0, `${scenario.label}: legacy binding must not be used`);
  assert.ok(h.rpcCalls.some((call) => call.name === 'record_telegram_outbox_result'
    && call.args.p_succeeded === false
    && call.args.p_error_code === 'telegram_destination_unavailable'));
}

{
  const h = makeHarness({ withSharedToken: false });
  const result = await drainTelegramOutboxById(h.env, {
    outboxId,
    workerId,
    fetchImpl: h.fetchImpl,
  });
  assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });
  assert.equal(h.telegramCalls.length, 1);
  assert.equal(h.telegramCalls[0].body.chat_id, legacyChatId);
  assert.ok(h.telegramCalls[0].url.includes(legacyToken));
  assert.ok(!h.rpcCalls.some((call) => call.name === 'service_resolve_telegram_destination'));
}

console.log('Telegram registry cutover tests passed: shared-bot production delivery is registry-only and fail-closed, while no-shared-token staging fallback remains explicit.');
