import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __testing,
  onRequestPost,
} from '../admin/functions/api/whatsapp/embedded-signup/provision.js';

const ENDPOINT = 'https://crm.vishartattoo.com/api/whatsapp/embedded-signup/provision';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const KRISTINA_MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const VLADIMIR_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ID = 'a2222222-2222-4222-8222-222222222222';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceConstant(source, name) {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*'([0-9]+)'`).exec(source);
  assert.ok(match, `${name} must be a numeric source constant`);
  return match[1];
}

{
  const browserSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'admin/src/lib/meta-whatsapp-embedded-signup.ts'),
    'utf8',
  );
  const serverSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'admin/functions/api/whatsapp/embedded-signup/provision.js'),
    'utf8',
  );
  assert.equal(sourceConstant(browserSource, 'META_WHATSAPP_APP_ID'), sourceConstant(serverSource, 'APP_ID'));
  assert.equal(sourceConstant(browserSource, 'META_WHATSAPP_CONFIG_ID'), '4468652066715473');
}

function request(body, overrides = {}) {
  return new Request(overrides.url ?? ENDPOINT, {
    method: 'POST',
    headers: {
      origin: overrides.origin ?? 'https://crm.vishartattoo.com',
      authorization: 'Bearer crm-owner-session-token-for-test',
      'content-type': 'application/json',
      ...(overrides.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

function env(overrides = {}) {
  return {
    META_APP_SECRET: 'meta-app-secret-for-unit-test-only',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_value',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    CLOUDFLARE_WORKERS_EDIT_TOKEN: 'cloudflare-workers-edit-token-for-test',
    ...overrides,
  };
}

function bodyFor(artistId) {
  return {
    artist_id: artistId,
    code: 'one-time-meta-code-for-test',
    session: {
      waba_id: artistId === KRISTINA_ID ? '12345678902' : '12345678901',
      phone_number_id: artistId === KRISTINA_ID ? '10987654322' : '10987654321',
    },
  };
}

function authorizedFetch(calls, {
  artistId = KRISTINA_ID,
  actorId = OWNER_ID,
  actorRole = 'owner',
  membershipArtistId = artistId,
  canManageIntegrations = true,
  membershipActive = true,
  routeEnabled = true,
  phoneRows = [{
    id: '10987654322',
    display_phone_number: '+44 7000 000002',
    verified_name: 'Kristina',
  }],
} = {}) {
  const approved = __testing.approvedArtists[artistId];
  return async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, init });

    if (target.includes('/auth/v1/user')) return Response.json({ id: actorId });
    if (target.includes('/rest/v1/profiles')) {
      return Response.json([{ id: actorId, role: actorRole, is_active: true }]);
    }
    if (target.includes('/rest/v1/artist_memberships')) {
      const membershipUrl = new URL(target);
      assert.equal(membershipUrl.searchParams.get('profile_id'), `eq.${actorId}`);
      assert.equal(membershipUrl.searchParams.get('artist_id'), `eq.${artistId}`);
      return Response.json(membershipArtistId ? [{
        profile_id: actorId,
        artist_id: membershipArtistId,
        access_level: actorRole === 'owner' ? 'owner' : 'manager',
        can_manage_integrations: canManageIntegrations,
        is_active: membershipActive,
      }] : []);
    }
    if (target.includes('/rest/v1/artist_integrations')) {
      return Response.json([{
        artist_id: artistId,
        provider: 'meta_cloud_api',
        integration_key: approved.integrationKey,
        is_enabled: routeEnabled,
        configuration: {},
      }]);
    }
    if (target.includes('/oauth/access_token')) {
      assert.ok(target.includes('client_id=1481226093843982'));
      assert.ok(target.includes('client_secret='));
      assert.ok(target.includes('code='));
      return Response.json({ access_token: 'meta-access-token-for-test' });
    }
    if (target.includes(`/${bodyFor(artistId).session.waba_id}?fields=id%2Cname`)) {
      return Response.json({ id: bodyFor(artistId).session.waba_id, name: 'Kristina WABA' });
    }
    if (target.includes(`/${bodyFor(artistId).session.waba_id}/phone_numbers`)) {
      return Response.json({ data: phoneRows });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-drain-production/secrets')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'PUT');
      assert.equal(payload.name, approved.bindingName);
      assert.equal(payload.type, 'secret_text');
      assert.deepEqual(JSON.parse(payload.text), {
        phoneNumberId: bodyFor(artistId).session.phone_number_id,
        accessToken: 'meta-access-token-for-test',
        wabaId: bodyFor(artistId).session.waba_id,
        appSecret: 'meta-app-secret-for-unit-test-only',
      });
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-webhook-production/secrets')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'PUT');
      assert.equal(payload.name, approved.bindingName);
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.endsWith(`/${bodyFor(artistId).session.waba_id}/subscribed_apps`)) {
      assert.equal(init.method, 'POST');
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected network call: ${target}`);
  };
}

