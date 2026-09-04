import assert from 'node:assert/strict';
import {
  OAuthSecurityError,
  accessEmail,
  buildDisconnectStateRecord,
  buildOAuthStateRecord,
  calendarReadiness,
  consumeDisconnectState,
  consumeOAuthState,
  disconnectConfirmationPage,
  disconnectConfirmationToken,
  disconnectReturnUrl,
  isCalendarArtistRef,
  isConfirmedDisconnectRequest,
  requireOwnerAccess,
  validateGoogleAccount,
  validateTokenExchange,
  verifiedCalendarActorEmail,
  verifiedOwnerEmail,
  __testing as securityTesting,
} from '../workers/lib/calendar-oauth-security.js';
import { __testing as workerTesting } from '../workers/calendar-oauth.js';

let passes = 0;
let failures = 0;
async function test(name, run) {
  try { await run(); passes += 1; }
  catch (error) { failures += 1; console.error(`FAIL: ${name}`); console.error(error); }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

const accessKeys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', accessKeys.publicKey);
Object.assign(publicJwk, { kid: 'calendar-access-test', alg: 'RS256', use: 'sig' });

async function accessToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({
    alg: 'RS256',
    kid: publicJwk.kid,
    typ: 'JWT',
  }));
  const payload = base64Url(JSON.stringify({
    iss: 'https://vishar-test.cloudflareaccess.com',
    aud: ['calendar-access-audience'],
    email: 'vvetrov41@gmail.com',
    iat: now - 10,
    exp: now + 600,
    ...overrides,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    accessKeys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

// The Worker deliberately carries no artist table. This fixture stands in for
// the CRM access graph the backend-only resolver reads, including an artist
// that is deactivated and one that has never connected a Google account.
const VLADIMIR_ID = 'a1111111-1111-4111-8111-111111111111';
const KRISTINA_ID = 'a2222222-2222-4222-8222-222222222222';
const SAM_ID = 'd629dab2-4d89-4f0c-bb96-34eb6f44eedc';
const RETIRED_ID = 'a9999999-9999-4999-8999-999999999999';

const CRM_ARTISTS = [
  {
    id: VLADIMIR_ID,
    slug: 'vladimir',
    displayName: 'Vladimir',
    account: 'vvetrov41@gmail.com',
    active: true,
    operators: ['vvetrov41@gmail.com'],
  },
  {
    id: KRISTINA_ID,
    slug: 'kristina',
    displayName: 'Kristina',
    account: 'tinaakaten@gmail.com',
    active: true,
    operators: ['vvetrov41@gmail.com', 'tinaakaten@gmail.com'],
    presentation: { event_label_name: 'Wisteria', event_label_color: '#b39ddb' },
  },
  {
    id: SAM_ID,
    slug: 'sam',
    displayName: 'Sam',
    account: null,
    active: true,
    operators: ['vishnyapnd@yandex.ru'],
  },
  {
    id: RETIRED_ID,
    slug: 'retired',
    displayName: 'Retired',
    account: null,
    active: false,
    operators: ['vvetrov41@gmail.com'],
  },
];

function crmArtist(ref) {
  return CRM_ARTISTS.find((artist) => artist.id === ref || artist.slug === ref) || null;
}

function resolverAnswer(actorEmail, ref) {
  const artist = crmArtist(ref);
  if (!artist || !artist.active) return null;
  if (!artist.operators.includes(String(actorEmail).toLowerCase())) return null;
  return {
    artist_id: artist.id,
    artist_slug: artist.slug,
    artist_display_name: artist.displayName,
    integration_key: `google_calendar_${artist.slug}`,
    expected_account_email: artist.account,
    connected: Boolean(artist.account),
    presentation: {
      event_visibility: 'public',
      event_display_name: artist.displayName,
      event_color_id: null,
      event_label_name: null,
      event_label_color: null,
      ...(artist.presentation || {}),
    },
  };
}

const env = {
  VISHAR_ENVIRONMENT: 'staging',
  CALENDAR_OWNER_EMAILS: 'vvetrov41@gmail.com',
  CALENDAR_ACCESS_TEAM_DOMAIN: 'https://vishar-test.cloudflareaccess.com',
  CALENDAR_ACCESS_AUD: 'calendar-access-audience',
  GOOGLE_OAUTH_CLIENT_ID: 'client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://calendar-staging.vishartattoo.com/oauth/google/callback',
  CALENDAR_TOKEN_ENCRYPTION_KEY: 'key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  CRM_RETURN_URL: 'https://vishar-crm-staging.pages.dev/#/appointments',
  CRM_APPOINTMENTS_URL: 'https://vishar-crm-staging.pages.dev/#/appointments',
  CALENDAR_OAUTH_STATE: {},
  CALENDAR_OAUTH_TOKENS: {},
};

const certFetch = async (url) => {
  assert.equal(
    String(url),
    'https://vishar-test.cloudflareaccess.com/cdn-cgi/access/certs',
  );
  return Response.json({ keys: [publicJwk] });
};

const crmFetch = async (url, options = {}) => {
  const value = String(url);
  if (value.endsWith('/cdn-cgi/access/certs')) return certFetch(url);
  const body = JSON.parse(String(options.body || '{}'));
  if (value.endsWith('/rpc/resolve_calendar_artist_route')) {
    return Response.json(resolverAnswer(body.p_actor_email, body.p_artist_ref));
  }
  if (value.endsWith('/rpc/authorize_calendar_actor')) {
    return Response.json(Boolean(resolverAnswer(body.p_actor_email, body.p_artist_id)));
  }
  throw new Error(`unexpected test fetch: ${value}`);
};

function requestWithToken(token, email = 'vvetrov41@gmail.com', url = 'https://calendar-staging.vishartattoo.com/') {
  return new Request(url, {
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Cf-Access-Authenticated-User-Email': email,
    },
  });
}

const ownerRequest = requestWithToken(await accessToken(), ' Vvetrov41@Gmail.com ');
const kristinaToken = await accessToken({ email: 'tinaakaten@gmail.com' });
const kristinaRequest = requestWithToken(kristinaToken, ' tinaakaten@gmail.com ');
const samToken = await accessToken({ email: 'vishnyapnd@yandex.ru' });

function stateStore() {
  const store = new Map();
  return {
    store,
    namespace: {
      put: async (key, value) => { store.set(key, value); },
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      delete: async (key) => { store.delete(key); },
    },
  };
}

await test('Cloudflare Access owner identity requires a valid signed JWT', async () => {
  assert.equal(accessEmail(ownerRequest), 'vvetrov41@gmail.com');
  assert.equal(await verifiedCalendarActorEmail(ownerRequest, env, certFetch), 'vvetrov41@gmail.com');
  assert.equal(await verifiedOwnerEmail(ownerRequest, env, certFetch), 'vvetrov41@gmail.com');
  assert.equal(await requireOwnerAccess(ownerRequest, env, certFetch), true);
  assert.equal(await requireOwnerAccess(new Request(ownerRequest.url), env, certFetch), false);
});

await test('Access proves identity for any operator; owner override stays owner-only', async () => {
  // No artist email allow-list any more: a new artist's booking manager must be
  // able to reach the connector on day one without a Worker variable.
  assert.equal(
    await verifiedCalendarActorEmail(kristinaRequest, env, certFetch),
    'tinaakaten@gmail.com',
  );
  const samRequest = requestWithToken(samToken, 'vishnyapnd@yandex.ru');
  assert.equal(
    await verifiedCalendarActorEmail(samRequest, env, certFetch),
    'vishnyapnd@yandex.ru',
  );
  await assert.rejects(
    verifiedOwnerEmail(kristinaRequest, env, certFetch),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'owner_access_required'
      && error.status === 403,
  );
});

await test('artist references are shape-checked before any backend call', () => {
  assert.equal(isCalendarArtistRef('vladimir'), true);
  assert.equal(isCalendarArtistRef('new-artist-42'), true);
  assert.equal(isCalendarArtistRef(VLADIMIR_ID), true);
  assert.equal(isCalendarArtistRef('Vladimir'), false);
  assert.equal(isCalendarArtistRef('../admin'), false);
  assert.equal(isCalendarArtistRef(''), false);
});

await test('resolver output is validated before it can drive a connection', () => {
  const valid = resolverAnswer('vishnyapnd@yandex.ru', 'sam');
  assert.equal(workerTesting.normalizedArtistRoute(valid).artistId, SAM_ID);
  assert.equal(workerTesting.normalizedArtistRoute(valid).expectedEmail, '');
  assert.equal(workerTesting.normalizedArtistRoute(null), null);
  // A selector that names another artist would point one artist's consent at
  // another artist's calendar row.
  assert.equal(
    workerTesting.normalizedArtistRoute({ ...valid, integration_key: 'google_calendar_vladimir' }),
    null,
  );
  assert.equal(workerTesting.normalizedArtistRoute({ ...valid, artist_id: 'not-a-uuid' }), null);
  assert.equal(workerTesting.normalizedArtistRoute({ ...valid, artist_slug: 'Sam' }), null);
  assert.equal(
    workerTesting.normalizedArtistRoute({ ...valid, expected_account_email: 'not an email' }),
    null,
  );
});

await test('a new artist starts OAuth with no Worker change and no artist variable', async () => {
  const { store, namespace } = stateStore();
  const scopedEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const request = requestWithToken(
    samToken,
    'vishnyapnd@yandex.ru',
    'https://calendar-staging.vishartattoo.com/oauth/google/start/sam',
  );
  const response = await workerTesting.startOAuth(request, 'sam', scopedEnv, crmFetch);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.equal(store.size, 1);
  const record = JSON.parse([...store.values()][0]);
  assert.equal(record.artistId, SAM_ID);
  assert.equal(record.alias, 'sam');
  assert.equal(record.ownerEmail, 'vishnyapnd@yandex.ru');
});

await test('cross-artist, unknown and inactive artists are one indistinguishable denial', async () => {
  const { namespace } = stateStore();
  const scopedEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const denied = async (ref, token, email) => {
    const request = requestWithToken(
      token,
      email,
      `https://calendar-staging.vishartattoo.com/oauth/google/start/${ref}`,
    );
    await assert.rejects(
      workerTesting.startOAuth(request, ref, scopedEnv, crmFetch),
      (error) => error instanceof OAuthSecurityError
        && error.code === 'calendar_artist_access_denied'
        && error.status === 403,
      `expected denial for ${ref}`,
    );
  };

  // Cross-artist: Sam's manager has no access to Vladimir.
  await denied('vladimir', samToken, 'vishnyapnd@yandex.ru');
  // Unauthorized operator for an artist that exists.
  await denied('sam', kristinaToken, 'tinaakaten@gmail.com');
  // Unknown artist.
  await denied('nobody', samToken, 'vishnyapnd@yandex.ru');
  // Inactive artist, even for the owner who is a member of it.
  await denied('retired', await accessToken(), 'vvetrov41@gmail.com');
  // Malformed reference never reaches the backend.
  await denied('..', samToken, 'vishnyapnd@yandex.ru');
});

await test('CRM authorization backend errors fail closed without starting OAuth', async () => {
  const { namespace } = stateStore();
  const scopedEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const request = requestWithToken(
    samToken,
    'vishnyapnd@yandex.ru',
    'https://calendar-staging.vishartattoo.com/oauth/google/start/sam',
  );
  await assert.rejects(
    workerTesting.startOAuth(request, 'sam', scopedEnv, async (url) => (
      String(url).endsWith('/cdn-cgi/access/certs')
        ? certFetch(url)
        : Response.json({ error: 'unavailable' }, { status: 503 })
    )),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'calendar_actor_authorization_failed'
      && error.status === 502,
  );

  // A capability revoked between resolution and the write still blocks it.
  await assert.rejects(
    workerTesting.authorizeCalendarActor(
      { artistId: SAM_ID },
      'vishnyapnd@yandex.ru',
      env,
      async (url) => (String(url).endsWith('/authorize_calendar_actor')
        ? Response.json(false)
        : certFetch(url)),
    ),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'calendar_artist_access_denied'
      && error.status === 403,
  );
});

await test('Access JWT rejects the wrong application audience', async () => {
  const wrongAudience = requestWithToken(await accessToken({ aud: ['other-application'] }));
  await assert.rejects(
    verifiedOwnerEmail(wrongAudience, env, certFetch),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'owner_access_required'
      && error.status === 403,
  );
});

await test('Access JWT and forwarded email must identify the same actor', async () => {
  const mismatch = requestWithToken(await accessToken(), 'other@example.com');
  await assert.rejects(
    verifiedCalendarActorEmail(mismatch, env, certFetch),
    (error) => error.code === 'owner_access_required',
  );
});

await test('OAuth state is bound to the verified actor and consumed once', async () => {
  const { store, namespace } = stateStore();
  const record = buildOAuthStateRecord(VLADIMIR_ID, 'vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com');
  store.set('state:single-use', JSON.stringify(record));
  const consumed = await consumeOAuthState(namespace, 'single-use', 'vvetrov41@gmail.com');
  assert.equal(consumed.artistId, VLADIMIR_ID);
  assert.equal(consumed.alias, 'vladimir');
  await assert.rejects(
    consumeOAuthState(namespace, 'single-use', 'vvetrov41@gmail.com'),
    (error) => error instanceof OAuthSecurityError && error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('OAuth state cannot be completed by a different verified actor', async () => {
  const record = buildOAuthStateRecord(KRISTINA_ID, 'kristina', 'k'.repeat(64), 'tinaakaten@gmail.com');
  const namespace = { get: async () => record, delete: async () => {} };
  await assert.rejects(
    consumeOAuthState(namespace, 'state', 'vvetrov41@gmail.com'),
    (error) => error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('OAuth state must carry an artist UUID, not a browser-supplied name', () => {
  assert.throws(
    () => buildOAuthStateRecord('vladimir', 'vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com'),
    (error) => error.code === 'oauth_state_invalid_or_expired',
  );
  assert.throws(
    () => buildOAuthStateRecord(VLADIMIR_ID, 'Vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com'),
    (error) => error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('a substituted OAuth state cannot complete against another artist', async () => {
  // The callback resolves the artist from the stored UUID, so tampering with
  // the record's slug is caught before the authorization code is exchanged.
  const { store, namespace } = stateStore();
  store.set('state:swapped', JSON.stringify({
    ...buildOAuthStateRecord(KRISTINA_ID, 'kristina', 'k'.repeat(64), 'tinaakaten@gmail.com'),
    alias: 'vladimir',
  }));
  const callbackEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const request = requestWithToken(
    kristinaToken,
    'tinaakaten@gmail.com',
    'https://calendar-staging.vishartattoo.com/oauth/google/callback?state=swapped&code=abc',
  );
  await assert.rejects(
    workerTesting.callback(request, callbackEnv, crmFetch),
    (error) => error.code === 'oauth_state_invalid_or_expired',
  );
  assert.equal(store.has('state:swapped'), false);
});

await test('a state whose artist the actor may no longer manage is refused', async () => {
  const { namespace } = stateStore();
  namespace.put('state:stale', JSON.stringify(
    buildOAuthStateRecord(SAM_ID, 'sam', 's'.repeat(64), 'vishnyapnd@yandex.ru'),
  ));
  const callbackEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const request = requestWithToken(
    samToken,
    'vishnyapnd@yandex.ru',
    'https://calendar-staging.vishartattoo.com/oauth/google/callback?state=stale&code=abc',
  );
  await assert.rejects(
    workerTesting.callback(request, callbackEnv, async (url, options) => {
      if (String(url).endsWith('/rpc/resolve_calendar_artist_route')) return Response.json(null);
      return crmFetch(url, options);
    }),
    (error) => error.code === 'calendar_artist_access_denied' && error.status === 403,
  );
});

await test('token exchange requires both access and refresh tokens', () => {
  assert.equal(validateTokenExchange(true, { access_token: 'a', refresh_token: 'r' }).refresh_token, 'r');
  assert.throws(
    () => validateTokenExchange(true, { access_token: 'a' }),
    (error) => error.code === 'google_token_exchange_failed' && error.status === 502,
  );
});

await test('a pinned Google account is exact; an unpinned artist binds on first consent', () => {
  assert.equal(
    validateGoogleAccount(true, { email: 'Vvetrov41@gmail.com', email_verified: true }, 'vvetrov41@gmail.com'),
    'vvetrov41@gmail.com',
  );
  assert.throws(
    () => validateGoogleAccount(true, { email: 'someone@else.test', email_verified: true }, 'vvetrov41@gmail.com'),
    (error) => error.code === 'google_account_mismatch' && error.status === 403,
  );
  assert.throws(
    () => validateGoogleAccount(true, { email: 'vvetrov41@gmail.com', email_verified: false }, 'vvetrov41@gmail.com'),
    (error) => error.code === 'google_account_mismatch',
  );
  // First connection: nothing is pinned yet, so the verified account binds it.
  assert.equal(
    validateGoogleAccount(true, { email: 'Sam@example.test', email_verified: true }, ''),
    'sam@example.test',
  );
  // An unverified or missing Google email is still refused with no pin.
  assert.throws(
    () => validateGoogleAccount(true, { email: 'sam@example.test', email_verified: false }, ''),
    (error) => error.code === 'google_account_mismatch',
  );
  assert.throws(
    () => validateGoogleAccount(true, { email_verified: true }, ''),
    (error) => error.code === 'google_account_mismatch',
  );
});

await test('readiness reports booleans only and keeps the drain disabled', () => {
  const status = calendarReadiness(env);
  assert.equal(status.bindings.oauthState, true);
  assert.equal(status.configuration.googleOauth, true);
  assert.equal(status.configuration.supabase, true);
  assert.equal(status.configuration.artistRouting, true);
  assert.equal(status.configuration.ownerAccess, true);
  assert.equal(status.configuration.crmAppointments, true);
  assert.equal(status.scheduledDrain, false);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('service-role'));
  assert.ok(!serialized.includes('vvetrov41@gmail.com'));
  assert.ok(!serialized.includes('calendar-access-audience'));
});

await test('readiness rejects ambiguous Supabase and Access configuration', () => {
  assert.equal(
    calendarReadiness({ ...env, SUPABASE_SECRET_KEY: 'sb_secret_test' }).configuration.supabase,
    false,
  );
  assert.equal(
    calendarReadiness({ ...env, SUPABASE_URL: '' }).configuration.artistRouting,
    false,
  );
  assert.equal(
    calendarReadiness({ ...env, CALENDAR_ACCESS_AUD: '' }).configuration.ownerAccess,
    false,
  );
});

await test('disconnect confirmation is explicit, tokenized and escapes all URLs', () => {
  const token = 'd'.repeat(64);
  const page = disconnectConfirmationPage(
    'Sam <script>',
    'https://calendar-staging.vishartattoo.com/oauth/google/disconnect/sam?x="bad"',
    'https://vishar-crm-staging.pages.dev/?a=<bad>#/appointments',
    token,
  );
  assert.match(page, /name="confirm" value="disconnect"/);
  assert.match(page, new RegExp(`name="disconnect_token" value="${token}"`));
  assert.ok(!page.includes('<bad>'));
  assert.ok(!page.includes('x="bad"'));
  // The display name is server-resolved, but it is still artist-controlled text.
  assert.ok(!page.includes('<script>'));
  assert.match(page, /Sam &lt;script&gt;/);
  assert.throws(
    () => disconnectConfirmationPage('', 'https://example.test/', 'https://example.test/', token),
    (error) => error.code === 'artist_route_unconfigured' && error.status === 404,
  );
});

await test('disconnect POST rejects a static cross-site payload without a nonce', async () => {
  const token = 'd'.repeat(64);
  const confirmed = new Request('https://example.test/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `confirm=disconnect&disconnect_token=${token}`,
  });
  const confirmedCopy = confirmed.clone();
  const staticPayload = new Request('https://example.test/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'confirm=disconnect',
  });
  assert.equal(await disconnectConfirmationToken(confirmed), token);
  assert.equal(await isConfirmedDisconnectRequest(confirmedCopy), true);
  assert.equal(await disconnectConfirmationToken(staticPayload), '');
});

await test('disconnect nonce is verified-actor-bound, artist-bound and single-use', async () => {
  const token = 'n'.repeat(64);
  const { store, namespace } = stateStore();
  store.set(
    `disconnect:${token}`,
    JSON.stringify(buildDisconnectStateRecord(KRISTINA_ID, 'tinaakaten@gmail.com')),
  );
  assert.equal(
    (await consumeDisconnectState(namespace, KRISTINA_ID, token, 'tinaakaten@gmail.com')).artistId,
    KRISTINA_ID,
  );
  await assert.rejects(
    consumeDisconnectState(namespace, KRISTINA_ID, token, 'tinaakaten@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );

  store.set(
    `disconnect:${token}`,
    JSON.stringify(buildDisconnectStateRecord(KRISTINA_ID, 'tinaakaten@gmail.com')),
  );
  await assert.rejects(
    consumeDisconnectState(namespace, VLADIMIR_ID, token, 'tinaakaten@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );

  store.set(
    `disconnect:${token}`,
    JSON.stringify(buildDisconnectStateRecord(KRISTINA_ID, 'tinaakaten@gmail.com')),
  );
  await assert.rejects(
    consumeDisconnectState(namespace, KRISTINA_ID, token, 'vvetrov41@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );

  assert.throws(
    () => buildDisconnectStateRecord('kristina', 'tinaakaten@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );
});

await test('OAuth denial consumes its state before returning a safe error', async () => {
  const state = 'denied-state';
  const { store, namespace } = stateStore();
  store.set(
    `state:${state}`,
    JSON.stringify(buildOAuthStateRecord(VLADIMIR_ID, 'vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com')),
  );
  const callbackEnv = { ...env, CALENDAR_OAUTH_STATE: namespace };
  const denied = requestWithToken(
    await accessToken(),
    'vvetrov41@gmail.com',
    `https://calendar-staging.vishartattoo.com/oauth/google/callback?state=${state}&error=access_denied`,
  );
  const response = await workerTesting.callback(denied, callbackEnv, certFetch);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'google_authorisation_denied');
  assert.equal(store.has(`state:${state}`), false);
});

await test('route classes stay stable for any artist reference', () => {
  assert.equal(workerTesting.rateLimitRouteClass('/health'), 'health');
  assert.equal(workerTesting.rateLimitRouteClass('/oauth/google/callback'), 'oauth_callback');
  assert.equal(workerTesting.rateLimitRouteClass('/oauth/google/start/sam'), 'oauth_start');
  assert.equal(
    workerTesting.rateLimitRouteClass(`/oauth/google/start/${VLADIMIR_ID}`),
    'oauth_start',
  );
  assert.equal(
    workerTesting.rateLimitRouteClass('/oauth/google/disconnect/new-artist-42'),
    'oauth_disconnect',
  );
  assert.equal(workerTesting.rateLimitRouteClass('/oauth/google/start/a/b'), 'other');
});

await test('disconnect return URL preserves the hash route and contains no credentials', () => {
  const url = new URL(disconnectReturnUrl(env, 'kristina', false));
  assert.equal(url.pathname, '/');
  assert.equal(url.hash, '#/appointments');
  assert.equal(url.searchParams.get('calendar'), 'disconnected');
  assert.equal(url.searchParams.get('artist'), 'kristina');
  assert.equal(url.searchParams.get('revoked'), 'false');
  assert.ok(!url.toString().includes('secret'));
});

securityTesting.accessJwksCache.clear();

if (failures) {
  console.error(`\n${failures} OAuth hardening test(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`Calendar OAuth hardening tests passed: ${passes} cases.`);
