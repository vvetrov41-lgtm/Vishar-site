#!/usr/bin/env node
//
// Instagram webhook boundary tests.
//
// Every identifier, secret and message here is synthetic. Nothing contacts
// Meta, and no real Instagram account, token or app secret appears.
//
// The properties under test are the ones that decide whether a webhook can
// reach the wrong artist: signature authenticity, backend-owned artist
// resolution, idempotent ingestion, and safe handling of every event type this
// release does not interpret.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MAX_WEBHOOK_BYTES,
  handleInstagramWebhook,
  normaliseMessage,
  normaliseReferral,
  parseProviderTimestamp,
  processPayload,
  verifyWebhookSignature,
} from '../workers/lib/instagram-webhook.js';

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

const APP_SECRET = 'synthetic-instagram-app-secret';
const VERIFY_TOKEN = 'synthetic-instagram-verify-token';
const V_ARTIST = 'a1111111-1111-4111-8111-111111111111';
const K_ARTIST = 'a2222222-2222-4222-8222-222222222222';
const V_ACCOUNT = '17841400000000001';
const K_ACCOUNT = '17841400000000002';
const SENDER = '9876543210001';
const NOW_MS = Date.now() - 60_000;

function env(overrides = {}) {
  return {
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    ...overrides,
  };
}

function sign(body, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * A Supabase double that mirrors the real routing contract: only the two
 * connected accounts resolve, and every other account raises the way the
 * fail-closed SQL function does.
 */
function supabaseDouble({ routes = null, failOn = null } = {}) {
  const known = routes ?? new Map([
    [V_ACCOUNT, { artist_id: V_ARTIST, integration_key: 'vladimir-instagram', instagram_user_id: V_ACCOUNT }],
    [K_ACCOUNT, { artist_id: K_ARTIST, integration_key: 'kristina-instagram', instagram_user_id: K_ACCOUNT }],
  ]);
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (failOn === name) throw new Error('synthetic_rpc_failure');
      if (name === 'service_resolve_instagram_route') {
        const route = known.get(args.p_instagram_user_id);
        if (!route) throw new Error('instagram_rpc_failed');
        return [route];
      }
      return { changed: true };
    },
  };
}

function messagePayload(overrides = {}) {
  return {
    object: 'instagram',
    entry: [{
      id: V_ACCOUNT,
      time: NOW_MS,
      messaging: [{
        sender: { id: SENDER },
        recipient: { id: V_ACCOUNT },
        timestamp: NOW_MS,
        message: { mid: 'ig_mid_SYNTHETIC000001', text: 'Hello there' },
        ...overrides,
      }],
    }],
  };
}

async function post(payload, { env: environment = env(), supabase = supabaseDouble(), signature } = {}) {
  const body = JSON.stringify(payload);
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature ?? sign(body),
    },
    body,
  });
  const response = await handleInstagramWebhook(request, environment, supabase);
  return { response, supabase };
}

// ---------------------------------------------------------------------------
// Verification challenge
// ---------------------------------------------------------------------------

await test('the verification challenge is echoed for the configured token', async () => {
  const url = `https://instagram.vishartattoo.com/webhook?hub.mode=subscribe`
    + `&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`;
  const response = await handleInstagramWebhook(new Request(url), env(), null);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '1158201444');
});

await test('a wrong verify token is refused', async () => {
  const url = 'https://instagram.vishartattoo.com/webhook?hub.mode=subscribe'
    + '&hub.verify_token=wrong&hub.challenge=1158201444';
  const response = await handleInstagramWebhook(new Request(url), env(), null);
  assert.equal(response.status, 403);
});

await test('a missing verify token configuration refuses the challenge', async () => {
  const url = `https://instagram.vishartattoo.com/webhook?hub.mode=subscribe`
    + `&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`;
  const response = await handleInstagramWebhook(
    new Request(url),
    env({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: '' }),
    null,
  );
  assert.equal(response.status, 403);
});

await test('an unexpected path is not served', async () => {
  const response = await handleInstagramWebhook(
    new Request('https://instagram.vishartattoo.com/anything'),
    env(),
    null,
  );
  assert.equal(response.status, 404);
});

