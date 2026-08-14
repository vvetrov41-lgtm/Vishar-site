import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { bindingNameFor } from '../workers/lib/provider-routing.js';
import { createSupabaseClient } from '../workers/lib/supabase.js';
import { checkTelegramDestination } from '../workers/lib/telegram.js';

const TARGETS = [
  {
    artistId: 'a1111111-1111-4111-8111-111111111111',
    outboxId: '8ac18567-a323-459f-b5a5-9463c0485c6e',
    integrationKey: 'vladimir-staging',
  },
  {
    artistId: 'a2222222-2222-4222-8222-222222222222',
    outboxId: '271407db-640d-405b-bc89-4838cf8d56b5',
    integrationKey: 'kristina-staging',
  },
];

const evidencePath = process.env.PREFLIGHT_EVIDENCE_PATH;
assert.ok(evidencePath);
assert.equal(process.env.STAGING_SUPABASE_URL, 'https://gwaliusblwrzisrwnsvs.supabase.co');
assert.match(process.env.SUPABASE_SECRET_KEY ?? '', /^sb_secret_/);

const expectedBindings = TARGETS.map(({ integrationKey }) => (
  bindingNameFor('telegram', integrationKey)
)).sort();
assert.deepEqual(
  Object.keys(process.env).filter((key) => key.startsWith('ARTIST_TELEGRAM_')).sort(),
  expectedBindings,
);
assert.ok(!process.env.TELEGRAM_BOT_TOKEN);
assert.ok(!process.env.TELEGRAM_CHAT_ID);
assert.ok(!process.env.KRISTINA_TELEGRAM_BOT_TOKEN);
assert.ok(!process.env.KRISTINA_TELEGRAM_CHAT_ID);

const runtimeEnv = {
  SUPABASE_URL: process.env.STAGING_SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};
for (const bindingName of expectedBindings) {
  assert.ok(process.env[bindingName]);
  runtimeEnv[bindingName] = process.env[bindingName];
}

const supabase = createSupabaseClient(runtimeEnv);
const safeRoutes = [];
for (const target of TARGETS) {
  const rows = await supabase.rpc('resolve_outbox_route', { p_outbox_id: target.outboxId });
  assert.ok(Array.isArray(rows) && rows.length === 1);
  const route = rows[0];
  assert.equal(route.outbox_id, target.outboxId);
  assert.equal(route.artist_id, target.artistId);
  assert.equal(route.kind, 'telegram_notification');
  assert.equal(route.integration_type, 'telegram');
  assert.equal(route.provider, 'telegram');
  assert.equal(route.integration_key, target.integrationKey);

  const destination = await checkTelegramDestination(runtimeEnv, route);
  if (!destination.reachable) {
    const status = destination.statusClass ? ` (${destination.statusClass})` : '';
    throw new Error(`safe Telegram destination preflight failed: ${destination.errorCode}${status}`);
  }

  safeRoutes.push({
    artist_id: route.artist_id,
    outbox_id: route.outbox_id,
    integration_key: route.integration_key,
    binding_name: bindingNameFor('telegram', route.integration_key),
    destination_reachable: true,
  });
}

assert.notEqual(safeRoutes[0].binding_name, safeRoutes[1].binding_name);
await writeFile(evidencePath, `${JSON.stringify({ routes: safeRoutes }, null, 2)}\n`, { mode: 0o600 });
console.log('Telegram automatic drain no-send preflight passed for two artist-scoped routes.');
