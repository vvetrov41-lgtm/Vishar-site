#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MAX_WEBHOOK_BYTES,
  WhatsappWebhookError,
  constantTimeEqual,
  handleWhatsappWebhook,
  integrationKeyFromWhatsappBinding,
  readWebhookRoutes,
} from '../workers/lib/whatsapp-webhook.js';

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const V_ID = 'a1111111-1111-4111-8111-111111111111';
const K_ID = 'a2222222-2222-4222-8222-222222222222';
const F_ID = 'a3333333-3333-4333-8333-333333333333';
const V_PHONE = '100000000001';
const K_PHONE = '100000000002';
const V_WABA = '200000000001';
const K_WABA = '200000000002';
const V_SECRET = 'synthetic-vladimir-app-secret';
const K_SECRET = 'synthetic-kristina-app-secret';
const F_SECRET = 'synthetic-future-artist-app-secret';
const VERIFY = 'synthetic-webhook-verify-token';
const TS = '1786777200';

function env(overrides = {}) {
  return {
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
    WHATSAPP_VLADIMIR_ARTIST_ID: V_ID,
    WHATSAPP_KRISTINA_ARTIST_ID: K_ID,
    ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION: JSON.stringify({
      phoneNumberId: V_PHONE,
      wabaId: V_WABA,
      appSecret: V_SECRET,
      accessToken: 'synthetic-vladimir-access-token',
    }),
    ARTIST_WHATSAPP_KRISTINA_HPRODUCTION: JSON.stringify({
      phoneNumberId: K_PHONE,
      wabaId: K_WABA,
      appSecret: K_SECRET,
      accessToken: 'synthetic-kristina-access-token',
    }),
    ...overrides,
  };
}

function payloadFor({
  wabaId = V_WABA,
  phoneNumberId = V_PHONE,
  messages = [],
  statuses = [],
  field = 'messages',
} = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{
        field,
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: '+440000000000' },
          messages,
          statuses,
        },
      }],
    }],
  };
}

function inboundText({ from = '447700900001', id = 'wamid.SYNTHETICINBOUND0001', body = 'Hello' } = {}) {
  return { from, id, timestamp: TS, type: 'text', text: { body } };
}

function statusEvent({ id = 'wamid.SYNTHETICOUTBOUND0001', status = 'delivered' } = {}) {
  return { id, status, timestamp: TS, recipient_id: '447700900001' };
}

function signature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function postRequest(payload, secret = V_SECRET, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Request('https://whatsapp.example.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature(secret, body),
      ...headers,
    },
    body,
  });
}

function fakeSupabase() {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { changed: true };
    },
  };
}

await test('verification challenge returns the exact challenge for the configured token', async () => {
  const request = new Request(
    `https://whatsapp.example.test/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=123456`,
    { method: 'GET' }
  );
  const response = await handleWhatsappWebhook(request, env());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '123456');
});

await test('verification refuses the wrong token', async () => {
  const request = new Request(
    'https://whatsapp.example.test/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123456',
    { method: 'GET' }
  );
  const response = await handleWhatsappWebhook(request, env());
  assert.equal(response.status, 403);
});

await test('verification token comparison is exact', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcx'), false);
});

await test('encrypted binding names round-trip to integration keys without an artist allowlist', () => {
  assert.equal(
    integrationKeyFromWhatsappBinding('ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION'),
    'future-artist-production'
  );
  assert.equal(integrationKeyFromWhatsappBinding('ARTIST_WHATSAPP_bad'), null);
  assert.equal(integrationKeyFromWhatsappBinding('ARTIST_WHATSAPP_BAD_XESCAPE'), null);
});

await test('unknown paths are closed', async () => {
  const response = await handleWhatsappWebhook(
    new Request('https://whatsapp.example.test/anything', { method: 'GET' }),
    env()
  );
  assert.equal(response.status, 404);
});

await test('unsupported methods are closed', async () => {
  const response = await handleWhatsappWebhook(
    new Request('https://whatsapp.example.test/webhook', { method: 'PUT' }),
    env()
  );
  assert.equal(response.status, 405);
});

await test('POST requires application/json', async () => {
  const response = await handleWhatsappWebhook(
    new Request('https://whatsapp.example.test/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
      body: '{}',
    }),
    env(),
    fakeSupabase()
  );
  assert.equal(response.status, 415);
});

