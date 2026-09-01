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
const FUTURE_ID = 'a3333333-3333-4333-8333-333333333333';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function routeFor(artistId) {
  const slug = artistId === VLADIMIR_ID
    ? 'vladimir'
    : artistId === KRISTINA_ID
      ? 'kristina'
      : 'future-artist';
  const integrationKey = `${slug}-production`;
  return {
    artistId,
    slug,
    integrationKey,
    bindingName: __testing.whatsappBindingName(integrationKey),
  };
}

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
  const suffix = artistId === KRISTINA_ID ? '2' : artistId === FUTURE_ID ? '3' : '1';
  return {
    artist_id: artistId,
    code: 'one-time-meta-code-for-test',
    session: {
      waba_id: `1234567890${suffix}`,
      phone_number_id: `1098765432${suffix}`,
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
  routeIntegrationKey = null,
  missingSecretWorker = null,
  phoneRows = [{
    id: '10987654322',
    display_phone_number: '+44 7000 000002',
    verified_name: 'Kristina',
  }],
} = {}) {
  const route = routeFor(artistId);
  return async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
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
    if (target.includes('/rest/v1/artists')) {
      return Response.json([{
        id: artistId,
        slug: route.slug,
        is_active: true,
      }]);
    }
    if (target.includes('/rest/v1/artist_integrations')) {
      return Response.json([{
        artist_id: artistId,
        provider: 'meta_cloud_api',
        integration_key: routeIntegrationKey ?? route.integrationKey,
        is_enabled: routeEnabled,
        configuration: {},
      }]);
    }
    if (target.includes('/oauth/access_token')) {
      const exchangeUrl = new URL(target);
      assert.equal(exchangeUrl.search, '', 'Meta OAuth credentials must not be placed in the request URL');
      assert.equal(init.method, 'POST');
      assert.match(String(init.headers?.['content-type'] || ''), /^application\/x-www-form-urlencoded/i);
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('client_id'), '1481226093843982');
      assert.equal(form.get('client_secret'), 'meta-app-secret-for-unit-test-only');
      assert.equal(form.get('code'), 'one-time-meta-code-for-test');
      return Response.json({ access_token: 'meta-access-token-for-test' });
    }
    if (target.includes(`/${bodyFor(artistId).session.waba_id}?fields=id%2Cname`)) {
      return Response.json({ id: bodyFor(artistId).session.waba_id, name: 'Kristina WABA' });
    }
    if (target.includes(`/${bodyFor(artistId).session.waba_id}/phone_numbers`)) {
      return Response.json({ data: phoneRows });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-drain-production/secrets') && method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'PUT');
      assert.equal(payload.name, route.bindingName);
      assert.equal(payload.type, 'secret_text');
      assert.deepEqual(JSON.parse(payload.text), {
        artistId,
        integrationKey: route.integrationKey,
        phoneNumberId: bodyFor(artistId).session.phone_number_id,
        accessToken: 'meta-access-token-for-test',
        wabaId: bodyFor(artistId).session.waba_id,
        appSecret: 'meta-app-secret-for-unit-test-only',
      });
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-webhook-production/secrets') && method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'PUT');
      assert.equal(payload.name, route.bindingName);
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.includes('/workers/scripts/') && target.endsWith('/secrets') && method === 'GET') {
      const worker = target.includes('/vishar-whatsapp-drain-production/') ? 'drain' : 'webhook';
      return Response.json({
        success: true,
        result: worker === missingSecretWorker
          ? []
          : [{ name: route.bindingName, type: 'secret_text' }],
      });
    }
    if (target.endsWith(`/${bodyFor(artistId).session.waba_id}/subscribed_apps`) && method === 'POST') {
      assert.equal(init.method, 'POST');
      return Response.json({ success: true });
    }
    if (target.includes(`/${bodyFor(artistId).session.waba_id}/subscribed_apps`) && method === 'GET') {
      return Response.json({ data: [{ id: '1481226093843982', name: 'Vishar CRM' }] });
    }
    if (target.includes('/rest/v1/rpc/complete_artist_whatsapp_connection') && method === 'POST') {
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload, {
        p_artist_id: artistId,
        p_integration_key: route.integrationKey,
      });
      return Response.json({
        artist_id: artistId,
        integration_key: route.integrationKey,
        is_enabled: true,
        connected_at: '2026-09-01T10:00:00.000Z',
        configuration: {},
      });
    }
    throw new Error(`Unexpected network call: ${target}`);
  };
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, { routeIntegrationKey: 'kristina-secondary-production' });
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

