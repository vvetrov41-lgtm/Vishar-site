import assert from 'node:assert/strict';
import {
  OAuthSecurityError,
  accessEmail,
  buildOAuthStateRecord,
  calendarReadiness,
  consumeOAuthState,
  disconnectConfirmationPage,
  disconnectReturnUrl,
  isConfirmedDisconnectRequest,
  requireOwnerAccess,
  validateGoogleAccount,
  validateTokenExchange,
} from '../workers/lib/calendar-oauth-security.js';

let passes = 0;
let failures = 0;
async function test(name, run) {
  try { await run(); passes += 1; }
  catch (error) { failures += 1; console.error(`FAIL: ${name}`); console.error(error); }
}

const ownerRequest = new Request('https://calendar-staging.vishartattoo.com/', {
  headers: { 'Cf-Access-Authenticated-User-Email': ' Vvetrov41@Gmail.com ' },
});
const env = {
  VISHAR_ENVIRONMENT: 'staging',
  CALENDAR_OWNER_EMAILS: 'vvetrov41@gmail.com',
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
  CRM_RETURN_URL: 'https://vishar-crm-staging.pages.dev/integrations/calendar',
  CALENDAR_OAUTH_STATE: {},
  CALENDAR_OAUTH_TOKENS: {},
};

await test('Cloudflare Access owner email is normalized and allow-listed', () => {
  assert.equal(accessEmail(ownerRequest), 'vvetrov41@gmail.com');
  assert.equal(requireOwnerAccess(ownerRequest, env), true);
  assert.equal(requireOwnerAccess(new Request(ownerRequest.url), env), false);
});

await test('OAuth state is bound to the authenticated owner and consumed once', async () => {
  const store = new Map();
  const namespace = {
    get: async (key) => store.has(key) ? JSON.parse(store.get(key)) : null,
    delete: async (key) => { store.delete(key); },
  };
  const record = buildOAuthStateRecord('vladimir', 'v'.repeat(64), ownerRequest);
  store.set('state:single-use', JSON.stringify(record));
  assert.equal((await consumeOAuthState(namespace, 'single-use', ownerRequest)).alias, 'vladimir');
  await assert.rejects(
    consumeOAuthState(namespace, 'single-use', ownerRequest),
    (error) => error instanceof OAuthSecurityError && error.code === 'oauth_state_invalid_or_expired',
  );
});

await test('OAuth state cannot be completed under a different Access identity', async () => {
  const record = buildOAuthStateRecord('kristina', 'k'.repeat(64), ownerRequest);
  const namespace = {
    get: async () => record,
    delete: async () => {},
  };
  const other = new Request(ownerRequest.url, {
    headers: { 'Cf-Access-Authenticated-User-Email': 'other@example.com' },
  });
  await assert.rejects(
    consumeOAuthState(namespace, 'state', other),
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
  assert.equal(status.scheduledDrain, false);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('service-role'));
  assert.ok(!serialized.includes('vvetrov41@gmail.com'));
});

await test('readiness rejects ambiguous Supabase backend-key configuration', () => {
  const status = calendarReadiness({ ...env, SUPABASE_SECRET_KEY: 'sb_secret_test' });
  assert.equal(status.configuration.supabase, false);
});

await test('disconnect confirmation is explicit and escapes all URLs', () => {
  const page = disconnectConfirmationPage(
    'vladimir',
    'https://calendar-staging.vishartattoo.com/oauth/google/disconnect/vladimir?x="bad"',
    'https://vishar-crm-staging.pages.dev/integrations/calendar?a=<bad>',
  );
  assert.match(page, /name="confirm" value="disconnect"/);
  assert.ok(!page.includes('<bad>'));
  assert.ok(!page.includes('x="bad"'));
});

await test('disconnect POST requires an explicit confirmation payload', async () => {
  const confirmed = new Request('https://example.test/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'confirm=disconnect',
  });
  const missing = new Request('https://example.test/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(await isConfirmedDisconnectRequest(confirmed), true);
  assert.equal(await isConfirmedDisconnectRequest(missing), false);
});

await test('disconnect return URL contains status only and no credentials', () => {
  const url = new URL(disconnectReturnUrl(env, 'kristina', false));
  assert.equal(url.searchParams.get('calendar'), 'disconnected');
  assert.equal(url.searchParams.get('artist'), 'kristina');
  assert.equal(url.searchParams.get('revoked'), 'false');
  assert.ok(!url.toString().includes('secret'));
});

if (failures) {
  console.error(`\n${failures} OAuth hardening test(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`Calendar OAuth hardening tests passed: ${passes} cases.`);
