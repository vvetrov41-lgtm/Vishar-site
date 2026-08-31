import assert from 'node:assert/strict';
import { __testing } from '../admin/functions/api/whatsapp/existing-account/provision.js';

const {
  APPROVED_ARTISTS,
  discoverSinglePhone,
  verifyExistingTarget,
  verifyMetaAccessToken,
} = __testing;

const VLADIMIR_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ID = 'a2222222-2222-4222-8222-222222222222';
const META_APP_ID = '1481226093843982';
const syntheticToken = `synthetic-system-user-token-${'x'.repeat(64)}`;
const env = { META_APP_SECRET: 'synthetic-meta-app-secret-for-test' };

assert.deepEqual(Object.keys(APPROVED_ARTISTS).sort(), [KRISTINA_ID, VLADIMIR_ID].sort());
assert.equal(APPROVED_ARTISTS[VLADIMIR_ID].wabaId, '341184815737145');
assert.equal(APPROVED_ARTISTS[VLADIMIR_ID].phoneNumberId, '328102027058293');
assert.equal(APPROVED_ARTISTS[KRISTINA_ID].integrationKey, 'kristina-production');
assert.equal(APPROVED_ARTISTS[KRISTINA_ID].bindingName, 'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION');
assert.equal(APPROVED_ARTISTS[KRISTINA_ID].wabaId, '462106700328578');
assert.equal(APPROVED_ARTISTS[KRISTINA_ID].phoneNumberId, null);

async function withFetch(mock, action) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await action();
  } finally {
    globalThis.fetch = previous;
  }
}

await withFetch(async (url, init) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.pathname, '/v25.0/debug_token');
  assert.equal(parsed.searchParams.get('input_token'), syntheticToken);
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.headers?.authorization, `Bearer ${META_APP_ID}|${env.META_APP_SECRET}`);
  assert.equal(String(url).includes(env.META_APP_SECRET), false);
  return Response.json({
    data: {
      is_valid: true,
      app_id: META_APP_ID,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    },
  });
}, async () => {
  await verifyMetaAccessToken(syntheticToken, env);
});

await withFetch(async () => Response.json({
  data: {
    is_valid: true,
    app_id: META_APP_ID,
    scopes: ['whatsapp_business_management'],
  },
}), async () => {
  await assert.rejects(
    verifyMetaAccessToken(syntheticToken, env),
    /meta_token_missing_scope/,
  );
});

let discoveryCalls = 0;
await withFetch(async (url, init) => {
  discoveryCalls += 1;
  const parsed = new URL(String(url));
  assert.equal(init?.headers?.authorization, `Bearer ${syntheticToken}`);
  if (parsed.pathname.endsWith('/462106700328578/phone_numbers')) {
    assert.equal(parsed.searchParams.get('limit'), '2');
    return Response.json({
      data: [{ id: '987654321012345', display_phone_number: '+44 7000 000002', verified_name: 'Kristina' }],
      paging: {},
    });
  }
  if (parsed.pathname.endsWith('/987654321012345')) {
    return Response.json({ id: '987654321012345', display_phone_number: '+44 7000 000002', verified_name: 'Kristina' });
  }
  throw new Error(`Unexpected Graph URL: ${url}`);
}, async () => {
  const phone = await discoverSinglePhone(syntheticToken, '462106700328578');
  assert.equal(phone.id, '987654321012345');
});
assert.equal(discoveryCalls, 2);

await withFetch(async () => Response.json({
  data: [
    { id: '111111111111111' },
    { id: '222222222222222' },
  ],
  paging: {},
}), async () => {
  await assert.rejects(
    discoverSinglePhone(syntheticToken, '462106700328578'),
    /meta_phone_selection_ambiguous/,
  );
});

let selectionCalls = 0;
await withFetch(async (url) => {
  selectionCalls += 1;
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith('/462106700328578')) {
    return Response.json({ id: '462106700328578', name: 'Kristina Vishar' });
  }
  if (parsed.pathname.endsWith('/462106700328578/phone_numbers')) {
    return Response.json({
      data: [{ id: '987654321012345', display_phone_number: '+44 7000 000002', verified_name: 'Kristina' }],
      paging: {},
    });
  }
  if (parsed.pathname.endsWith('/987654321012345')) {
    return Response.json({ id: '987654321012345', display_phone_number: '+44 7000 000002', verified_name: 'Kristina' });
  }
  throw new Error(`Unexpected Graph URL: ${url}`);
}, async () => {
  const selected = await verifyExistingTarget(syntheticToken, APPROVED_ARTISTS[KRISTINA_ID]);
  assert.deepEqual(selected, {
    phoneNumberId: '987654321012345',
    wabaName: 'Kristina Vishar',
    displayPhoneNumber: '+44 7000 000002',
    verifiedName: 'Kristina',
  });
});
assert.equal(selectionCalls, 3);

console.log('WhatsApp existing-account provisioning boundary: ok');
