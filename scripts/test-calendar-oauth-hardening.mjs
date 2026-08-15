import assert from 'node:assert/strict';
import {
  OAuthSecurityError,
  accessEmail,
  buildDisconnectStateRecord,
  buildOAuthStateRecord,
  calendarActorEmails,
  calendarReadiness,
  canManageCalendarAlias,
  consumeDisconnectState,
  consumeOAuthState,
  disconnectConfirmationPage,
  disconnectConfirmationToken,
  disconnectReturnUrl,
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
  VLADIMIR_ARTIST_ID: 'artist-vladimir',
  VLADIMIR_GOOGLE_EMAIL: 'vvetrov41@gmail.com',
  KRISTINA_ARTIST_ID: 'artist-kristina',
  KRISTINA_GOOGLE_EMAIL: 'tinaakaten@gmail.com',
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

const authorizedActorFetch = async (url, options = {}) => {
  const value = String(url);
  if (value.endsWith('/cdn-cgi/access/certs')) return certFetch(url);
  if (value === 'https://example.supabase.co/rest/v1/rpc/authorize_calendar_actor') {
    const body = JSON.parse(String(options.body || '{}'));
    return Response.json(
      body.p_actor_email === 'tinaakaten@gmail.com'
      && body.p_artist_id === 'artist-kristina',
    );
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

await test('Cloudflare Access owner identity requires a valid signed JWT', async () => {
  assert.equal(accessEmail(ownerRequest), 'vvetrov41@gmail.com');
  assert.equal(await verifiedCalendarActorEmail(ownerRequest, env, certFetch), 'vvetrov41@gmail.com');
  assert.equal(await verifiedOwnerEmail(ownerRequest, env, certFetch), 'vvetrov41@gmail.com');
  assert.equal(await requireOwnerAccess(ownerRequest, env, certFetch), true);
  assert.equal(await requireOwnerAccess(new Request(ownerRequest.url), env, certFetch), false);
});

await test('signed artist Access identity is allowed only for its own Calendar alias while owner keeps override', async () => {
  assert.deepEqual(
    calendarActorEmails(env).sort(),
    ['tinaakaten@gmail.com', 'vvetrov41@gmail.com'],
  );
  assert.equal(
    await verifiedCalendarActorEmail(kristinaRequest, env, certFetch),
    'tinaakaten@gmail.com',
  );
  await assert.rejects(
    verifiedOwnerEmail(kristinaRequest, env, certFetch),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'owner_access_required'
      && error.status === 403,
  );
  assert.equal(canManageCalendarAlias('tinaakaten@gmail.com', 'kristina', env), true);
  assert.equal(canManageCalendarAlias('tinaakaten@gmail.com', 'vladimir', env), false);
  assert.equal(canManageCalendarAlias('vvetrov41@gmail.com', 'vladimir', env), true);
  assert.equal(canManageCalendarAlias('vvetrov41@gmail.com', 'kristina', env), true);
});

await test('a valid Access session outside the closed owner/artist allow-list is rejected', async () => {
  const otherToken = await accessToken({ email: 'other@example.com' });
  const otherRequest = requestWithToken(otherToken, 'other@example.com');
  await assert.rejects(
    verifiedCalendarActorEmail(otherRequest, env, certFetch),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'owner_access_required'
      && error.status === 403,
  );
});

await test('artist self-service start requires both own alias and current CRM capability', async () => {
  const writes = new Map();
  const scopedEnv = {
    ...env,
    CALENDAR_OAUTH_STATE: {
      put: async (key, value) => { writes.set(key, value); },
    },
  };
  const ownStartRequest = requestWithToken(
    kristinaToken,
    'tinaakaten@gmail.com',
    'https://calendar-staging.vishartattoo.com/oauth/google/start/kristina',
  );
  const response = await workerTesting.startOAuth(
    ownStartRequest,
    'kristina',
    scopedEnv,
    authorizedActorFetch,
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.equal(writes.size, 1);

  const crossArtistRequest = requestWithToken(
    kristinaToken,
    'tinaakaten@gmail.com',
    'https://calendar-staging.vishartattoo.com/oauth/google/start/vladimir',
  );
  await assert.rejects(
    workerTesting.startOAuth(crossArtistRequest, 'vladimir', scopedEnv, authorizedActorFetch),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'calendar_artist_access_denied'
      && error.status === 403,
  );

  await assert.rejects(
    workerTesting.authorizeCalendarActor(
      workerTesting.artistConfig('kristina', env),
      'tinaakaten@gmail.com',
      env,
      async (url) => String(url).endsWith('/authorize_calendar_actor')
        ? Response.json(false)
        : certFetch(url),
    ),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'calendar_artist_access_denied'
      && error.status === 403,
  );
});

await test('CRM Calendar authorization backend errors fail closed without starting OAuth', async () => {
  await assert.rejects(
    workerTesting.authorizeCalendarActor(
      workerTesting.artistConfig('kristina', env),
      'tinaakaten@gmail.com',
      env,
      async () => Response.json({ error: 'unavailable' }, { status: 503 }),
    ),
    (error) => error instanceof OAuthSecurityError
      && error.code === 'calendar_actor_authorization_failed'
      && error.status === 502,
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
  const store = new Map();
  const namespace = {
    get: async (key) => store.has(key) ? JSON.parse(store.get(key)) : null,
    delete: async (key) => { store.delete(key); },
  };
  const record = buildOAuthStateRecord('vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com');
  store.set('state:single-use', JSON.stringify(record));
  assert.equal(
    (await consumeOAuthState(namespace, 'single-use', 'vvetrov41@gmail.com')).alias,
    'vladimir',
  );
  await assert.rejects(
    consumeOAuthState(namespace, 'single-use', 'vvetrov41@gmail.com'),
    (error) => error instanceof OAuthSecurityError && error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('OAuth state cannot be completed by a different verified actor', async () => {
  const record = buildOAuthStateRecord('kristina', 'k'.repeat(64), 'tinaakaten@gmail.com');
  const namespace = {
    get: async () => record,
    delete: async () => {},
  };
  await assert.rejects(
    consumeOAuthState(namespace, 'state', 'vvetrov41@gmail.com'),
    (error) => error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('token exchange requires both access and refresh tokens', () => {
  assert.equal(validateTokenExchange(true, { access_token: 'a', refresh_token: 'r' }).refresh_token, 'r');
  assert.throws(
    () => validateTokenExchange(true, { access_token: 'a' }),
    (error) => error.code === 'google_token_exchange_failed' && error.status === 502,
  );
});

await test('Google account validation is exact and requires verified email', () => {
  assert.equal(
    validateGoogleAccount(true, { email: 'Vvetrov41@gmail.com', email_verified: true }, 'vvetrov41@gmail.com'),
    'vvetrov41@gmail.com',
  );
  assert.throws(
    () => validateGoogleAccount(true, { email: 'vvetrov41@gmail.com', email_verified: false }, 'vvetrov41@gmail.com'),
    (error) => error.code === 'google_account_mismatch',
  );
});

await test('readiness reports booleans only and keeps the drain disabled', () => {
  const status = calendarReadiness(env);
  assert.equal(status.bindings.oauthState, true);
  assert.equal(status.configuration.googleOauth, true);
  assert.equal(status.configuration.supabase, true);
  assert.equal(status.configuration.artists, true);
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
    calendarReadiness({ ...env, CALENDAR_ACCESS_AUD: '' }).configuration.ownerAccess,
    false,
  );
});

await test('disconnect confirmation is explicit, tokenized and escapes all URLs', () => {
  const token = 'd'.repeat(64);
  const page = disconnectConfirmationPage(
    'vladimir',
    'https://calendar-staging.vishartattoo.com/oauth/google/disconnect/vladimir?x="bad"',
    'https://vishar-crm-staging.pages.dev/?a=<bad>#/appointments',
    token,
  );
  assert.match(page, /name="confirm" value="disconnect"/);
  assert.match(page, new RegExp(`name="disconnect_token" value="${token}"`));
  assert.ok(!page.includes('<bad>'));
  assert.ok(!page.includes('x="bad"'));
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
  const store = new Map();
  const namespace = {
    get: async (key) => store.has(key) ? JSON.parse(store.get(key)) : null,
    delete: async (key) => { store.delete(key); },
  };
  store.set(
    `disconnect:${token}`,
    JSON.stringify(buildDisconnectStateRecord('kristina', 'tinaakaten@gmail.com')),
  );
  assert.equal(
    (await consumeDisconnectState(namespace, 'kristina', token, 'tinaakaten@gmail.com')).alias,
    'kristina',
  );
  await assert.rejects(
    consumeDisconnectState(namespace, 'kristina', token, 'tinaakaten@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );

  store.set(
    `disconnect:${token}`,
    JSON.stringify(buildDisconnectStateRecord('kristina', 'tinaakaten@gmail.com')),
  );
  await assert.rejects(
    consumeDisconnectState(namespace, 'vladimir', token, 'tinaakaten@gmail.com'),
    (error) => error.code === 'disconnect_confirmation_invalid_or_expired',
  );
});

await test('OAuth denial consumes its state before returning a safe error', async () => {
  const state = 'denied-state';
  const store = new Map([[
    `state:${state}`,
    JSON.stringify(buildOAuthStateRecord('vladimir', 'v'.repeat(64), 'vvetrov41@gmail.com')),
  ]]);
  const callbackEnv = {
    ...env,
    CALENDAR_OAUTH_STATE: {
      get: async (key) => store.has(key) ? JSON.parse(store.get(key)) : null,
      delete: async (key) => { store.delete(key); },
    },
  };
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
