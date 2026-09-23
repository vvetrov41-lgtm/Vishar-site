#!/usr/bin/env node
//
// Instagram DM ingestion regression tests.
//
// Production had two connected Instagram accounts and no Instagram message at
// all, because no connected account had ever been enabled for webhook delivery
// with `POST /me/subscribed_apps`. These tests pin the repair:
//   * the OAuth callback enables delivery for the account it just bound;
//   * the maintenance pass enables it for accounts connected earlier, renews
//     the token inside its refresh window, and records what Meta reports;
//   * webhook deliveries leave hourly outcome evidence, so "Meta never sent"
//     and "Meta sent but it was rejected" can be told apart.
//
// Everything is synthetic. Nothing contacts Meta or Supabase.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  INSTAGRAM_WEBHOOK_FIELDS,
  enableWebhookSubscription,
  loadToken,
  parseSubscribedFields,
  storeToken,
} from '../workers/lib/instagram.js';
import { handleInstagramWebhook } from '../workers/lib/instagram-webhook.js';
import worker, {
  INTERNAL_MAINTENANCE_HOST,
  INTERNAL_MAINTENANCE_PATH,
  __testing as workerTesting,
} from '../workers/instagram-production.js';

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

const V_ARTIST = 'a1111111-1111-4111-8111-111111111111';
const K_ARTIST = 'a2222222-2222-4222-8222-222222222222';
const V_ACCOUNT = '17841400000000001';
const K_ACCOUNT = '17841400000000002';
const PARTICIPANT = '9876543210001';
const APP_SECRET = 'synthetic-instagram-app-secret';
const SYNTHETIC_SECRET_KEY = ['sb', 'secret', 'synthetic_value_for_tests'].join('_');
const SYNTHETIC_PUBLISHABLE_KEY = ['sb', 'publishable', 'synthetic_value_for_tests'].join('_');
const DAY = 24 * 60 * 60 * 1000;

function kvDouble() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function limiter(success = true) {
  const calls = [];
  return { calls, async limit(args) { calls.push(args); return { success }; } };
}

function env(overrides = {}) {
  return {
    VISHAR_ENVIRONMENT: 'production',
    SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
    SUPABASE_SECRET_KEY: SYNTHETIC_SECRET_KEY,
    SUPABASE_PUBLISHABLE_KEY: SYNTHETIC_PUBLISHABLE_KEY,
    INSTAGRAM_APP_ID: '123456789012345',
    INSTAGRAM_APP_SECRET: APP_SECRET,
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43),
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'synthetic-instagram-verify-token',
    INSTAGRAM_OAUTH_ENABLED: 'true',
    INSTAGRAM_OAUTH_STATE: kvDouble(),
    INSTAGRAM_OAUTH_TOKENS: kvDouble(),
    INSTAGRAM_RATE_LIMIT: limiter(true),
    ...overrides,
  };
}

function tokenRecord(overrides = {}) {
  return {
    artist_id: V_ARTIST,
    integration_key: 'vladimir-instagram',
    instagram_user_id: V_ACCOUNT,
    access_token: 'synthetic-long-lived-token',
    expires_at: Date.now() + 50 * DAY,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Meta double that records every call and serves the subscription API. */
function metaDouble({
  postStatus = 200,
  postBody = { success: true },
  readFields = [...INSTAGRAM_WEBHOOK_FIELDS],
  account = V_ACCOUNT,
} = {}) {
  const calls = [];
  const subscribed = new Set();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const authorization = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    calls.push({ method, path: url.pathname, search: url.search, authorization });

    if (url.pathname === '/v25.0/me/subscribed_apps' && method === 'POST') {
      if (postStatus === 200) {
        for (const field of (url.searchParams.get('subscribed_fields') || '').split(',')) subscribed.add(field);
      }
      return jsonResponse(postBody, postStatus);
    }
    if (url.pathname === '/v25.0/me/subscribed_apps' && method === 'GET') {
      return jsonResponse({ data: [{ subscribed_fields: readFields }] });
    }
    if (url.pathname === '/refresh_access_token') {
      return jsonResponse({ access_token: 'synthetic-renewed-token', expires_in: 60 * 24 * 60 * 60 });
    }
    if (url.hostname === 'api.instagram.com') {
      return jsonResponse({ data: [{
        access_token: 'synthetic-short-lived',
        user_id: '10200000000000001',
        permissions: 'instagram_business_basic,instagram_business_manage_messages',
      }] });
    }
    if (url.pathname.endsWith('/access_token')) {
      return jsonResponse({ access_token: 'synthetic-long-lived', expires_in: 60 * 24 * 60 * 60 });
    }
    if (url.pathname === '/v25.0/me') {
      return jsonResponse({ user_id: account, username: 'vladimir.synthetic' });
    }
    return jsonResponse({}, 404);
  };
  return { calls, subscribed, fetchImpl };
}

function dbDouble({ targets = [], throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (throwOn === name) {
        const error = new Error('synthetic rpc failure');
        error.code = 'instagram_rpc_unavailable';
        throw error;
      }
      if (name === 'service_list_instagram_maintenance_targets') return targets;
      if (name === 'service_resolve_instagram_route') {
        if (args.p_instagram_user_id === V_ACCOUNT) {
          return [{ artist_id: V_ARTIST, integration_key: 'vladimir-instagram', instagram_user_id: V_ACCOUNT }];
        }
        throw new Error('route unavailable');
      }
      return { ok: true };
    },
    recorded(name) { return calls.filter((call) => call.name === name).map((call) => call.args); },
  };
}

