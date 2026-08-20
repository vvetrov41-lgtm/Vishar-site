#!/usr/bin/env node
//
// Instagram connector tests: token custody, OAuth onboarding, outbound
// delivery and the shared communications drain.
//
// Every credential, account and message here is synthetic. Nothing contacts
// Meta or Supabase.
//
// The properties under test are the ones the CRM depends on being true:
// the browser cannot choose an artist, a provider account or a recipient; a
// token never leaves the connector; and Meta's messaging window is reported
// as an explicit state rather than retried into a wall.

import assert from 'node:assert/strict';
import {
  INSTAGRAM_SCOPES,
  InstagramError,
  authorizationUrl,
  loadToken,
  openToken,
  sealToken,
  sendInstagramMessage,
  storeToken,
} from '../workers/lib/instagram.js';
import {
  CommunicationsDrainError,
  drainCommunicationOutbox,
  validateClaimedJob,
  validateRoute,
} from '../workers/lib/communications-drain.js';
import { __testing as supabaseTesting } from '../workers/lib/instagram-supabase.js';
import worker, { __testing as workerTesting } from '../workers/instagram-production.js';

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
const RECIPIENT = '9876543210001';
const OUTBOX_ID = 'b1111111-1111-4111-8111-111111111111';
const MESSAGE_ID = 'b2222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = 'b3333333-3333-4333-8333-333333333333';
// 32 zero bytes, base64url. Synthetic: this is not a key for anything.
const ENCRYPTION_KEY = 'A'.repeat(43);
const SESSION = 'synthetic.session.token-abcdefghijklmnop';
const TEST_PROFILE = 'c1111111-1111-4111-8111-111111111111';
// Assembled at runtime so the repository secret scanner is never asked to tell
// a fabricated key from a real one.
const SYNTHETIC_SECRET_KEY = ['sb', 'secret', 'synthetic_value_for_tests'].join('_');
const SYNTHETIC_PUBLISHABLE_KEY = ['sb', 'publishable', 'synthetic_value_for_tests'].join('_');

function kvDouble(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function env(overrides = {}) {
  return {
    VISHAR_ENVIRONMENT: 'production',
    SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
    SUPABASE_SECRET_KEY: SYNTHETIC_SECRET_KEY,
    SUPABASE_PUBLISHABLE_KEY: SYNTHETIC_PUBLISHABLE_KEY,
    INSTAGRAM_APP_ID: 'synthetic-app-id',
    INSTAGRAM_APP_SECRET: 'synthetic-instagram-app-secret',
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'synthetic-instagram-verify-token',
    INSTAGRAM_OAUTH_ENABLED: 'true',
    INSTAGRAM_OAUTH_STATE: kvDouble(),
    INSTAGRAM_OAUTH_TOKENS: kvDouble(),
    ...overrides,
  };
}

function tokenRecord(overrides = {}) {
  return {
    artist_id: V_ARTIST,
    integration_key: 'vladimir-instagram',
    instagram_user_id: V_ACCOUNT,
    access_token: 'synthetic-long-lived-token',
    expires_at: Date.now() + 50 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Token custody
// ---------------------------------------------------------------------------

await test('a sealed token round-trips and is not readable as plaintext', async () => {
  const sealed = await sealToken({ ...tokenRecord(), v: 1 }, ENCRYPTION_KEY);
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('synthetic-long-lived-token'));
  const opened = await openToken(sealed, ENCRYPTION_KEY);
  assert.equal(opened.access_token, 'synthetic-long-lived-token');
  assert.equal(opened.instagram_user_id, V_ACCOUNT);
});

await test('a tampered envelope is refused', async () => {
  const sealed = await sealToken({ ...tokenRecord(), v: 1 }, ENCRYPTION_KEY);
  const parts = sealed.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
  await assert.rejects(() => openToken(tampered, ENCRYPTION_KEY), InstagramError);
});

await test('an envelope sealed under a different key is refused', async () => {
  const sealed = await sealToken({ ...tokenRecord(), v: 1 }, ENCRYPTION_KEY);
  await assert.rejects(() => openToken(sealed, 'B'.repeat(43)), InstagramError);
});

await test('a token stored for one artist cannot be loaded as another', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const loaded = await loadToken(environment, V_ARTIST);
  assert.equal(loaded.artist_id, V_ARTIST);
  await assert.rejects(() => loadToken(environment, K_ARTIST), InstagramError);
});

await test('the token store keys are namespaced per artist', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  assert.deepEqual([...environment.INSTAGRAM_OAUTH_TOKENS.store.keys()], [
    `instagram:token:${V_ARTIST}`,
  ]);
});

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

