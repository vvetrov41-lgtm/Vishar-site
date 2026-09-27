import assert from 'node:assert/strict';
import { onRequestPost, __testing } from '../admin/functions/api/whatsapp/existing-account/provision.js';

const {
  APPROVED_ARTISTS,
  verifyExistingTarget,
  verifyMetaAccessToken,
} = __testing;

const VLADIMIR_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ID = 'a2222222-2222-4222-8222-222222222222';
const META_APP_ID = '1481226093843982';
const VLADIMIR_WABA_ID = '341184815737145';
const VLADIMIR_PHONE_ID = '328102027058293';
const KRISTINA_WABA_ID = '462106700328578';
const VLADIMIR_BINDING = 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION';
const KRISTINA_BINDING = 'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION';
const syntheticToken = `synthetic-system-user-token-${'x'.repeat(64)}`;
const crmToken = `synthetic-crm-session-${'c'.repeat(64)}`;
const appSecret = 'synthetic-meta-app-secret-for-test';
const operatorId = '11111111-1111-4111-8111-111111111111';
const env = {
  META_APP_SECRET: appSecret,
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-supabase-publishable-key',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_WORKERS_EDIT_TOKEN: 'synthetic-cloudflare-workers-edit-token',
};

assert.deepEqual(Object.keys(APPROVED_ARTISTS).sort(), [KRISTINA_ID, VLADIMIR_ID].sort());
assert.deepEqual(APPROVED_ARTISTS[VLADIMIR_ID], {
  integrationKey: 'vladimir-production',
  bindingName: VLADIMIR_BINDING,
  wabaId: VLADIMIR_WABA_ID,
  phoneNumberId: VLADIMIR_PHONE_ID,
});
assert.deepEqual(APPROVED_ARTISTS[KRISTINA_ID], {
  integrationKey: 'kristina-production',
  bindingName: KRISTINA_BINDING,
  wabaId: KRISTINA_WABA_ID,
  phoneNumberId: null,
});

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
  assert.equal(init?.headers?.authorization, `Bearer ${META_APP_ID}|${appSecret}`);
  assert.equal(String(url).includes(appSecret), false);
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

for (const [data, error] of [
  [
    { is_valid: false, app_id: META_APP_ID, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
    'meta_token_invalid',
  ],
  [
    { is_valid: true, app_id: '9999999999999999', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
    'meta_token_app_mismatch',
  ],
  [
    { is_valid: true, app_id: META_APP_ID, scopes: ['whatsapp_business_management'] },
    'meta_token_missing_scope',
  ],
]) {
  await withFetch(async () => Response.json({ data }), async () => {
    await assert.rejects(verifyMetaAccessToken(syntheticToken, env), new RegExp(error));
  });
}

await withFetch(async (url) => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith(`/${VLADIMIR_WABA_ID}`)) {
    return Response.json({ id: VLADIMIR_WABA_ID, name: 'Vladimir WABA' });
  }
  if (parsed.pathname.endsWith(`/${VLADIMIR_WABA_ID}/phone_numbers`)) {
    assert.equal(parsed.searchParams.get('limit'), '100');
    return Response.json({
      data: [{ id: VLADIMIR_PHONE_ID, display_phone_number: '+44 7507 262323', verified_name: 'Vladimir' }],
    });
  }
  throw new Error(`Unexpected Graph URL: ${url}`);
}, async () => {
  const selected = await verifyExistingTarget(syntheticToken, APPROVED_ARTISTS[VLADIMIR_ID]);
  assert.equal(selected.phoneNumberId, VLADIMIR_PHONE_ID);
});

const KRISTINA_PHONE_ID = '987654321012345';
await withFetch(async (url) => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith(`/${KRISTINA_WABA_ID}`)) {
    return Response.json({ id: KRISTINA_WABA_ID, name: 'Kristina Vishar' });
  }
  if (parsed.pathname.endsWith(`/${KRISTINA_WABA_ID}/phone_numbers`)) {
    assert.equal(parsed.searchParams.get('limit'), '2');
    return Response.json({
      data: [{ id: KRISTINA_PHONE_ID, display_phone_number: '+44 7000 000002', verified_name: 'Kristina' }],
      paging: {},
    });
  }
  throw new Error(`Unexpected Graph URL: ${url}`);
}, async () => {
  const selected = await verifyExistingTarget(syntheticToken, APPROVED_ARTISTS[KRISTINA_ID]);
  assert.deepEqual(selected, {
    phoneNumberId: KRISTINA_PHONE_ID,
    wabaName: 'Kristina Vishar',
    displayPhoneNumber: '+44 7000 000002',
    verifiedName: 'Kristina',
  });
});