// ---------------------------------------------------------------------------
// Meta subscription API
// ---------------------------------------------------------------------------

await test('delivery is enabled for exactly the fields the webhook interprets', async () => {
  const meta = metaDouble();
  const result = await enableWebhookSubscription('synthetic-token', meta.fetchImpl);
  const post = meta.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/v25.0/me/subscribed_apps');
  assert.equal(new URLSearchParams(post.search).get('subscribed_fields'), 'messages,message_reactions,messaging_seen');
  assert.equal(post.authorization, 'Bearer synthetic-token');
  // The token travels in the header, never the URL.
  assert.ok(!post.search.includes('synthetic-token'));
  assert.deepEqual(result.fields, ['message_reactions', 'messages', 'messaging_seen']);
  assert.deepEqual(result.missing, []);
  assert.ok(meta.calls.some((call) => call.method === 'GET' && call.path === '/v25.0/me/subscribed_apps'),
    'what Meta recorded is read back, not assumed');
});

await test('a readback missing a field is reported, not treated as success', async () => {
  const meta = metaDouble({ readFields: ['messages'] });
  const result = await enableWebhookSubscription('synthetic-token', meta.fetchImpl);
  assert.deepEqual(result.missing, ['message_reactions', 'messaging_seen']);
});

await test('Meta error codes map to actionable connector errors', async () => {
  const expired = metaDouble({ postStatus: 400, postBody: { error: { code: 190 } } });
  await assert.rejects(enableWebhookSubscription('t', expired.fetchImpl), { code: 'instagram_credentials_rejected' });
  const permission = metaDouble({ postStatus: 400, postBody: { error: { code: 10 } } });
  await assert.rejects(enableWebhookSubscription('t', permission.fetchImpl), { code: 'instagram_subscription_permission_denied' });
  const refused = metaDouble({ postStatus: 200, postBody: { success: false } });
  await assert.rejects(enableWebhookSubscription('t', refused.fetchImpl), { code: 'instagram_subscription_failed' });
});

await test('subscribed field readback accepts both documented shapes and drops junk', () => {
  assert.deepEqual(parseSubscribedFields({ data: [{ subscribed_fields: ['messages', { name: 'messaging_seen' }, 'Bad Field', 7] }] }),
    ['messages', 'messaging_seen']);
  assert.deepEqual(parseSubscribedFields({}), []);
});

// ---------------------------------------------------------------------------
// OAuth callback enables delivery for the account it binds
// ---------------------------------------------------------------------------

async function seedState(environment) {
  const state = 'S'.repeat(43);
  await environment.INSTAGRAM_OAUTH_STATE.put(`instagram:state:${state}`, JSON.stringify({
    v: 1, artist_id: V_ARTIST, artist_slug: 'vladimir', integration_key: 'vladimir-instagram', created_at: Date.now(),
  }));
  return state;
}

async function runCallback(environment, db, meta) {
  const state = await seedState(environment);
  const request = new Request(`https://instagram.vishartattoo.com/oauth/instagram/callback?code=c&state=${state}`);
  return workerTesting.oauthCallback(request, new URL(request.url), environment, db, meta.fetchImpl);
}