await test('POST requires a valid Meta signature', async () => {
  const body = JSON.stringify(payloadFor({ messages: [inboundText()] }));
  const response = await handleWhatsappWebhook(
    new Request('https://whatsapp.example.test/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body,
    }),
    env(),
    fakeSupabase()
  );
  assert.equal(response.status, 401);
});

await test('signature covers the exact raw request bytes', async () => {
  const original = JSON.stringify(payloadFor({ messages: [inboundText()] }));
  const altered = original.replace('Hello', 'Hella');
  const request = new Request('https://whatsapp.example.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature(V_SECRET, original),
    },
    body: altered,
  });
  const response = await handleWhatsappWebhook(request, env(), fakeSupabase());
  assert.equal(response.status, 401);
});

await test('declared oversized payloads are rejected before ingestion', async () => {
  const body = '{}';
  const request = new Request('https://whatsapp.example.test/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(MAX_WEBHOOK_BYTES + 1),
      'X-Hub-Signature-256': signature(V_SECRET, body),
    },
    body,
  });
  const response = await handleWhatsappWebhook(request, env(), fakeSupabase());
  assert.equal(response.status, 413);
});

await test('malformed signed JSON is rejected without an RPC call', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(postRequest('{not-json', V_SECRET), env(), db);
  assert.equal(response.status, 400);
  assert.equal(db.calls.length, 0);
});

await test('a signed Vladimir inbound message is routed only to Vladimir', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ messages: [inboundText()] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'record_whatsapp_inbound_message');
  assert.equal(db.calls[0].args.p_artist_id, V_ID);
  assert.equal(db.calls[0].args.p_integration_key, 'vladimir-production');
  assert.equal(db.calls[0].args.p_contact_wa_id, '447700900001');
  assert.equal(db.calls[0].args.p_body, 'Hello');
  assert.equal(db.calls[0].args.p_message_type, 'text');
});

await test('a signed Kristina inbound message is routed only to Kristina', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({
      wabaId: K_WABA,
      phoneNumberId: K_PHONE,
      messages: [inboundText({ from: '447700900002', id: 'wamid.SYNTHETICINBOUND0002' })],
    }), K_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].args.p_artist_id, K_ID);
  assert.equal(db.calls[0].args.p_integration_key, 'kristina-production');
});

await test('a new self-describing artist binding routes inbound messages without source changes', async () => {
  const futureEnv = env({
    ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION: undefined,
    ARTIST_WHATSAPP_KRISTINA_HPRODUCTION: undefined,
    ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION: JSON.stringify({
      artistId: F_ID,
      integrationKey: 'future-artist-production',
      phoneNumberId: '100000000003',
      wabaId: '200000000003',
      appSecret: F_SECRET,
      accessToken: 'synthetic-future-access-token',
    }),
  });
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({
      wabaId: '200000000003',
      phoneNumberId: '100000000003',
      messages: [inboundText({ id: 'wamid.SYNTHETICFUTURE0001' })],
    }), F_SECRET),
    futureEnv,
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].args.p_artist_id, F_ID);
  assert.equal(db.calls[0].args.p_integration_key, 'future-artist-production');
});

await test('a Vladimir signature cannot authorize Kristina routing', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({
      wabaId: K_WABA,
      phoneNumberId: K_PHONE,
      messages: [inboundText({ id: 'wamid.SYNTHETICINBOUND0003' })],
    }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('an unknown signed phone-number identity is ignored without persistence', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ phoneNumberId: '999999999999', messages: [inboundText()] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('an unknown signed WABA identity is ignored without persistence', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ wabaId: '999999999998', messages: [inboundText()] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('delivery status is routed to the status RPC', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ statuses: [statusEvent()] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'record_whatsapp_message_status');
  assert.equal(db.calls[0].args.p_status, 'delivered');
  assert.equal(db.calls[0].args.p_artist_id, V_ID);
});

await test('failed status is normalized without storing Meta error payloads', async () => {
  const db = fakeSupabase();
  const payload = payloadFor({ statuses: [{
    ...statusEvent({ status: 'failed' }),
    errors: [{ code: 12345, title: 'Synthetic sensitive provider body' }],
  }] });
  const response = await handleWhatsappWebhook(postRequest(payload, V_SECRET), env(), db);
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].args.p_status, 'failed');
  assert.ok(!JSON.stringify(db.calls[0].args).includes('Synthetic sensitive provider body'));
});

