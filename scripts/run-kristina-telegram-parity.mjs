import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { bindingNameFor } from '../workers/lib/provider-routing.js';
import { createSupabaseClient } from '../workers/lib/supabase.js';
import { drainTelegramOutboxById } from '../workers/lib/telegram-drain.js';
import { checkTelegramDestination } from '../workers/lib/telegram.js';

const EXPECTED_ARTIST_ID = 'a2222222-2222-4222-8222-222222222222';
const EXPECTED_INTEGRATION_KEY = 'kristina-staging';
const EXPECTED_BINDING = bindingNameFor('telegram', EXPECTED_INTEGRATION_KEY);
const SAFE_ROUTE_KEYS = [
  'artist_id',
  'configuration',
  'external_account_label',
  'integration_key',
  'integration_type',
  'kind',
  'outbox_id',
  'provider',
].sort();

function oneRow(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Kristina route must resolve to exactly one row');
  }
  return value[0];
}

function assertSafeRoute(route, outboxId) {
  assert.deepEqual(Object.keys(route).sort(), SAFE_ROUTE_KEYS);
  assert.equal(route.outbox_id, outboxId);
  assert.equal(route.artist_id, EXPECTED_ARTIST_ID);
  assert.equal(route.kind, 'telegram_notification');
  assert.equal(route.integration_type, 'telegram');
  assert.equal(route.provider, 'telegram');
  assert.equal(route.integration_key, EXPECTED_INTEGRATION_KEY);
  assert.equal(route.external_account_label, 'Kristina CRM Staging');
  assert.deepEqual(route.configuration, {
    environment: 'staging',
    routing: 'artist-scoped',
  });

  for (const forbidden of [
    'payload', 'client_id', 'reference_number', 'submitted_email',
    'submitted_phone', 'idea', 'chat_id', 'bot_token', 'credential', 'secret',
  ]) {
    assert.ok(!Object.hasOwn(route, forbidden), `route exposed forbidden field ${forbidden}`);
  }
}

const outboxId = process.env.TARGET_OUTBOX_ID;
const workerId = process.env.TELEGRAM_WORKER_ID;
const evidencePath = process.env.DRAIN_EVIDENCE_PATH;
assert.match(outboxId ?? '', /^[0-9a-f-]{36}$/i);
assert.match(workerId ?? '', /^[a-z][a-z0-9_-]{2,127}$/);
assert.ok(evidencePath);
assert.equal(EXPECTED_BINDING, 'ARTIST_TELEGRAM_KRISTINA_HSTAGING');

const telegramBindings = Object.keys(process.env).filter((key) => key.startsWith('ARTIST_TELEGRAM_'));
assert.deepEqual(telegramBindings, [EXPECTED_BINDING]);
assert.ok(process.env[EXPECTED_BINDING]);
assert.ok(!process.env.TELEGRAM_BOT_TOKEN);
assert.ok(!process.env.TELEGRAM_CHAT_ID);
assert.ok(!process.env.KRISTINA_TELEGRAM_BOT_TOKEN);
assert.ok(!process.env.KRISTINA_TELEGRAM_CHAT_ID);

const runtimeEnv = {
  SUPABASE_URL: process.env.STAGING_SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  [EXPECTED_BINDING]: process.env[EXPECTED_BINDING],
};
const supabase = createSupabaseClient(runtimeEnv);
const route = oneRow(await supabase.rpc('resolve_outbox_route', { p_outbox_id: outboxId }));
assertSafeRoute(route, outboxId);

const destination = await checkTelegramDestination(runtimeEnv, route);
if (!destination.reachable) {
  const status = destination.statusClass ? ` (${destination.statusClass})` : '';
  throw new Error(`safe Telegram destination preflight failed: ${destination.errorCode}${status}`);
}

const result = await drainTelegramOutboxById(runtimeEnv, {
  outboxId,
  workerId,
  leaseSeconds: 120,
});
assert.deepEqual(result, { claimed: true, outboxId, outcome: 'succeeded' });

const evidence = {
  route: {
    outbox_id: route.outbox_id,
    artist_id: route.artist_id,
    kind: route.kind,
    integration_type: route.integration_type,
    provider: route.provider,
    integration_key: route.integration_key,
    safe_projection_keys: Object.keys(route).sort(),
  },
  binding_name: EXPECTED_BINDING,
  destination_preflight: { reachable: true },
  drain: result,
  provider_accepted: true,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