await test('connecting an account enables its webhook delivery and records the readback', async () => {
  const environment = env();
  const db = dbDouble();
  const meta = metaDouble();
  const response = await runCallback(environment, db, meta);
  assert.equal(response.status, 200);

  const names = db.calls.map((call) => call.name);
  assert.ok(names.indexOf('service_set_instagram_integration') < names.indexOf('service_record_instagram_webhook_subscription'),
    'the route is bound before delivery is enabled for it');
  assert.ok(meta.subscribed.has('messages'));
  const [record] = db.recorded('service_record_instagram_webhook_subscription');
  assert.equal(record.p_artist_id, V_ARTIST);
  assert.equal(record.p_integration_key, 'vladimir-instagram');
  assert.deepEqual(record.p_subscribed_fields, ['message_reactions', 'messages', 'messaging_seen']);
  assert.equal(record.p_error_code, null);
  assert.ok(!JSON.stringify(record).includes('synthetic-long-lived'), 'no token reaches the database');
});

await test('a subscription failure keeps the connection and records why delivery is pending', async () => {
  const environment = env();
  const db = dbDouble();
  const meta = metaDouble({ postStatus: 400, postBody: { error: { code: 10 } } });
  const response = await runCallback(environment, db, meta);
  assert.equal(response.status, 200);
  assert.equal((await loadToken(environment, V_ARTIST)).instagram_user_id, V_ACCOUNT);
  const [record] = db.recorded('service_record_instagram_webhook_subscription');
  assert.deepEqual(record.p_subscribed_fields, []);
  assert.equal(record.p_error_code, 'instagram_subscription_permission_denied');
});

// ---------------------------------------------------------------------------
// Maintenance pass for accounts connected before the fix
// ---------------------------------------------------------------------------

function target(overrides = {}) {
  return {
    artist_id: V_ARTIST,
    integration_key: 'vladimir-instagram',
    instagram_user_id: V_ACCOUNT,
    webhook_subscription_checked_at: null,
    webhook_subscription_error: null,
    ...overrides,
  };
}

async function maintain(environment, db, meta, now = Date.now()) {
  // runInstagramMaintenance builds its own Supabase client; its RPC calls are
  // routed to the database double, everything else to the Meta double.
  const fetchImpl = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'vfjexhfdbrjmuxfdvbdx.supabase.co') {
      const name = url.pathname.split('/').pop();
      const args = init?.body ? JSON.parse(init.body) : {};
      try {
        return jsonResponse(await db.rpc(name, args));
      } catch {
        return jsonResponse({ code: 'P0001', message: 'synthetic' }, 400);
      }
    }
    return meta.fetchImpl(input, init);
  };
  return workerTesting.runInstagramMaintenance(environment, fetchImpl, now);
}

await test('accounts connected before the fix are enabled by the maintenance pass', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  await storeToken(environment, tokenRecord({
    artist_id: K_ARTIST, integration_key: 'kristina-instagram', instagram_user_id: K_ACCOUNT,
  }));
  const db = dbDouble({ targets: [
    target(),
    target({ artist_id: K_ARTIST, integration_key: 'kristina-instagram', instagram_user_id: K_ACCOUNT }),
  ] });
  const meta = metaDouble();
  const summary = await maintain(environment, db, meta);
  assert.deepEqual(summary, { ok: true, targets: 2, checked: 2, subscribed: 2, failed: 0 });
  const records = db.recorded('service_record_instagram_webhook_subscription');
  assert.deepEqual(records.map((r) => r.p_integration_key).sort(), ['kristina-instagram', 'vladimir-instagram']);
  assert.ok(records.every((r) => r.p_error_code === null));
  assert.equal(meta.calls.filter((call) => call.method === 'POST').length, 2);
});

await test('a confirmed account is not re-asked every tick; an errored one is', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const now = Date.now();
  const recent = new Date(now - 60 * 60 * 1000).toISOString();
  const db = dbDouble({ targets: [
    target({ webhook_subscription_checked_at: recent }),
    target({
      artist_id: K_ARTIST, integration_key: 'kristina-instagram', instagram_user_id: K_ACCOUNT,
      webhook_subscription_checked_at: recent, webhook_subscription_error: 'instagram_subscription_failed',
    }),
  ] });
  const meta = metaDouble();
  const summary = await maintain(environment, db, meta, now);
  assert.equal(summary.checked, 1, 'only the errored account is re-checked');
  assert.equal(summary.failed, 1, 'Kristina has no stored token in this fixture');
  assert.equal(db.recorded('service_record_instagram_webhook_subscription')[0].p_integration_key, 'kristina-instagram');
  assert.ok(workerTesting.subscriptionDue(target({ webhook_subscription_checked_at: new Date(now - 13 * 60 * 60 * 1000).toISOString() }), now));
  assert.equal(workerTesting.subscriptionDue(target({
    webhook_subscription_checked_at: new Date(now - 10 * 60 * 1000).toISOString(),
    webhook_subscription_error: 'instagram_subscription_permission_denied',
  }), now), false, 'a lasting refusal is not re-asked every tick');
});