await test('undocumented or unsupported statuses are ignored', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ statuses: [statusEvent({ status: 'deleted' })] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('non-text messages store only their type, not provider payload content', async () => {
  const db = fakeSupabase();
  const image = {
    from: '447700900001',
    id: 'wamid.SYNTHETICIMAGE0001',
    timestamp: TS,
    type: 'image',
    image: { id: 'synthetic-media-id', caption: 'Do not copy this caption yet' },
  };
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ messages: [image] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].args.p_message_type, 'image');
  assert.equal(db.calls[0].args.p_body, null);
  assert.ok(!JSON.stringify(db.calls[0].args).includes('Do not copy this caption yet'));
});

await test('smb_message_echoes is not interpreted without an official contract', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({ field: 'smb_message_echoes', messages: [inboundText()] }), V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('one missing artist binding does not create a cross-artist fallback', async () => {
  const onlyVladimir = env({ ARTIST_WHATSAPP_KRISTINA_HPRODUCTION: undefined });
  const routes = readWebhookRoutes(onlyVladimir);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].artistId, V_ID);

  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest(payloadFor({
      wabaId: K_WABA,
      phoneNumberId: K_PHONE,
      messages: [inboundText()],
    }), V_SECRET),
    onlyVladimir,
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

await test('no artist binding fails closed', async () => {
  const noRoutes = env({
    ARTIST_WHATSAPP_VLADIMIR_HPRODUCTION: undefined,
    ARTIST_WHATSAPP_KRISTINA_HPRODUCTION: undefined,
  });
  assert.throws(
    () => readWebhookRoutes(noRoutes),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_not_configured'
  );
});

await test('duplicate provider phone identity in two bindings fails configuration closed', async () => {
  const collision = env({
    ARTIST_WHATSAPP_KRISTINA_HPRODUCTION: JSON.stringify({
      phoneNumberId: V_PHONE,
      wabaId: K_WABA,
      appSecret: K_SECRET,
    }),
  });
  assert.throws(
    () => readWebhookRoutes(collision),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_route_collision'
  );
});

await test('duplicate artist identity in two self-describing bindings fails configuration closed', () => {
  const collision = env({
    ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION: JSON.stringify({
      artistId: V_ID,
      integrationKey: 'future-artist-production',
      phoneNumberId: '100000000003',
      wabaId: '200000000003',
      appSecret: F_SECRET,
    }),
  });
  assert.throws(
    () => readWebhookRoutes(collision),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_route_collision'
  );
});

await test('a binding whose embedded route key disagrees with its secret name fails closed', () => {
  const mismatch = env({
    ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION: JSON.stringify({
      artistId: F_ID,
      integrationKey: 'other-artist-production',
      phoneNumberId: '100000000003',
      wabaId: '200000000003',
      appSecret: F_SECRET,
    }),
  });
  assert.throws(
    () => readWebhookRoutes(mismatch),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_route_invalid'
  );
});

await test('a partially self-describing envelope cannot fall back to legacy identity', () => {
  const partial = env({
    ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION: JSON.stringify({
      artistId: F_ID,
      phoneNumberId: '100000000003',
      wabaId: '200000000003',
      appSecret: F_SECRET,
    }),
  });
  assert.throws(
    () => readWebhookRoutes(partial),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_route_invalid'
  );
});

await test('malformed Phone Number ID or WABA credentials fail the whole route set closed', () => {
  const invalid = env({
    ARTIST_WHATSAPP_FUTURE_HARTIST_HPRODUCTION: JSON.stringify({
      artistId: F_ID,
      integrationKey: 'future-artist-production',
      phoneNumberId: 'not-a-provider-id',
      wabaId: '200000000003',
      appSecret: F_SECRET,
    }),
  });
  assert.throws(
    () => readWebhookRoutes(invalid),
    (error) => error instanceof WhatsappWebhookError && error.code === 'whatsapp_webhook_binding_invalid'
  );
});

await test('signed non-WhatsApp objects are acknowledged without persistence', async () => {
  const db = fakeSupabase();
  const response = await handleWhatsappWebhook(
    postRequest({ object: 'page', entry: [] }, V_SECRET),
    env(),
    db
  );
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 0);
});

if (failures > 0) {
  console.error(`WhatsApp webhook tests failed: ${failures} of ${passes + failures}`);
  process.exit(1);
}

console.log(`WhatsApp webhook tests passed: ${passes} cases covering verification, raw-body signatures, artist routing, status ingestion and fail-closed boundaries.`);
