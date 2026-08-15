// WhatsApp provider routing tests.
//
// These cover the artist-isolation boundary only. No Meta endpoint is
// contacted, no credential exists and nothing is sent: the fixtures below are
// obviously-synthetic strings, and the assertions are about which binding a
// route selects and which ones it refuses to fall back to.

import assert from 'node:assert/strict';
import {
  ROUTED_INTEGRATION_TYPES,
  bindingNameFor,
  integrationTypeForOutboxKind,
  resolveProviderBinding,
  ProviderRouteError,
} from '../workers/lib/provider-routing.js';
import { OUTBOX_KINDS, whatsappDedupeKey } from '../workers/lib/outbox.js';

let passes = 0;
let failures = 0;

function test(name, run) {
  try {
    run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const VLADIMIR_KEY = 'vladimir-production';
const KRISTINA_KEY = 'kristina-production';

// Deliberately not Meta-shaped. A realistic token shape has no place in a
// repository, even as a fixture.
const vladimirBinding = {
  phoneNumberId: 'unit-test-vladimir-phone-number-id',
  wabaId: 'unit-test-vladimir-waba-id',
  accessToken: 'unit-test-vladimir-access-token',
  appSecret: 'unit-test-vladimir-app-secret',
};
const kristinaBinding = {
  phoneNumberId: 'unit-test-kristina-phone-number-id',
  wabaId: 'unit-test-kristina-waba-id',
  accessToken: 'unit-test-kristina-access-token',
  appSecret: 'unit-test-kristina-app-secret',
};

function whatsappRoute(integrationKey) {
  return {
    kind: 'whatsapp_message',
    integration_type: 'whatsapp',
    provider: 'meta_cloud_api',
    integration_key: integrationKey,
  };
}

function envWith(entries) {
  const env = {};
  for (const [key, value] of entries) {
    env[bindingNameFor('whatsapp', key)] = JSON.stringify(value);
  }
  return env;
}

test('whatsapp is a routed integration type', () => {
  assert.ok(ROUTED_INTEGRATION_TYPES.has('whatsapp'));
});

test('the WhatsApp outbox kind maps to the WhatsApp integration type', () => {
  assert.equal(integrationTypeForOutboxKind('whatsapp_message'), 'whatsapp');
  assert.equal(OUTBOX_KINDS.WHATSAPP_MESSAGE, 'whatsapp_message');
});

test('existing outbox kinds keep their integration types', () => {
  assert.equal(integrationTypeForOutboxKind('telegram_notification'), 'telegram');
  assert.equal(integrationTypeForOutboxKind('calendar_create'), 'calendar');
  assert.equal(integrationTypeForOutboxKind('approved_email'), 'email');
  assert.equal(integrationTypeForOutboxKind('reconciliation'), null);
});

test('binding names are derived deterministically from the integration key', () => {
  assert.equal(
    bindingNameFor('whatsapp', VLADIMIR_KEY),
    'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION'
  );
  assert.equal(
    bindingNameFor('whatsapp', KRISTINA_KEY),
    'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION'
  );
  // The two artists can never collide on one binding name.
  assert.notEqual(
    bindingNameFor('whatsapp', VLADIMIR_KEY),
    bindingNameFor('whatsapp', KRISTINA_KEY)
  );
  // Nor can WhatsApp collide with the artist's Telegram binding.
  assert.notEqual(
    bindingNameFor('whatsapp', VLADIMIR_KEY),
    bindingNameFor('telegram', VLADIMIR_KEY)
  );
});

test('each artist resolves to their own WhatsApp binding', () => {
  const env = envWith([
    [VLADIMIR_KEY, vladimirBinding],
    [KRISTINA_KEY, kristinaBinding],
  ]);

  const vladimir = resolveProviderBinding(env, whatsappRoute(VLADIMIR_KEY));
  assert.equal(vladimir.bindingName, 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION');
  assert.equal(vladimir.integrationType, 'whatsapp');
  assert.equal(vladimir.credentials.phoneNumberId, vladimirBinding.phoneNumberId);

  const kristina = resolveProviderBinding(env, whatsappRoute(KRISTINA_KEY));
  assert.equal(kristina.bindingName, 'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION');
  assert.equal(kristina.credentials.phoneNumberId, kristinaBinding.phoneNumberId);

  // The decisive isolation assertion: neither artist can reach the other's
  // phone number id or token through a resolved route.
  assert.notEqual(vladimir.credentials.phoneNumberId, kristina.credentials.phoneNumberId);
  assert.notEqual(vladimir.credentials.accessToken, kristina.credentials.accessToken);
});

test('a missing Vladimir binding fails closed and never borrows Kristina', () => {
  const env = envWith([[KRISTINA_KEY, kristinaBinding]]);
  assert.throws(
    () => resolveProviderBinding(env, whatsappRoute(VLADIMIR_KEY)),
    (error) => error instanceof ProviderRouteError && error.code === 'provider_binding_missing'
  );
});

test('a missing Kristina binding fails closed and never borrows Vladimir', () => {
  const env = envWith([[VLADIMIR_KEY, vladimirBinding]]);
  assert.throws(
    () => resolveProviderBinding(env, whatsappRoute(KRISTINA_KEY)),
    (error) => error instanceof ProviderRouteError && error.code === 'provider_binding_missing'
  );
});

test('there is no global WhatsApp fallback binding', () => {
  const env = {
    WHATSAPP_ACCESS_TOKEN: 'unit-test-global-token',
    WHATSAPP_PHONE_NUMBER_ID: 'unit-test-global-phone-number-id',
    ARTIST_WHATSAPP: JSON.stringify(vladimirBinding),
  };
  assert.throws(
    () => resolveProviderBinding(env, whatsappRoute(VLADIMIR_KEY)),
    (error) => error instanceof ProviderRouteError && error.code === 'provider_binding_missing'
  );
});

test('a route whose integration type disagrees with its kind is rejected', () => {
  const env = envWith([[VLADIMIR_KEY, vladimirBinding]]);
  assert.throws(
    () => resolveProviderBinding(env, {
      kind: 'whatsapp_message',
      integration_type: 'telegram',
      provider: 'meta_cloud_api',
      integration_key: VLADIMIR_KEY,
    }),
    (error) => error instanceof ProviderRouteError && error.code === 'provider_route_invalid'
  );
});

test('a WhatsApp binding cannot be reached through a Telegram job', () => {
  const env = envWith([[VLADIMIR_KEY, vladimirBinding]]);
  assert.throws(
    () => resolveProviderBinding(env, {
      kind: 'telegram_notification',
      integration_type: 'whatsapp',
      provider: 'meta_cloud_api',
      integration_key: VLADIMIR_KEY,
    }),
    (error) => error instanceof ProviderRouteError && error.code === 'provider_route_invalid'
  );
});

test('a malformed integration key is rejected before any binding lookup', () => {
  for (const key of ['', 'A', 'Vladimir-Production', 'vladimir production', '../secret']) {
    assert.throws(
      () => bindingNameFor('whatsapp', key),
      (error) => error instanceof ProviderRouteError && error.code === 'provider_route_invalid',
      `expected ${JSON.stringify(key)} to be rejected`
    );
  }
});

test('a non-object binding envelope is rejected', () => {
  const bindingName = bindingNameFor('whatsapp', VLADIMIR_KEY);
  for (const raw of ['not json', '[]', '"a string"', 'null']) {
    assert.throws(
      () => resolveProviderBinding({ [bindingName]: raw }, whatsappRoute(VLADIMIR_KEY)),
      (error) => error instanceof ProviderRouteError && error.code === 'provider_binding_invalid',
      `expected ${JSON.stringify(raw)} to be rejected`
    );
  }
});

test('the dedupe key matches the database contract in migration 0047', () => {
  assert.equal(
    whatsappDedupeKey('7a111111-1111-4111-8111-111111111111'),
    'whatsapp:send:7a111111-1111-4111-8111-111111111111'
  );
  // Must satisfy integration_outbox_dedupe_key_shape.
  assert.match(
    whatsappDedupeKey('7a111111-1111-4111-8111-111111111111'),
    /^[a-z][a-z0-9_]*:[a-z0-9_:.-]{1,180}$/
  );
});

if (failures > 0) {
  console.error(`WhatsApp routing tests failed: ${failures} of ${passes + failures}`);
  process.exit(1);
}

console.log(
  `WhatsApp routing tests passed: ${passes} cases covering artist-specific bindings, `
  + 'fail-closed missing routes, no global fallback and no cross-artist reuse.'
);