await test('the maintenance pass renews a token inside its refresh window, keeping idle accounts alive', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord({ expires_at: Date.now() + 3 * DAY }));
  const db = dbDouble({ targets: [target()] });
  const meta = metaDouble();
  await maintain(environment, db, meta);
  assert.ok(meta.calls.some((call) => call.path === '/refresh_access_token'));
  const stored = await loadToken(environment, V_ARTIST);
  assert.equal(stored.access_token, 'synthetic-renewed-token');
  assert.ok(stored.expires_at > Date.now() + 50 * DAY);
});

await test('a token bound to a different account is never used to subscribe', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord({ instagram_user_id: '17841400000000999' }));
  const db = dbDouble({ targets: [target()] });
  const meta = metaDouble();
  const summary = await maintain(environment, db, meta);
  assert.equal(summary.failed, 1);
  assert.equal(meta.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(db.recorded('service_record_instagram_webhook_subscription')[0].p_error_code, 'instagram_token_account_mismatch');
});

await test('the maintenance route answers only on the internal host and only to POST', async () => {
  const environment = env();
  const internal = await worker.fetch(new Request(`https://${INTERNAL_MAINTENANCE_HOST}${INTERNAL_MAINTENANCE_PATH}`, { method: 'GET' }), environment);
  assert.equal(internal.status, 405);
  const publicHost = await worker.fetch(new Request(`https://instagram.vishartattoo.com${INTERNAL_MAINTENANCE_PATH}`, { method: 'POST' }), environment);
  assert.equal(publicHost.status, 404);
});

// ---------------------------------------------------------------------------
// Webhook delivery evidence
// ---------------------------------------------------------------------------

function signedRequest(payload, secret = APP_SECRET) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return new Request('https://instagram.vishartattoo.com/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
}

