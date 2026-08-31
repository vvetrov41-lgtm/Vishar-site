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
const VLADIMIR_BINDING = 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION';
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

assert.deepEqual(Object.keys(APPROVED_ARTISTS), [VLADIMIR_ID]);
assert.equal(APPROVED_ARTISTS[VLADIMIR_ID].wabaId, VLADIMIR_WABA_ID);
assert.equal(APPROVED_ARTISTS[VLADIMIR_ID].phoneNumberId, VLADIMIR_PHONE_ID);
assert.equal(APPROVED_ARTISTS[VLADIMIR_ID].bindingName, VLADIMIR_BINDING);
assert.equal(APPROVED_ARTISTS[KRISTINA_ID], undefined);

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

await withFetch(async () => Response.json({
  data: {
    is_valid: false,
    app_id: META_APP_ID,
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  },
}), async () => {
  await assert.rejects(verifyMetaAccessToken(syntheticToken, env), /meta_token_invalid/);
});

await withFetch(async () => Response.json({
  data: {
    is_valid: true,
    app_id: '9999999999999999',
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  },
}), async () => {
  await assert.rejects(verifyMetaAccessToken(syntheticToken, env), /meta_token_app_mismatch/);
});

await withFetch(async () => Response.json({
  data: {
    is_valid: true,
    app_id: META_APP_ID,
    scopes: ['whatsapp_business_management'],
  },
}), async () => {
  await assert.rejects(verifyMetaAccessToken(syntheticToken, env), /meta_token_missing_scope/);
});

await withFetch(async (url, init) => {
  const parsed = new URL(String(url));
  assert.equal(init?.headers?.authorization, `Bearer ${syntheticToken}`);
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
  assert.deepEqual(selected, {
    phoneNumberId: VLADIMIR_PHONE_ID,
    wabaName: 'Vladimir WABA',
    displayPhoneNumber: '+44 7507 262323',
    verifiedName: 'Vladimir',
  });
});

function requestFor(artistId = VLADIMIR_ID) {
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

async function runProvisionScenario(overrides = {}) {
  const debugData = overrides.debugData ?? {
    is_valid: true,
    app_id: META_APP_ID,
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  };
  const wabaResponseId = overrides.wabaResponseId ?? VLADIMIR_WABA_ID;
  const phoneRows = overrides.phoneRows ?? [{
    id: VLADIMIR_PHONE_ID,
    display_phone_number: '+44 7507 262323',
    verified_name: 'Vladimir',
  }];
  const subscriptionApps = overrides.subscriptionApps ?? [{ id: META_APP_ID, name: 'Vishar CRM' }];
  const missingSecretWorker = overrides.missingSecretWorker ?? null;
  const artistId = overrides.artistId ?? VLADIMIR_ID;
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
          integration_key: artistId === VLADIMIR_ID ? 'vladimir-production' : 'kristina-production',
          is_enabled: true,
          configuration: {},
          connected_at: null,
        }]);
      }
      if (url.pathname === '/rest/v1/artist_integrations' && method === 'PATCH') {
        const body = JSON.parse(String(init.body || '{}'));
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes(syntheticToken), false);
        assert.equal(serialized.includes(appSecret), false);
        assert.deepEqual(Object.keys(body), ['connected_at']);
        state.supabaseMutations.push(body);
        return Response.json([{
          artist_id: VLADIMIR_ID,
          integration_key: 'vladimir-production',
          is_enabled: true,
          connected_at: body.connected_at,
          configuration: {},
        }]);
      }
    }

    if (url.origin === 'https://graph.facebook.com') {
      if (url.pathname === '/v25.0/debug_token') {
        assert.equal(url.searchParams.get('input_token'), syntheticToken);
        assert.equal(init.headers?.authorization, `Bearer ${META_APP_ID}|${appSecret}`);
        return Response.json({ data: debugData });
      }
      if (url.pathname === `/v25.0/${VLADIMIR_WABA_ID}`) {
        state.metaTargetReads += 1;
        return Response.json({ id: wabaResponseId, name: 'Vladimir WABA' });
      }
      if (url.pathname === `/v25.0/${VLADIMIR_WABA_ID}/phone_numbers`) {
        state.metaTargetReads += 1;
        const hasExpectedPhone = phoneRows.some((row) => String(row?.id || '') === VLADIMIR_PHONE_ID);
        if (wabaResponseId === VLADIMIR_WABA_ID && hasExpectedPhone) state.metaValidationComplete = true;
        return Response.json({ data: phoneRows });
      }
      if (url.pathname === `/v25.0/${VLADIMIR_WABA_ID}/subscribed_apps` && method === 'POST') {
        state.subscriptionPosts += 1;
        return Response.json({ success: true });
      }
      if (url.pathname === `/v25.0/${VLADIMIR_WABA_ID}/subscribed_apps` && method === 'GET') {
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
        assert.equal(body.name, VLADIMIR_BINDING);
        assert.equal(typeof body.text, 'string');
        assert.equal(body.text.includes(syntheticToken), true);
        state.cloudflareWrites.push(worker);
        return Response.json({ success: true, result: { name: VLADIMIR_BINDING } });
      }
      if (method === 'GET') {
        state.cloudflareReadbacks.push(worker);
        return Response.json({
          success: true,
          result: worker === missingSecretWorker ? [] : [{ name: VLADIMIR_BINDING, type: 'secret_text' }],
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
  return { response, text, payload: JSON.parse(text), state, capturedLogs };
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
    name: 'wrong phone id',
    overrides: { phoneRows: [{ id: '999999999999999', display_phone_number: '+44 7000 000000' }] },
    error: 'meta_phone_not_in_waba',
  },
]) {
  const result = await runProvisionScenario(scenario.overrides);
  assert.equal(result.response.status, 409, scenario.name);
  assert.equal(result.payload.error, scenario.error, scenario.name);
  assert.deepEqual(result.state.cloudflareWrites, [], `${scenario.name}: Cloudflare must not mutate before all Meta checks pass`);
  assert.deepEqual(result.state.supabaseMutations, [], `${scenario.name}: CRM must not become connected`);
}

const kristina = await runProvisionScenario({ artistId: KRISTINA_ID });
assert.equal(kristina.response.status, 403);
assert.equal(kristina.payload.error, 'artist_scope_not_allowed');
assert.deepEqual(kristina.state.cloudflareWrites, []);
assert.deepEqual(kristina.state.supabaseMutations, []);

const missingSubscription = await runProvisionScenario({ subscriptionApps: [] });
assert.equal(missingSubscription.response.status, 500);
assert.equal(missingSubscription.payload.error, 'meta_waba_subscription_readback_failed');
assert.deepEqual(missingSubscription.state.cloudflareWrites, ['drain', 'webhook']);
assert.deepEqual(missingSubscription.state.supabaseMutations, []);

const missingCloudflareReadback = await runProvisionScenario({ missingSecretWorker: 'drain' });
assert.equal(missingCloudflareReadback.response.status, 500);
assert.equal(missingCloudflareReadback.payload.error, 'cloudflare_binding_readback_failed');
assert.deepEqual(missingCloudflareReadback.state.supabaseMutations, []);

const success = await runProvisionScenario();
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
assert.equal(success.payload.integration_key, 'vladimir-production');
assert.equal(success.payload.display_phone_number, '+44 7507 262323');
assert.equal(success.payload.verified_name, 'Vladimir');
assert.equal('access_token' in success.payload, false);
assert.equal('app_secret' in success.payload, false);

console.log('WhatsApp existing-account Vladimir provisioning boundary: ok');