await test('an unexpected method is refused with an Allow header', async () => {
  const response = await handleInstagramWebhook(
    new Request('https://instagram.vishartattoo.com/webhook', { method: 'DELETE' }),
    env(),
    null,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, POST');
});

// ---------------------------------------------------------------------------
// Signature authenticity
// ---------------------------------------------------------------------------

await test('a correctly signed payload is accepted', async () => {
  const { response, supabase } = await post(messagePayload());
  assert.equal(response.status, 200);
  assert.ok(supabase.calls.some((call) => call.name === 'record_communication_inbound_message'));
});

await test('an invalid signature is refused and nothing is ingested', async () => {
  const { response, supabase } = await post(messagePayload(), {
    signature: `sha256=${'0'.repeat(64)}`,
  });
  assert.equal(response.status, 401);
  assert.equal(supabase.calls.length, 0);
});

await test('a signature from a different app secret is refused', async () => {
  const body = JSON.stringify(messagePayload());
  const { response, supabase } = await post(messagePayload(), {
    signature: sign(body, 'a-different-app-secret'),
  });
  assert.equal(response.status, 401);
  assert.equal(supabase.calls.length, 0);
});

await test('a missing signature header is refused', async () => {
  const { response, supabase } = await post(messagePayload(), { signature: 'none' });
  assert.equal(response.status, 401);
  assert.equal(supabase.calls.length, 0);
});

await test('an unconfigured app secret fails closed rather than skipping verification', async () => {
  const { response, supabase } = await post(messagePayload(), {
    env: env({ INSTAGRAM_APP_SECRET: '' }),
  });
  assert.equal(response.status, 503);
  assert.equal(supabase.calls.length, 0);
});

await test('a non-JSON content type is refused', async () => {
  const body = JSON.stringify(messagePayload());
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  const response = await handleInstagramWebhook(request, env(), supabaseDouble());
  assert.equal(response.status, 415);
});

await test('an oversized body is refused before parsing', async () => {
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(MAX_WEBHOOK_BYTES + 1),
      'X-Hub-Signature-256': sign('{}'),
    },
    body: '{}',
  });
  const response = await handleInstagramWebhook(request, env(), supabaseDouble());
  assert.equal(response.status, 413);
});

await test('a signed but malformed body is refused', async () => {
  const body = 'not json';
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  const response = await handleInstagramWebhook(request, env(), supabaseDouble());
  assert.equal(response.status, 400);
});

await test('a POST without a database credential fails closed', async () => {
  const body = JSON.stringify(messagePayload());
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  const response = await handleInstagramWebhook(request, env(), null);
  assert.equal(response.status, 503);
});

// ---------------------------------------------------------------------------
// Artist routing
// ---------------------------------------------------------------------------

await test('an inbound message is ingested against the artist that owns the account', async () => {
  const supabase = supabaseDouble();
  await processPayload(messagePayload(), supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.equal(ingest.args.p_artist_id, V_ARTIST);
  assert.equal(ingest.args.p_integration_key, 'vladimir-instagram');
  assert.equal(ingest.args.p_external_contact_id, SENDER);
  assert.equal(ingest.args.p_channel, 'instagram');
});

await test('the second artist account routes to the second artist only', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  payload.entry[0].id = K_ACCOUNT;
  payload.entry[0].messaging[0].recipient.id = K_ACCOUNT;
  await processPayload(payload, supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.equal(ingest.args.p_artist_id, K_ARTIST);
  assert.equal(ingest.args.p_integration_key, 'kristina-instagram');
});

await test('an unknown Instagram account is ignored rather than defaulted to an artist', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  payload.entry[0].id = '17841499999999999';
  payload.entry[0].messaging[0].recipient.id = '17841499999999999';
  const counters = await processPayload(payload, supabase);
  assert.equal(counters.unrouted, 1);
  assert.equal(counters.inbound, 0);
  assert.ok(!supabase.calls.some((call) => call.name === 'record_communication_inbound_message'));
});

await test('a message addressed to a different account than the entry names is skipped', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  payload.entry[0].messaging[0].recipient.id = K_ACCOUNT;
  const counters = await processPayload(payload, supabase);
  assert.equal(counters.inbound, 0);
  assert.equal(counters.skipped, 1);
});

await test('a payload for another Meta product is ignored', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  payload.object = 'whatsapp_business_account';
  const counters = await processPayload(payload, supabase);
  assert.equal(counters.inbound, 0);
  assert.equal(supabase.calls.length, 0);
});

await test('one route lookup serves every event in a batched entry', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  payload.entry[0].messaging.push({
    sender: { id: SENDER },
    recipient: { id: V_ACCOUNT },
    timestamp: NOW_MS,
    message: { mid: 'ig_mid_SYNTHETIC000002', text: 'and another' },
  });
  await processPayload(payload, supabase);
  const lookups = supabase.calls.filter((call) => call.name === 'service_resolve_instagram_route');
  assert.equal(lookups.length, 1);
});

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

await test('an echo is recorded as a provider-app send, keyed on the participant', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    sender: { id: V_ACCOUNT },
    recipient: { id: SENDER },
    message: { mid: 'ig_mid_SYNTHETICECHO01', text: 'from the app', is_echo: true },
  });
  await processPayload(payload, supabase);
  const echo = supabase.calls.find((call) => call.name === 'record_communication_outbound_echo');
  assert.equal(echo.args.p_external_contact_id, SENDER);
  assert.equal(echo.args.p_artist_id, V_ARTIST);
});

await test('a read watermark is applied for the participant', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: undefined,
    read: { mid: 'ig_mid_SYNTHETICOUT001' },
  });
  delete payload.entry[0].messaging[0].message;
  await processPayload(payload, supabase);
  const read = supabase.calls.find((call) => call.name === 'record_communication_read_receipt');
  assert.equal(read.args.p_external_contact_id, SENDER);
  assert.equal(read.args.p_provider_message_id, 'ig_mid_SYNTHETICOUT001');
});

