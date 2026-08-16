import assert from 'node:assert/strict';
import { onRequestPost } from '../admin/functions/api/whatsapp/embedded-signup/provision.js';

const ENDPOINT = 'https://crm.vishartattoo.com/api/whatsapp/embedded-signup/provision';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';

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

const validBody = {
  artist_id: ARTIST_ID,
  integration_key: 'vladimir-production',
  code: 'one-time-meta-code-for-test',
  session: {
    waba_id: '12345678901',
    phone_number_id: '10987654321',
  },
};

{
  const response = await onRequestPost({
    request: request(validBody, { origin: 'https://evil.example' }),
    env: env(),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'origin_not_allowed' });
}

{
  const response = await onRequestPost({
    request: request(validBody),
    env: env({ META_APP_SECRET: '' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'server_not_configured' });
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) {
      return Response.json({ id: OWNER_ID });
    }
    if (String(url).includes('/rest/v1/profiles')) {
      return Response.json([{ id: OWNER_ID, role: 'booking_manager', is_active: true }]);
    }
    throw new Error(`Unexpected network call: ${url}`);
  };
  try {
    const response = await onRequestPost({ request: request(validBody), env: env() });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: 'crm_owner_required' });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, init });

    if (target.includes('/auth/v1/user')) return Response.json({ id: OWNER_ID });
    if (target.includes('/rest/v1/profiles')) {
      return Response.json([{ id: OWNER_ID, role: 'owner', is_active: true }]);
    }
    if (target.includes('/oauth/access_token')) {
      assert.ok(target.includes('client_id=1481226093843982'));
      assert.ok(target.includes('client_secret='));
      assert.ok(target.includes('code='));
      return Response.json({ access_token: 'meta-access-token-for-test' });
    }
    if (target.endsWith('/v25.0/12345678901?fields=id%2Cname')) {
      return Response.json({ id: '12345678901', name: 'Vladimir WABA' });
    }
    if (target.includes('/v25.0/12345678901/phone_numbers')) {
      return Response.json({
        data: [{
          id: '10987654321',
          display_phone_number: '+44 7000 000000',
          verified_name: 'Vladimir',
        }],
      });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-webhook-production/secrets')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'PUT');
      assert.equal(payload.name, 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION');
      assert.equal(payload.type, 'secret_text');
      const envelope = JSON.parse(payload.text);
      assert.deepEqual(envelope, {
        phoneNumberId: '10987654321',
        accessToken: 'meta-access-token-for-test',
        wabaId: '12345678901',
        appSecret: 'meta-app-secret-for-unit-test-only',
      });
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.includes('/workers/scripts/vishar-whatsapp-drain-production/secrets')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.name, 'ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION');
      return Response.json({ success: true, result: { name: payload.name, type: payload.type } });
    }
    if (target.endsWith('/v25.0/12345678901/subscribed_apps')) {
      assert.equal(init.method, 'POST');
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected network call: ${target}`);
  };

  try {
    const response = await onRequestPost({ request: request(validBody), env: env() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      integration_key: 'vladimir-production',
      waba_name: 'Vladimir WABA',
      display_phone_number: '+44 7000 000000',
      verified_name: 'Vladimir',
    });

    const webhookSecretIndex = calls.findIndex((call) => call.target.includes('vishar-whatsapp-webhook-production/secrets'));
    const drainSecretIndex = calls.findIndex((call) => call.target.includes('vishar-whatsapp-drain-production/secrets'));
    const subscribeIndex = calls.findIndex((call) => call.target.endsWith('/subscribed_apps'));
    assert.ok(webhookSecretIndex > -1);
    assert.ok(drainSecretIndex > webhookSecretIndex);
    assert.ok(subscribeIndex > drainSecretIndex);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('WhatsApp production onboarding boundary tests passed.');