for (const payload of [
  {
    data: [{ id: '111111111111111' }, { id: '222222222222222' }],
    paging: {},
  },
  {
    data: [{ id: KRISTINA_PHONE_ID }],
    paging: { next: 'https://graph.facebook.com/next' },
  },
]) {
  await withFetch(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith(`/${KRISTINA_WABA_ID}`)) {
      return Response.json({ id: KRISTINA_WABA_ID, name: 'Kristina Vishar' });
    }
    if (parsed.pathname.endsWith(`/${KRISTINA_WABA_ID}/phone_numbers`)) return Response.json(payload);
    throw new Error(`Unexpected Graph URL: ${url}`);
  }, async () => {
    await assert.rejects(
      verifyExistingTarget(syntheticToken, APPROVED_ARTISTS[KRISTINA_ID]),
      /meta_phone_selection_ambiguous/,
    );
  });
}

function requestFor(artistId) {
  return new Request('https://crm.vishartattoo.com/api/whatsapp/existing-account/provision', {
    method: 'POST',
    headers: {
      origin: 'https://crm.vishartattoo.com',
      authorization: `Bearer ${crmToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ artist_id: artistId, access_token: syntheticToken }),
  });
}

function artistFixture(artistId) {
  if (artistId === VLADIMIR_ID) {
    return {
      approved: APPROVED_ARTISTS[VLADIMIR_ID],
      wabaName: 'Vladimir WABA',
      phoneRows: [{ id: VLADIMIR_PHONE_ID, display_phone_number: '+44 7507 262323', verified_name: 'Vladimir' }],
      phonePaging: {},
      displayPhone: '+44 7507 262323',
      verifiedName: 'Vladimir',
    };
  }
  if (artistId === KRISTINA_ID) {
    return {
      approved: APPROVED_ARTISTS[KRISTINA_ID],
      wabaName: 'Kristina Vishar',
      phoneRows: [{ id: KRISTINA_PHONE_ID, display_phone_number: '+44 7000 000002', verified_name: 'Kristina' }],
      phonePaging: {},
      displayPhone: '+44 7000 000002',
      verifiedName: 'Kristina',
    };
  }
  throw new Error('Unknown test artist');
}

async function runProvisionScenario(overrides = {}) {
  const artistId = overrides.artistId ?? VLADIMIR_ID;
  const fixture = artistFixture(artistId);
  const approved = fixture.approved;
  const debugData = overrides.debugData ?? {
    is_valid: true,
    app_id: META_APP_ID,
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  };
  const wabaResponseId = overrides.wabaResponseId ?? approved.wabaId;
  const phoneRows = overrides.phoneRows ?? fixture.phoneRows;
  const phonePaging = overrides.phonePaging ?? fixture.phonePaging;
  const subscriptionApps = overrides.subscriptionApps ?? [{ id: META_APP_ID, name: 'Vishar CRM' }];
  const missingSecretWorker = overrides.missingSecretWorker ?? null;
  const state = {
    metaValidationComplete: false,
    cloudflareWrites: [],
    cloudflareReadbacks: [],
    subscriptionPosts: 0,
    subscriptionReadbacks: 0,
    supabaseMutations: [],
    metaTargetReads: 0,
    firstWriteAfterValidation: true,
  };

  const mockFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();

    if (url.origin === 'https://vfjexhfdbrjmuxfdvbdx.supabase.co') {
      if (url.pathname === '/auth/v1/user') return Response.json({ id: operatorId });
      if (url.pathname === '/rest/v1/profiles') {
        return Response.json([{ id: operatorId, role: 'owner', is_active: true }]);
      }
      if (url.pathname === '/rest/v1/artist_memberships') {
        return Response.json([{
          profile_id: operatorId,
          artist_id: artistId,
          access_level: 'manager',
          can_manage_integrations: true,
          is_active: true,
        }]);
      }
      if (url.pathname === '/rest/v1/artist_integrations' && method === 'GET') {
        return Response.json([{
          artist_id: artistId,
          provider: 'meta_cloud_api',
          integration_key: approved.integrationKey,
          is_enabled: true,
          configuration: {},
          connected_at: null,
        }]);
      }
      if (url.pathname === '/rest/v1/rpc/complete_artist_whatsapp_connection' && method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        assert.deepEqual(body, {
          p_artist_id: artistId,
          p_integration_key: approved.integrationKey,
        });
        assert.equal(JSON.stringify(body).includes(syntheticToken), false);
        assert.equal(JSON.stringify(body).includes(appSecret), false);
        state.supabaseMutations.push(body);
        return Response.json({
          artist_id: artistId,
          integration_key: approved.integrationKey,
          is_enabled: true,
          connected_at: new Date().toISOString(),
          configuration: {},
        });
      }
    }

    if (url.origin === 'https://graph.facebook.com') {
      if (url.pathname === '/v25.0/debug_token') {
        assert.equal(url.searchParams.get('input_token'), syntheticToken);
        assert.equal(init.headers?.authorization, `Bearer ${META_APP_ID}|${appSecret}`);
        return Response.json({ data: debugData });
      }
      if (url.pathname === `/v25.0/${approved.wabaId}`) {
        state.metaTargetReads += 1;
        return Response.json({ id: wabaResponseId, name: fixture.wabaName });
      }
      if (url.pathname === `/v25.0/${approved.wabaId}/phone_numbers`) {
        state.metaTargetReads += 1;
        const validPhone = approved.phoneNumberId
          ? phoneRows.some((row) => String(row?.id || '') === approved.phoneNumberId)
          : phoneRows.length === 1 && !phonePaging?.next && /^[0-9]{5,32}$/.test(String(phoneRows[0]?.id || ''));
        if (wabaResponseId === approved.wabaId && validPhone) state.metaValidationComplete = true;
        return Response.json({ data: phoneRows, paging: phonePaging });
      }
      if (url.pathname === `/v25.0/${approved.wabaId}/subscribed_apps` && method === 'POST') {
        state.subscriptionPosts += 1;
        return Response.json({ success: true });
      }
      if (url.pathname === `/v25.0/${approved.wabaId}/subscribed_apps` && method === 'GET') {
        state.subscriptionReadbacks += 1;
        return Response.json({ data: subscriptionApps });
      }
    }

    if (url.origin === 'https://api.cloudflare.com' && url.pathname.endsWith('/secrets')) {
      const worker = url.pathname.includes('/vishar-whatsapp-drain-production/')
        ? 'drain'
        : url.pathname.includes('/vishar-whatsapp-webhook-production/')
          ? 'webhook'
          : 'unknown';
      if (method === 'PUT') {
        state.firstWriteAfterValidation = state.firstWriteAfterValidation && state.metaValidationComplete;
        const body = JSON.parse(String(init.body || '{}'));
        assert.equal(body.name, approved.bindingName);
        assert.equal(typeof body.text, 'string');
        assert.equal(body.text.includes(syntheticToken), true);
        state.cloudflareWrites.push(worker);
        return Response.json({ success: true, result: { name: approved.bindingName } });
      }
      if (method === 'GET') {
        state.cloudflareReadbacks.push(worker);
        return Response.json({
          success: true,
          result: worker === missingSecretWorker ? [] : [{ name: approved.bindingName, type: 'secret_text' }],
        });
      }
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const capturedLogs = [];
  const consoleMethods = ['log', 'error', 'warn'];
  const previousConsole = Object.fromEntries(consoleMethods.map((name) => [name, console[name]]));
  for (const name of consoleMethods) console[name] = (...args) => capturedLogs.push(args.map(String).join(' '));

  let response;
  try {
    response = await withFetch(mockFetch, () => onRequestPost({ request: requestFor(artistId), env }));
  } finally {
    for (const name of consoleMethods) console[name] = previousConsole[name];
  }
  const text = await response.text();
  assert.equal(text.includes(syntheticToken), false);
  assert.equal(text.includes(appSecret), false);
  assert.equal(capturedLogs.some((entry) => entry.includes(syntheticToken) || entry.includes(appSecret)), false);
  return { response, payload: JSON.parse(text), state };
}

for (const scenario of [
  {
    name: 'invalid token',
    overrides: { debugData: { is_valid: false, app_id: META_APP_ID, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } },
    error: 'meta_token_invalid',
  },
  {
    name: 'wrong app id',
    overrides: { debugData: { is_valid: true, app_id: '9999999999999999', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } },
    error: 'meta_token_app_mismatch',
  },
  {
    name: 'missing permission',
    overrides: { debugData: { is_valid: true, app_id: META_APP_ID, scopes: ['whatsapp_business_management'] } },
    error: 'meta_token_missing_scope',
  },
  {
    name: 'wrong WABA',
    overrides: { wabaResponseId: '999999999999999' },
    error: 'meta_waba_mismatch',
  },
  {
    name: 'wrong Vladimir phone id',
    overrides: { phoneRows: [{ id: '999999999999999', display_phone_number: '+44 7000 000000' }] },
    error: 'meta_phone_not_in_waba',
  },
]) {
  const result = await runProvisionScenario(scenario.overrides);
  assert.equal(result.response.status, 409, scenario.name);
  assert.equal(result.payload.error, scenario.error, scenario.name);
  assert.deepEqual(result.state.cloudflareWrites, [], `${scenario.name}: Cloudflare must not mutate before Meta checks pass`);
  assert.deepEqual(result.state.supabaseMutations, [], `${scenario.name}: CRM must not become connected`);
}

const ambiguousKristina = await runProvisionScenario({
  artistId: KRISTINA_ID,
  phoneRows: [{ id: '111111111111111' }, { id: '222222222222222' }],
});
assert.equal(ambiguousKristina.response.status, 409);
assert.equal(ambiguousKristina.payload.error, 'meta_phone_selection_ambiguous');
assert.deepEqual(ambiguousKristina.state.cloudflareWrites, []);
assert.deepEqual(ambiguousKristina.state.supabaseMutations, []);

const missingSubscription = await runProvisionScenario({ artistId: KRISTINA_ID, subscriptionApps: [] });
assert.equal(missingSubscription.response.status, 500);
assert.equal(missingSubscription.payload.error, 'meta_waba_subscription_readback_failed');
assert.deepEqual(missingSubscription.state.cloudflareWrites, ['drain', 'webhook']);
assert.deepEqual(missingSubscription.state.supabaseMutations, []);

const missingCloudflareReadback = await runProvisionScenario({ artistId: KRISTINA_ID, missingSecretWorker: 'drain' });
assert.equal(missingCloudflareReadback.response.status, 500);
assert.equal(missingCloudflareReadback.payload.error, 'cloudflare_binding_readback_failed');
assert.deepEqual(missingCloudflareReadback.state.supabaseMutations, []);

for (const artistId of [VLADIMIR_ID, KRISTINA_ID]) {
  const fixture = artistFixture(artistId);
  const success = await runProvisionScenario({ artistId });
  assert.equal(success.response.status, 200);
  assert.deepEqual(success.state.cloudflareWrites, ['drain', 'webhook']);
  assert.deepEqual(success.state.cloudflareReadbacks, ['drain', 'webhook']);
  assert.equal(success.state.firstWriteAfterValidation, true);
  assert.equal(success.state.subscriptionPosts, 1);
  assert.equal(success.state.subscriptionReadbacks, 1);
  assert.equal(success.state.metaTargetReads, 4);
  assert.equal(success.state.supabaseMutations.length, 1);
  assert.equal(success.payload.ok, true);
  assert.equal(success.payload.connected, true);
  assert.equal(typeof success.payload.connected_at, 'string');
  assert.equal(success.payload.integration_key, fixture.approved.integrationKey);
  assert.equal(success.payload.display_phone_number, fixture.displayPhone);
  assert.equal(success.payload.verified_name, fixture.verifiedName);
  assert.equal('access_token' in success.payload, false);
  assert.equal('app_secret' in success.payload, false);
}

console.log('WhatsApp existing-account Vladimir + Kristina provisioning boundary: ok');