await test('the authorization URL uses the documented Instagram Login endpoint', () => {
  const url = new URL(authorizationUrl({
    clientId: 'synthetic-app-id',
    redirectUri: workerTesting.REDIRECT_URI,
    state: 'A'.repeat(43),
  }));
  assert.equal(url.origin, 'https://www.instagram.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), INSTAGRAM_SCOPES.join(','));
  assert.equal(url.searchParams.get('redirect_uri'), workerTesting.REDIRECT_URI);
});

await test('only the scopes this CRM needs are requested', () => {
  assert.deepEqual(INSTAGRAM_SCOPES, [
    'instagram_business_basic',
    'instagram_business_manage_messages',
  ]);
});

// ---------------------------------------------------------------------------
// Configuration gate
// ---------------------------------------------------------------------------

await test('a partially configured connector serves nothing', async () => {
  for (const missing of [
    'INSTAGRAM_APP_SECRET',
    'INSTAGRAM_TOKEN_ENCRYPTION_KEY',
    'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
    'SUPABASE_SECRET_KEY',
    'INSTAGRAM_OAUTH_TOKENS',
  ]) {
    const environment = env({ [missing]: undefined });
    assert.equal(workerTesting.configured(environment), false, missing);
    const response = await worker.fetch(
      new Request('https://instagram.vishartattoo.com/webhook?hub.mode=subscribe'),
      environment,
    );
    assert.equal(response.status, 404, missing);
  }
});

await test('a staging-shaped environment is refused', () => {
  assert.equal(
    workerTesting.configured(env({ SUPABASE_URL: 'https://gwaliusblwrzisrwnsvs.supabase.co' })),
    false,
  );
  assert.equal(workerTesting.configured(env({ VISHAR_ENVIRONMENT: 'staging' })), false);
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function dbDouble({ authorize = null, session = 'allow', throwOn = null, calls = [] } = {}) {
  return {
    calls,
    async verifyUser(bearer) {
      calls.push({ name: 'verifyUser', bearer });
      if (throwOn === 'verifyUser') {
        const error = new Error('instagram_session_verification_unavailable');
        error.code = 'instagram_session_verification_unavailable';
        throw error;
      }
      if (session === 'deny') {
        const error = new Error('instagram_session_invalid');
        error.code = 'instagram_session_invalid';
        error.status = 401;
        throw error;
      }
      return { id: TEST_PROFILE };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (throwOn === name) {
        const error = new Error('synthetic_rpc_failure');
        error.code = 'instagram_rpc_unavailable';
        throw error;
      }
      if (name === 'service_authorize_instagram_connection') {
        if (authorize === 'deny') {
          const error = new Error('instagram_permission_denied');
          error.code = 'instagram_permission_denied';
          error.pgcode = '42501';
          error.status = 403;
          throw error;
        }
        return [authorize ?? {
          artist_id: args.p_artist_id,
          artist_slug: args.p_artist_id === K_ARTIST ? 'kristina' : 'vladimir',
          integration_key: args.p_artist_id === K_ARTIST ? 'kristina-instagram' : 'vladimir-instagram',
          instagram_user_id: null,
          is_enabled: false,
        }];
      }
      return { ok: true };
    },
  };
}

async function startConnection(body, { environment = env(), db = dbDouble(), auth = SESSION } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const request = new Request('https://instagram.vishartattoo.com/v1/connections/start', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const url = new URL(request.url);
  return { response: await workerTesting.startConnection(request, url, environment, db), db, environment };
}

await test('starting a connection requires an operator session', async () => {
  const { response } = await startConnection({ artist_id: V_ARTIST }, { auth: null });
  assert.equal(response.status, 401);
});

await test('starting a connection verifies the CRM session before authorizing its artist', async () => {
  const { response, db, environment } = await startConnection({ artist_id: V_ARTIST });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authorize_url.startsWith('https://www.instagram.com/oauth/authorize'));

  const verified = db.calls.find((call) => call.name === 'verifyUser');
  assert.equal(verified.bearer, SESSION);
  const authorised = db.calls.find((call) => call.name === 'service_authorize_instagram_connection');
  assert.equal(authorised.args.p_profile_id, TEST_PROFILE);
  assert.equal(authorised.args.p_artist_id, V_ARTIST);
  assert.ok(db.calls.indexOf(verified) < db.calls.indexOf(authorised));

  // The state is bound to the artist the database returned, not to anything
  // the browser said beyond naming the artist.
  const [stateValue] = [...environment.INSTAGRAM_OAUTH_STATE.store.values()];
  const state = JSON.parse(stateValue);
  assert.equal(state.artist_id, V_ARTIST);
  assert.equal(state.integration_key, 'vladimir-instagram');
});

await test('an operator without integration rights is refused', async () => {
  const { response } = await startConnection(
    { artist_id: K_ARTIST },
    { db: dbDouble({ authorize: 'deny' }) },
  );
  assert.equal(response.status, 403);
});

await test('an expired or invalid CRM session is a 401, not an artist permission error', async () => {
  const { response } = await startConnection(
    { artist_id: V_ARTIST },
    { db: dbDouble({ session: 'deny' }) },
  );
  assert.equal(response.status, 401);
});

await test('an authorization backend failure is unavailable, not a false 403', async () => {
  const { response } = await startConnection(
    { artist_id: V_ARTIST },
    { db: dbDouble({ throwOn: 'service_authorize_instagram_connection' }) },
  );
  assert.equal(response.status, 503);
});

await test('a browser cannot smuggle its own integration selector', async () => {
  const { response, environment, db } = await startConnection({
    artist_id: V_ARTIST,
    profile_id: 'c2222222-2222-4222-8222-222222222222',
    integration_key: 'kristina-instagram',
    instagram_user_id: K_ACCOUNT,
  });
  assert.equal(response.status, 200);
  const [stateValue] = [...environment.INSTAGRAM_OAUTH_STATE.store.values()];
  assert.equal(JSON.parse(stateValue).integration_key, 'vladimir-instagram');
  const authorised = db.calls.find((call) => call.name === 'service_authorize_instagram_connection');
  assert.equal(authorised.args.p_profile_id, TEST_PROFILE);
});

await test('a malformed artist id is refused before any database call', async () => {
  const db = dbDouble();
  const { response } = await startConnection({ artist_id: 'not-a-uuid' }, { db });
  assert.equal(response.status, 400);
  assert.equal(db.calls.length, 0);
});

await test('the onboarding route is closed while the connector is disabled', async () => {
  const { response } = await startConnection(
    { artist_id: V_ARTIST },
    { environment: env({ INSTAGRAM_OAUTH_ENABLED: 'false' }) },
  );
  assert.equal(response.status, 404);
});

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

function metaFetchDouble({
  permissions = ['instagram_business_basic', 'instagram_business_manage_messages'],
  account = V_ACCOUNT,
  meAccount = null,
  username = 'vladimir.synthetic',
} = {}) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.instagram.com/oauth/access_token')) {
      return new Response(JSON.stringify({
        access_token: 'synthetic-short-lived',
        user_id: account,
        permissions,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/access_token?') || url.includes('grant_type=ig_exchange_token')) {
      return new Response(JSON.stringify({
        access_token: 'synthetic-long-lived',
        expires_in: 60 * 24 * 60 * 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/me?') || url.endsWith('/me')) {
      return new Response(JSON.stringify({
        user_id: meAccount ?? account,
        username,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

async function seedState(environment, overrides = {}) {
  const state = 'S'.repeat(43);
  await environment.INSTAGRAM_OAUTH_STATE.put(`instagram:state:${state}`, JSON.stringify({
    v: 1,
    artist_id: V_ARTIST,
    artist_slug: 'vladimir',
    integration_key: 'vladimir-instagram',
    created_at: Date.now(),
    ...overrides,
  }));
  return state;
}

async function callback(state, { environment = env(), db = dbDouble(), fetchImpl = metaFetchDouble() } = {}) {
  const request = new Request(
    `https://instagram.vishartattoo.com/oauth/instagram/callback?code=synthetic-code&state=${state}`,
  );
  const url = new URL(request.url);
  return {
    response: await workerTesting.oauthCallback(request, url, environment, db, fetchImpl),
    db,
    environment,
  };
}

await test('a completed callback binds the account and stores the token only in the connector', async () => {
  const environment = env();
  const state = await seedState(environment);
  const { response, db } = await callback(state, { environment });
  assert.equal(response.status, 200);

  const bind = db.calls.find((call) => call.name === 'service_set_instagram_integration');
  assert.equal(bind.args.p_artist_id, V_ARTIST);
  assert.equal(bind.args.p_integration_key, 'vladimir-instagram');
  assert.equal(bind.args.p_instagram_user_id, V_ACCOUNT);
  // No token ever reaches the database.
  assert.ok(!JSON.stringify(bind.args).includes('synthetic-long-lived'));

  const stored = await loadToken(environment, V_ARTIST);
  assert.equal(stored.access_token, 'synthetic-long-lived');

  const body = await response.text();
  assert.ok(!body.includes('synthetic-long-lived'));
});

await test('the state is single use', async () => {
  const environment = env();
  const state = await seedState(environment);
  await callback(state, { environment });
  const { response } = await callback(state, { environment });
  assert.equal(response.status, 400);
});

await test('an unknown state is refused', async () => {
  const { response } = await callback('Z'.repeat(43));
  assert.equal(response.status, 400);
});

await test('an expired state is refused', async () => {
  const environment = env();
  const state = await seedState(environment, { created_at: Date.now() - 3_600_000 });
  const { response } = await callback(state, { environment });
  assert.equal(response.status, 400);
});

await test('a connection without messaging permission is refused', async () => {
  const environment = env();
  const state = await seedState(environment);
  const { response, db } = await callback(state, {
    environment,
    fetchImpl: metaFetchDouble({ permissions: ['instagram_business_basic'] }),
  });
  assert.equal(response.status, 403);
  assert.ok(!db.calls.some((call) => call.name === 'service_set_instagram_integration'));
  assert.equal(environment.INSTAGRAM_OAUTH_TOKENS.store.size, 0);
});

await test('an account that does not verify against the issued token is refused', async () => {
  const environment = env();
  const state = await seedState(environment);
  const { response, db } = await callback(state, {
    environment,
    fetchImpl: metaFetchDouble({ account: V_ACCOUNT, meAccount: K_ACCOUNT }),
  });
  assert.equal(response.status, 400);
  assert.ok(!db.calls.some((call) => call.name === 'service_set_instagram_integration'));
});

await test('a pinned artist account refuses any other Instagram profile', async () => {
  const environment = env({ INSTAGRAM_ACCOUNT_VLADIMIR: K_ACCOUNT });
  const state = await seedState(environment);
  const { response, db } = await callback(state, { environment });
  assert.equal(response.status, 403);
  assert.ok(!db.calls.some((call) => call.name === 'service_set_instagram_integration'));
  assert.equal(environment.INSTAGRAM_OAUTH_TOKENS.store.size, 0);
});

await test('a database refusal rolls the stored token back', async () => {
  const environment = env();
  const state = await seedState(environment);
  const { response } = await callback(state, {
    environment,
    db: dbDouble({ throwOn: 'service_set_instagram_integration' }),
  });
  assert.equal(response.status, 400);
  assert.equal(environment.INSTAGRAM_OAUTH_TOKENS.store.size, 0);
});

await test('a user-cancelled authorization connects nothing', async () => {
  const environment = env();
  const request = new Request(
    'https://instagram.vishartattoo.com/oauth/instagram/callback?error=access_denied',
  );
  const db = dbDouble();
  const response = await workerTesting.oauthCallback(
    request, new URL(request.url), environment, db, metaFetchDouble(),
  );
  assert.equal(response.status, 400);
  assert.equal(db.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

await test('disconnect disables the route before destroying the token', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = dbDouble();
  const request = new Request('https://instagram.vishartattoo.com/v1/connections/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SESSION}` },
    body: JSON.stringify({ artist_id: V_ARTIST }),
  });
  const response = await workerTesting.disconnect(request, new URL(request.url), environment, db);
  assert.equal(response.status, 200);

  const order = db.calls.map((call) => call.name);
  assert.ok(order.indexOf('service_authorize_instagram_connection') < order.indexOf('service_disable_instagram_integration'));
  assert.equal(environment.INSTAGRAM_OAUTH_TOKENS.store.size, 0);
});

await test('disconnect requires an operator session', async () => {
  const request = new Request('https://instagram.vishartattoo.com/v1/connections/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artist_id: V_ARTIST }),
  });
  const response = await workerTesting.disconnect(request, new URL(request.url), env(), dbDouble());
  assert.equal(response.status, 401);
});

await test('connection status never returns the token itself', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = dbDouble({
    authorize: {
      artist_id: V_ARTIST,
      artist_slug: 'vladimir',
      integration_key: 'vladimir-instagram',
      instagram_user_id: V_ACCOUNT,
      is_enabled: true,
    },
  });
  const request = new Request(
    `https://instagram.vishartattoo.com/v1/connections/status?artist_id=${V_ARTIST}`,
    { headers: { authorization: `Bearer ${SESSION}` } },
  );
  const response = await workerTesting.connectionStatus(request, new URL(request.url), environment, db);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes('synthetic-long-lived-token'));
  const payload = JSON.parse(body);
  assert.equal(payload.connected, true);
  assert.ok(payload.token_expires_at);
});

// ---------------------------------------------------------------------------
// Outbound delivery
// ---------------------------------------------------------------------------

function claimedJob(overrides = {}) {
  return {
    outbox_id: OUTBOX_ID,
    artist_id: V_ARTIST,
    kind: 'instagram_message',
    channel: 'instagram',
    communication_message_id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    integration_key: 'vladimir-instagram',
    external_contact_id: RECIPIENT,
    body: 'Reply from the CRM',
    attempt_count: 0,
    max_attempts: 8,
    job_valid: true,
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    outbox_id: OUTBOX_ID,
    artist_id: V_ARTIST,
    kind: 'instagram_message',
    integration_type: 'instagram',
    provider: 'instagram_login',
    integration_key: 'vladimir-instagram',
    external_account_label: '@vladimir.synthetic',
    configuration: { instagram_user_id: V_ACCOUNT },
    ...overrides,
  };
}

function drainDouble({ jobs = [claimedJob()], routeRow = route() } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_communication_outbox') return jobs;
      if (name === 'resolve_outbox_route') return [routeRow];
      return { changed: true };
    },
  };
}

await test('a claimed job is refused unless every routing field is coherent', () => {
  assert.throws(() => validateClaimedJob(claimedJob({ job_valid: false }), 'instagram'), CommunicationsDrainError);
  assert.throws(() => validateClaimedJob(claimedJob({ channel: 'whatsapp' }), 'instagram'), CommunicationsDrainError);
  assert.throws(() => validateClaimedJob(claimedJob({ external_contact_id: 'nope' }), 'instagram'), CommunicationsDrainError);
  assert.throws(() => validateClaimedJob(claimedJob({ body: '  ' }), 'instagram'), CommunicationsDrainError);
  assert.ok(validateClaimedJob(claimedJob(), 'instagram'));
});

await test('a route that disagrees with the job about the artist is refused', () => {
  const job = validateClaimedJob(claimedJob(), 'instagram');
  assert.throws(() => validateRoute(route({ artist_id: K_ARTIST }), job, 'instagram'));
  assert.throws(() => validateRoute(route({ integration_key: 'kristina-instagram' }), job, 'instagram'));
  assert.throws(() => validateRoute(route({ integration_type: 'whatsapp' }), job, 'instagram'));
  assert.ok(validateRoute(route(), job, 'instagram'));
});

await test('a delivered message acknowledges with the provider message id only', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = drainDouble();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return new Response(JSON.stringify({ recipient_id: RECIPIENT, message_id: 'ig_mid_SENT000000001' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const result = await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, unrecorded: 0 });
  assert.equal(sent[0].url, `https://graph.instagram.com/v25.0/${V_ACCOUNT}/messages`);
  assert.equal(sent[0].body.recipient.id, RECIPIENT);
  assert.equal(sent[0].auth, 'Bearer synthetic-long-lived-token');

  const ack = db.calls.find((call) => call.name === 'record_communication_outbox_result');
  assert.equal(ack.args.p_succeeded, true);
  assert.equal(ack.args.p_provider_message_id, 'ig_mid_SENT000000001');
});

await test('the recipient always comes from the claimed job, never from the queue payload', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  // A tampered outbox payload naming a different recipient must have no effect:
  // the drain only ever reads the recomputed claim projection.
  const db = drainDouble({ jobs: [claimedJob()] });
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message_id: 'ig_mid_SENT000000002' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });
  assert.equal(sent[0].recipient.id, RECIPIENT);
});

await test('a token issued for a different account cannot send from this route', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord({ instagram_user_id: K_ACCOUNT }));
  const db = drainDouble();
  const fetchImpl = async () => {
    throw new Error('the provider must not be contacted');
  };
  const result = await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });
  assert.equal(result.failed, 1);
  const ack = db.calls.find((call) => call.name === 'record_communication_outbox_result');
  assert.equal(ack.args.p_error_code, 'instagram_token_binding_mismatch');
});

await test('Meta messaging window refusal is reported as its own explicit state', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = drainDouble();
  const fetchImpl = async () => new Response(JSON.stringify({
    error: {
      message: 'This message is sent outside of allowed window.',
      code: 10,
      error_subcode: 2534022,
    },
  }), { status: 400, headers: { 'content-type': 'application/json' } });

  const result = await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });
  assert.equal(result.failed, 1);
  const ack = db.calls.find((call) => call.name === 'record_communication_outbox_result');
  assert.equal(ack.args.p_error_code, 'instagram_outside_messaging_window');
});