await test('a reaction is ignored without persistence', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  delete payload.entry[0].messaging[0].message;
  payload.entry[0].messaging[0].reaction = { mid: 'ig_mid_SYNTHETIC000001', action: 'react', reaction: 'love' };
  const counters = await processPayload(payload, supabase);
  assert.equal(counters.ignored, 1);
  assert.equal(counters.inbound, 0);
  assert.ok(!supabase.calls.some((call) => call.name.startsWith('record_')));
});

await test('a deleted message is not recorded', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: { mid: 'ig_mid_SYNTHETIC000009', is_deleted: true },
  });
  const counters = await processPayload(payload, supabase);
  assert.equal(counters.inbound, 0);
  assert.equal(counters.skipped, 1);
});

await test('an unsupported message is recorded as unsupported with no body', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: { mid: 'ig_mid_SYNTHETIC000010', is_unsupported: true },
  });
  await processPayload(payload, supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.equal(ingest.args.p_message_type, 'unsupported');
  assert.equal(ingest.args.p_body, null);
});

await test('an image message carries its shape and no expiring provider URL', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: {
      mid: 'ig_mid_SYNTHETIC000011',
      attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/expiring' } }],
    },
  });
  await processPayload(payload, supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.equal(ingest.args.p_message_type, 'image');
  assert.equal(ingest.args.p_body, null);
  assert.deepEqual(ingest.args.p_attachments, [{ type: 'image' }]);
  assert.ok(!JSON.stringify(ingest.args).includes('cdn.example.test'));
});

await test('a story reply share keeps its attachment type', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: {
      mid: 'ig_mid_SYNTHETIC000012',
      attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example.test/story' } }],
    },
  });
  await processPayload(payload, supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.equal(ingest.args.p_message_type, 'story_mention');
});

await test('provider referral attribution is preserved from the signed payload', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload({
    message: {
      mid: 'ig_mid_SYNTHETIC000013',
      text: 'saw your ad',
      referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '1234567890', ref: 'sleeve-campaign' },
    },
  });
  await processPayload(payload, supabase);
  const ingest = supabase.calls.find((call) => call.name === 'record_communication_inbound_message');
  assert.deepEqual(ingest.args.p_provider_referral, {
    source: 'ADS',
    type: 'OPEN_THREAD',
    ref: 'sleeve-campaign',
    ad_id: '1234567890',
  });
});

await test('a hostile referral value is dropped rather than stored', () => {
  assert.equal(normaliseReferral({ source: '<script>alert(1)</script>' }), null);
  assert.equal(normaliseReferral({ ad_id: 'not-a-number' }), null);
  assert.equal(normaliseReferral(null), null);
});

await test('a batched entry stops at the event ceiling', async () => {
  const supabase = supabaseDouble();
  const payload = messagePayload();
  for (let index = 0; index < 200; index += 1) {
    payload.entry[0].messaging.push({
      sender: { id: SENDER },
      recipient: { id: V_ACCOUNT },
      timestamp: NOW_MS,
      message: { mid: `ig_mid_SYNTHETICBULK${String(index).padStart(3, '0')}`, text: 'bulk' },
    });
  }
  const counters = await processPayload(payload, supabase);
  assert.ok(counters.inbound <= 100);
});

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

await test('a provider timestamp in the future is refused', () => {
  assert.equal(parseProviderTimestamp(Date.now() + 60 * 60 * 1000), null);
  assert.equal(parseProviderTimestamp(0), null);
  assert.equal(parseProviderTimestamp('1786777200'), null);
  assert.ok(parseProviderTimestamp(NOW_MS));
});

await test('a message without a usable id is not normalised', () => {
  assert.equal(normaliseMessage({ mid: 'short', text: 'hello' }), null);
  assert.equal(normaliseMessage(null), null);
});

await test('a message the adapter cannot classify is kept as unsupported, not invented', () => {
  // Whitespace-only text with no attachment is still something that arrived.
  // Recording it as `unsupported` keeps the timeline honest without inventing
  // a body the client never wrote.
  const normalised = normaliseMessage({ mid: 'ig_mid_SYNTHETIC000001', text: '   ' });
  assert.equal(normalised.messageType, 'unsupported');
  assert.equal(normalised.body, null);
});

await test('a signature is only accepted in the documented header form', async () => {
  const bytes = new TextEncoder().encode('{}');
  assert.equal(await verifyWebhookSignature(bytes, 'sha1=abc', APP_SECRET), false);
  assert.equal(await verifyWebhookSignature(bytes, null, APP_SECRET), false);
  assert.equal(await verifyWebhookSignature(bytes, `sha256=${'0'.repeat(64)}`, ''), false);
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

await test('an ingestion failure surfaces as a retryable error, not a silent success', async () => {
  const supabase = supabaseDouble({ failOn: 'record_communication_inbound_message' });
  const body = JSON.stringify(messagePayload());
  const request = new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  const response = await handleInstagramWebhook(request, env(), supabase);
  assert.equal(response.status, 503);
});

console.log(`instagram webhook: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