function inboundPayload(account = V_ACCOUNT) {
  return {
    object: 'instagram',
    entry: [{
      id: account,
      time: Date.now(),
      messaging: [{
        sender: { id: PARTICIPANT },
        recipient: { id: account },
        timestamp: Date.now(),
        message: { mid: 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQx', text: 'Hi, is 27 October still free?' },
      }],
    }],
  };
}

await test('an accepted delivery records its outcome counts and nothing identifying', async () => {
  const db = dbDouble();
  const response = await handleInstagramWebhook(signedRequest(inboundPayload()), env(), db);
  assert.equal(response.status, 200);
  const [evidence] = db.recorded('service_record_instagram_webhook_delivery');
  assert.deepEqual(evidence.p_counts, { accepted: 1, inbound: 1 });
  const serialised = JSON.stringify(evidence);
  for (const secret of [V_ACCOUNT, PARTICIPANT, 'October']) assert.ok(!serialised.includes(secret));
});

await test('an unrouted account is visible as evidence rather than silently dropped', async () => {
  const db = dbDouble();
  const response = await handleInstagramWebhook(signedRequest(inboundPayload('17841400000000777')), env(), db);
  assert.equal(response.status, 200);
  assert.deepEqual(db.recorded('service_record_instagram_webhook_delivery')[0].p_counts, { accepted: 1, unrouted: 1 });
  assert.equal(db.recorded('record_communication_inbound_message').length, 0);
});

await test('a signature mismatch is counted while the limiter allows it, and still refused', async () => {
  const allowed = dbDouble();
  const environment = env();
  const refused = await handleInstagramWebhook(signedRequest(inboundPayload(), 'a-different-app-secret'), environment, allowed);
  assert.equal(refused.status, 401);
  assert.deepEqual(allowed.recorded('service_record_instagram_webhook_delivery')[0].p_counts, { signature_invalid: 1 });
  assert.equal(allowed.recorded('service_resolve_instagram_route').length, 0);
  assert.equal(environment.INSTAGRAM_RATE_LIMIT.calls[0].key, 'webhook:signature_invalid');

  const flooded = dbDouble();
  await handleInstagramWebhook(signedRequest(inboundPayload(), 'a-different-app-secret'),
    env({ INSTAGRAM_RATE_LIMIT: limiter(false) }), flooded);
  assert.equal(flooded.recorded('service_record_instagram_webhook_delivery').length, 0,
    'a flood of unsigned requests never becomes database writes');
});

await test('an evidence write failure never changes what Meta receives', async () => {
  const db = dbDouble({ throwOn: 'service_record_instagram_webhook_delivery' });
  const response = await handleInstagramWebhook(signedRequest(inboundPayload()), env(), db);
  assert.equal(response.status, 200);
  assert.equal(db.recorded('record_communication_inbound_message').length, 1);
});

await test('a persistence failure is still answered 503 so Meta retries, and is counted', async () => {
  const db = dbDouble({ throwOn: 'record_communication_inbound_message' });
  const response = await handleInstagramWebhook(signedRequest(inboundPayload()), env(), db);
  assert.equal(response.status, 503);
  assert.deepEqual(db.recorded('service_record_instagram_webhook_delivery')[0].p_counts, { accepted: 1, failed: 1 });
});

// ---------------------------------------------------------------------------
// Meta's alternate business-account id (production, 2026-09-23)
// ---------------------------------------------------------------------------

const ALIAS = '1234567890123456';

await test('an inbound DM whose recipient is Meta\'s alias for the entry account is recorded', async () => {
  const db = dbDouble();
  const payload = inboundPayload();
  payload.entry[0].messaging[0].recipient.id = ALIAS;
  const response = await handleInstagramWebhook(signedRequest(payload), env(), db);
  assert.equal(response.status, 200);
  const [ingest] = db.recorded('record_communication_inbound_message');
  assert.equal(ingest.p_artist_id, V_ARTIST, 'the signed entry id decides the artist');
  assert.equal(ingest.p_external_contact_id, PARTICIPANT);
  assert.deepEqual(db.recorded('service_record_instagram_webhook_delivery')[0].p_counts,
    { accepted: 1, inbound: 1, recipient_alias: 1 });
});

await test('a recipient that is another CRM artist account is still refused', async () => {
  const db = dbDouble();
  // In this double only V_ACCOUNT routes; make the entry an alias-free
  // Kristina-shaped case by addressing Vladimir's real account from an entry
  // that is not Vladimir's.
  const payload = inboundPayload();
  payload.entry[0].id = '17841400000000002';
  const routing = {
    ...db,
    async rpc(name, args) {
      if (name === 'service_resolve_instagram_route' && args.p_instagram_user_id === '17841400000000002') {
        db.calls.push({ name, args });
        return [{ artist_id: K_ARTIST, integration_key: 'kristina-instagram', instagram_user_id: '17841400000000002' }];
      }
      return db.rpc(name, args);
    },
  };
  const response = await handleInstagramWebhook(signedRequest(payload), env(), routing);
  assert.equal(response.status, 200);
  assert.equal(db.recorded('record_communication_inbound_message').length, 0);
  assert.deepEqual(db.recorded('service_record_instagram_webhook_delivery')[0].p_counts,
    { accepted: 1, skipped: 1, skipped_cross_account: 1 });
});

await test('a message sent by the entry account itself without the echo flag is not inbound', async () => {
  const db = dbDouble();
  const payload = inboundPayload();
  payload.entry[0].messaging[0].sender.id = V_ACCOUNT;
  payload.entry[0].messaging[0].recipient.id = ALIAS;
  await handleInstagramWebhook(signedRequest(payload), env(), db);
  assert.equal(db.recorded('record_communication_inbound_message').length, 0);
});

await test('an echo sent from Meta\'s alias for the entry account is recorded against the participant', async () => {
  const db = dbDouble();
  const payload = inboundPayload();
  const event = payload.entry[0].messaging[0];
  event.sender.id = ALIAS;
  event.recipient.id = PARTICIPANT;
  event.message = { mid: 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE4', text: 'Yes, 27 October works', is_echo: true };
  await handleInstagramWebhook(signedRequest(payload), env(), db);
  const [echo] = db.recorded('record_communication_outbound_echo');
  assert.equal(echo.p_external_contact_id, PARTICIPANT);
  assert.equal(echo.p_artist_id, V_ARTIST);
});

await test('base64 message ids with + are accepted and skip reasons are named', async () => {
  const db = dbDouble();
  const payload = inboundPayload();
  payload.entry[0].messaging[0].message.mid = 'aWdfZAG1+aXRlbToxOklHTWVzc2FnZ+UlEOjE3ODQx==';
  await handleInstagramWebhook(signedRequest(payload), env(), db);
  assert.equal(db.recorded('record_communication_inbound_message').length, 1);

  const stale = dbDouble();
  const bad = inboundPayload();
  bad.entry[0].messaging[0].timestamp = Date.now() + 60 * 60 * 1000;
  await handleInstagramWebhook(signedRequest(bad), env(), stale);
  assert.deepEqual(stale.recorded('service_record_instagram_webhook_delivery')[0].p_counts,
    { accepted: 1, skipped: 1, skipped_timestamp: 1 });
});

console.log(`instagram webhook subscription: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