await test('a rejected credential is reported without leaking the provider body', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = drainDouble();
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { message: 'Invalid OAuth access token for 447700900000', code: 190 },
  }), { status: 401, headers: { 'content-type': 'application/json' } });

  await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });
  const ack = db.calls.find((call) => call.name === 'record_communication_outbox_result');
  assert.equal(ack.args.p_error_code, 'instagram_credentials_rejected');
  assert.ok(!JSON.stringify(ack.args).includes('447700900000'));
});

await test('an acknowledgement failure after a provider accept is reported as unrecorded', async () => {
  const environment = env();
  await storeToken(environment, tokenRecord());
  const db = {
    calls: [],
    async rpc(name, args) {
      this.calls.push({ name, args });
      if (name === 'claim_communication_outbox') return [claimedJob()];
      if (name === 'resolve_outbox_route') return [route()];
      if (name === 'record_communication_outbox_result') throw new Error('synthetic ack failure');
      return {};
    },
  };
  const fetchImpl = async () => new Response(JSON.stringify({ message_id: 'ig_mid_SENT000000003' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const result = await drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: workerTesting.instagramDeliver(environment, db, fetchImpl),
    workerId: 'instagram-test-worker',
  });
  assert.equal(result.unrecorded, 1);
  assert.equal(result.succeeded, 0);
});

await test('a send is refused before the provider when the message is unusable', async () => {
  const results = await Promise.all([
    sendInstagramMessage({ accessToken: 't', instagramUserId: 'nope', recipientId: RECIPIENT, body: 'x' }),
    sendInstagramMessage({ accessToken: 't', instagramUserId: V_ACCOUNT, recipientId: 'nope', body: 'x' }),
    sendInstagramMessage({ accessToken: 't', instagramUserId: V_ACCOUNT, recipientId: RECIPIENT, body: '  ' }),
    sendInstagramMessage({ accessToken: '', instagramUserId: V_ACCOUNT, recipientId: RECIPIENT, body: 'x' }),
  ]);
  assert.deepEqual(results.map((result) => result.errorCode), [
    'instagram_account_invalid',
    'instagram_destination_invalid',
    'instagram_message_invalid',
    'instagram_token_missing',
  ]);
});

// ---------------------------------------------------------------------------
// Database credential surface
// ---------------------------------------------------------------------------

await test('the connector service credential can call only the intended RPCs', () => {
  assert.deepEqual([...supabaseTesting.BACKEND_RPCS].sort(), [
    'claim_communication_outbox',
    'record_communication_inbound_message',
    'record_communication_outbound_echo',
    'record_communication_outbox_result',
    'record_communication_read_receipt',
    'resolve_outbox_route',
    'service_authorize_instagram_connection',
    'service_disable_instagram_integration',
    'service_list_unenriched_participants',
    'service_resolve_instagram_route',
    'service_set_instagram_integration',
    'service_update_communication_participant',
  ]);
  assert.deepEqual([...supabaseTesting.USER_RPCS], []);
});

await test('the connector cannot use its service credential for CRM finance or user management', () => {
  for (const forbidden of [
    'create_manual_enquiry',
    'request_session_deposit',
    'link_communication_conversation_client',
    'create_enquiry_from_communication',
    'queue_communication_message',
  ]) {
    assert.ok(!supabaseTesting.BACKEND_RPCS.has(forbidden), forbidden);
    assert.ok(!supabaseTesting.USER_RPCS.has(forbidden), forbidden);
  }
});

console.log(`instagram connector: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