assert.equal(__testing.whatsappBindingName('vladimir-production'), 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION');
assert.equal(__testing.whatsappBindingName('future-artist-production'), 'ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION');

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
  // 500, not 503: the Cloudflare edge replaces a 503 from a Pages Function with
  // its own HTML page, which would strip this JSON body before the CRM read it.
  assert.equal(response.status, 500);
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
      connected: true,
      connected_at: '2026-09-01T10:00:00.000Z',
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
    const subscriptionReadbackIndex = calls.findIndex((call) => call.target.includes('/subscribed_apps?fields='));
    const drainReadbackIndex = calls.findIndex((call) => (
      call.target.includes('vishar-whatsapp-drain-production/secrets')
      && String(call.init.method || 'GET').toUpperCase() === 'GET'
    ));
    const webhookReadbackIndex = calls.findIndex((call) => (
      call.target.includes('vishar-whatsapp-webhook-production/secrets')
      && String(call.init.method || 'GET').toUpperCase() === 'GET'
    ));
    const connectedIndex = calls.findIndex((call) => call.target.includes('/complete_artist_whatsapp_connection'));
    assert.ok(membershipIndex > -1);
    assert.ok(routeIndex > membershipIndex);
    assert.ok(exchangeIndex > routeIndex);
    assert.ok(drainIndex > exchangeIndex);
    assert.ok(webhookIndex > drainIndex);
    assert.ok(subscribeIndex > webhookIndex);
    assert.ok(subscriptionReadbackIndex > subscribeIndex);
    assert.ok(drainReadbackIndex > subscriptionReadbackIndex);
    assert.ok(webhookReadbackIndex > drainReadbackIndex);
    assert.ok(connectedIndex > webhookReadbackIndex);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, {
    artistId: FUTURE_ID,
    actorId: KRISTINA_MANAGER_ID,
    actorRole: 'booking_manager',
    phoneRows: [{
      id: '10987654323',
      display_phone_number: '+44 7000 000003',
      verified_name: 'Future Artist',
    }],
  });
  try {
    const response = await onRequestPost({ request: request(bodyFor(FUTURE_ID)), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      connected: true,
      connected_at: '2026-09-01T10:00:00.000Z',
      integration_key: 'future-artist-production',
      waba_name: 'Kristina WABA',
      display_phone_number: '+44 7000 000003',
      verified_name: 'Future Artist',
    });
    const writes = calls
      .filter((call) => call.target.includes('/workers/scripts/') && call.init.method === 'PUT')
      .map((call) => JSON.parse(String(call.init.body)));
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.name, 'ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION');
      const envelope = JSON.parse(write.text);
      assert.equal(envelope.artistId, FUTURE_ID);
      assert.equal(envelope.integrationKey, 'future-artist-production');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, { missingSecretWorker: 'webhook' });
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'cloudflare_binding_readback_failed',
    });
    assert.equal(calls.some((call) => call.target.includes('/complete_artist_whatsapp_connection')), false);
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

// The Cloudflare edge replaces a 502/503/504 returned from a Pages Function
// with its own HTML error page, so the JSON error contract never reaches the
// browser and every upstream failure reads as a bare "provisioning_failed" in
// the CRM. Production proved it: a 79-byte JSON body left the handler and the
// edge served 6857 bytes of HTML. No classified failure may answer with one of
// those statuses.
{
  assert.equal(__testing.edgeSafeStatus(502), 500, 'a 502 is replaced by the edge');
  assert.equal(__testing.edgeSafeStatus(503), 500, 'a 503 is replaced by the edge');
  assert.equal(__testing.edgeSafeStatus(504), 500, 'a 504 is replaced by the edge');
  assert.equal(__testing.edgeSafeStatus(500), 500);
  assert.equal(__testing.edgeSafeStatus(409), 409, 'client errors keep their status');
  assert.equal(__testing.edgeSafeStatus(401), 401);
  assert.equal(__testing.edgeSafeStatus(undefined), 500);
}