assert.deepEqual(__testing.approvedArtists, {
  [VLADIMIR_ID]: {
    integrationKey: 'vladimir-production',
    bindingName: 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION',
  },
  [KRISTINA_ID]: {
    integrationKey: 'kristina-production',
    bindingName: 'ARTIST_WHATSAPP_KRISTINA_HPRODUCTION',
  },
});

{
  const response = await onRequestPost({
    request: request(bodyFor(KRISTINA_ID), { origin: 'https://evil.example' }),
    env: env(),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'origin_not_allowed' });
}

{
  const response = await onRequestPost({
    request: request(bodyFor(KRISTINA_ID)),
    env: env({ META_APP_SECRET: '' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'server_not_configured' });
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: OWNER_ID });
    if (String(url).includes('/rest/v1/profiles')) {
      return Response.json([{ id: OWNER_ID, role: 'read_only', is_active: true }]);
    }
    throw new Error(`Unexpected network call: ${url}`);
  };
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: 'crm_operator_required' });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, {
    actorId: KRISTINA_MANAGER_ID,
    actorRole: 'booking_manager',
    canManageIntegrations: false,
  });
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'crm_artist_integration_not_permitted',
    });
    assert.equal(calls.some((call) => call.target.includes('/oauth/access_token')), false);
    assert.equal(calls.some((call) => call.target.includes('/workers/scripts/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, {
    actorId: KRISTINA_MANAGER_ID,
    actorRole: 'booking_manager',
    membershipArtistId: VLADIMIR_ID,
  });
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'crm_artist_integration_not_permitted',
    });
    assert.equal(calls.some((call) => call.target.includes('/oauth/access_token')), false);
    assert.equal(calls.some((call) => call.target.includes('/workers/scripts/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, { routeEnabled: false });
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'crm_route_not_ready' });
    assert.equal(calls.some((call) => call.target.includes('/oauth/access_token')), false);
    assert.equal(calls.some((call) => call.target.includes('/workers/scripts/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, {
    actorId: KRISTINA_MANAGER_ID,
    actorRole: 'booking_manager',
  });
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      integration_key: 'kristina-production',
      waba_name: 'Kristina WABA',
      display_phone_number: '+44 7000 000002',
      verified_name: 'Kristina',
    });

    const membershipIndex = calls.findIndex((call) => call.target.includes('/rest/v1/artist_memberships'));
    const routeIndex = calls.findIndex((call) => call.target.includes('/rest/v1/artist_integrations'));
    const exchangeIndex = calls.findIndex((call) => call.target.includes('/oauth/access_token'));
    const drainIndex = calls.findIndex((call) => call.target.includes('vishar-whatsapp-drain-production/secrets'));
    const webhookIndex = calls.findIndex((call) => call.target.includes('vishar-whatsapp-webhook-production/secrets'));
    const subscribeIndex = calls.findIndex((call) => call.target.endsWith('/subscribed_apps'));
    assert.ok(membershipIndex > -1);
    assert.ok(routeIndex > membershipIndex);
    assert.ok(exchangeIndex > routeIndex);
    assert.ok(drainIndex > exchangeIndex);
    assert.ok(webhookIndex > drainIndex);
    assert.ok(subscribeIndex > webhookIndex);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, {
    phoneRows: [
      { id: '10987654322', display_phone_number: '+44 7000 000002', verified_name: 'Kristina' },
      { id: '10987654323', display_phone_number: '+44 7000 000003', verified_name: 'Other' },
    ],
  });
  const coexistence = bodyFor(KRISTINA_ID);
  coexistence.session.phone_number_id = null;
  try {
    const response = await onRequestPost({ request: request(coexistence), env: env() });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'meta_phone_selection_ambiguous' });
    assert.equal(calls.some((call) => call.target.includes('/workers/scripts/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('WhatsApp production onboarding boundary tests passed.');