// Every failure path, whatever it throws, must answer in JSON with a status the
// edge passes through untouched.
{
  const originalFetch = globalThis.fetch;
  const failures = [
    ['crm auth transport', async () => { throw new TypeError('network boom'); }],
    ['meta app secret', async (url) => (String(url).includes('/oauth/access_token')
      ? Response.json({ error: { message: 'Error validating client secret.', type: 'OAuthException', code: 1 } }, { status: 400 })
      : null)],
    ['meta upstream', async (url) => (String(url).includes('/oauth/access_token')
      ? Response.json({ error: { message: 'nope', type: 'OAuthException', code: 100, error_subcode: 36007 } }, { status: 400 })
      : null)],
    ['binding write', async (url) => (String(url).includes('/workers/scripts/')
      ? Response.json({ success: false }, { status: 500 })
      : null)],
  ];
  for (const [name, override] of failures) {
    const calls = [];
    const base = authorizedFetch(calls, { artistId: KRISTINA_ID });
    globalThis.fetch = async (url, init = {}) => (await override(url, init)) ?? base(url, init);
    try {
      const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
      assert.ok(
        response.status < 500 || response.status === 500,
        `${name}: status ${response.status} must not be one the edge replaces`,
      );
      assert.ok(![502, 503, 504].includes(response.status), `${name}: returned an edge-replaced status`);
      assert.match(response.headers.get('content-type') || '', /application\/json/, `${name}: not JSON`);
      const payload = await response.json();
      assert.equal(typeof payload.error, 'string', `${name}: missing string error`);
      assert.equal(payload.ok, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

// Graph reports a rejected client secret as OAuthException code 1 on the token
// exchange; that is a binding problem no number of fresh authorization codes can
// fix, so it gets its own name rather than a generic Meta failure.
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  const base = authorizedFetch(calls, { artistId: KRISTINA_ID });
  globalThis.fetch = async (url, init = {}) => (String(url).includes('/oauth/access_token')
    ? Response.json({ error: { message: 'Error validating client secret.', type: 'OAuthException', code: 1 } }, { status: 400 })
    : base(url, init));
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.deepEqual(await response.json(), { ok: false, error: 'meta_app_secret_invalid' });
    assert.equal(calls.some((call) => call.target.includes('/workers/scripts/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// A spent or malformed authorization code is code 100 and stays a Meta error,
// carrying the subcode so the operator can tell the two apart.
{
  const originalFetch = globalThis.fetch;
  const base = authorizedFetch([], { artistId: KRISTINA_ID });
  globalThis.fetch = async (url, init = {}) => (String(url).includes('/oauth/access_token')
    ? Response.json({ error: { type: 'OAuthException', code: 100, error_subcode: 36007 } }, { status: 400 })
    : base(url, init));
  try {
    const response = await onRequestPost({ request: request(bodyFor(KRISTINA_ID)), env: env() });
    assert.deepEqual(await response.json(), {
      ok: false, error: 'meta_request_failed', graph_code: 100, graph_subcode: 36007, upstream_status: 400,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Secrets are pasted by hand into the Pages dashboard. A trailing newline is
// invisible there and makes Meta reject the app secret outright, so every
// binding is trimmed before it is sent anywhere.
{
  assert.equal(__testing.binding({ A: '  value\n' }, 'A'), 'value');
  assert.equal(__testing.binding({ A: 42 }, 'A'), '');
  assert.equal(__testing.binding({}, 'A'), '');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authorizedFetch(calls, { artistId: KRISTINA_ID });
  try {
    const response = await onRequestPost({
      request: request(bodyFor(KRISTINA_ID)),
      env: env({ META_APP_SECRET: '  meta-app-secret-for-unit-test-only\n' }),
    });
    assert.equal(response.status, 200);
    const exchange = calls.find((call) => call.target.includes('/oauth/access_token'));
    assert.equal(new URL(exchange.target).search, '', 'Meta app secret must not appear in the OAuth URL');
    assert.equal(exchange.init.method, 'POST');
    const form = new URLSearchParams(String(exchange.init.body));
    assert.equal(form.get('client_secret'), 'meta-app-secret-for-unit-test-only');
    assert.equal(String(exchange.init.body).includes('\n'), false, 'OAuth form carried raw whitespace');
    const write = calls.find((call) => call.target.includes('/workers/scripts/'));
    assert.equal(JSON.parse(String(write.init.body)).text.includes('\n'), false, 'envelope carried raw whitespace');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('WhatsApp production onboarding boundary tests passed.');
