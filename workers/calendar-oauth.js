import { drainCalendarOutbox } from './lib/calendar-drain.js';
import {
  decryptTokenRecord,
  encryptTokenRecord,
  revokeGoogleRefreshToken,
} from './lib/google-calendar.js';
import {
  OAuthSecurityError,
  assertOAuthCallbackConfiguration,
  assertOAuthStartConfiguration,
  buildOAuthStateRecord,
  calendarReadiness,
  consumeOAuthState,
  disconnectConfirmationPage,
  disconnectReturnUrl,
  isConfirmedDisconnectRequest,
  requireOwnerAccess,
  validateGoogleAccount,
  validateTokenExchange,
} from './lib/calendar-oauth-security.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
const STATE_TTL_SECONDS = 600;

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});

const html = (body, status = 200) => new Response(body, {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  },
});

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function artistConfig(alias, env) {
  const configs = {
    vladimir: {
      artistId: env.VLADIMIR_ARTIST_ID,
      expectedEmail: env.VLADIMIR_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_vladimir',
    },
    kristina: {
      artistId: env.KRISTINA_ARTIST_ID,
      expectedEmail: env.KRISTINA_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_kristina',
    },
  };
  const config = configs[alias];
  if (!config?.artistId || !config?.expectedEmail) return null;
  return config;
}

function supabaseBackend(env) {
  const secretKey = String(env.SUPABASE_SECRET_KEY || '').trim();
  const legacyKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!env.SUPABASE_URL || secretKey === legacyKey || Boolean(secretKey) === Boolean(legacyKey)) {
    throw new OAuthSecurityError('calendar_not_configured', 503);
  }
  return secretKey
    ? { apikey: secretKey }
    : { apikey: legacyKey, Authorization: `Bearer ${legacyKey}` };
}

async function updateIntegrationMetadata(config, accountEmail, enabled, env, fetchImpl = fetch) {
  const url = `${env.SUPABASE_URL}/rest/v1/artist_integrations?on_conflict=artist_id,integration_type,integration_key`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...supabaseBackend(env),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      artist_id: config.artistId,
      integration_type: 'calendar',
      provider: 'google',
      integration_key: config.integrationKey,
      external_account_label: accountEmail,
      configuration: {
        calendar_id: 'primary',
        oauth_scope: 'calendar.events',
        connection_mode: 'worker_oauth',
      },
      is_enabled: enabled,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new OAuthSecurityError('calendar_metadata_update_failed', 502);
}

async function startOAuth(request, alias, env) {
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);
  assertOAuthStartConfiguration(env);

  const state = randomToken();
  const verifier = randomToken(64);
  const challenge = await sha256Base64Url(verifier);
  const stateRecord = buildOAuthStateRecord(alias, verifier, request);
  await env.CALENDAR_OAUTH_STATE.put(`state:${state}`, JSON.stringify(stateRecord), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

async function callback(request, env, fetchImpl = fetch) {
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  assertOAuthCallbackConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return json({ ok: false, code: 'google_authorisation_denied' }, 400);
  if (!state || !code) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const stored = await consumeOAuthState(env.CALENDAR_OAUTH_STATE, state, request);
  const config = artistConfig(stored.alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 400);

  const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      code_verifier: stored.verifier,
      grant_type: 'authorization_code',
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  validateTokenExchange(tokenResponse.ok, tokens);

  const userResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userResponse.json().catch(() => ({}));
  let accountEmail;
  try {
    accountEmail = validateGoogleAccount(userResponse.ok, user, config.expectedEmail);
  } catch (error) {
    await revokeGoogleRefreshToken(tokens.refresh_token, fetchImpl).catch(() => false);
    throw error;
  }

  const tokenKey = `artist:${config.artistId}`;
  await env.CALENDAR_OAUTH_TOKENS.put(
    tokenKey,
    await encryptTokenRecord({
      refreshToken: tokens.refresh_token,
      scope: tokens.scope || OAUTH_SCOPE,
      accountEmail,
      connectedAt: new Date().toISOString(),
    }, env.CALENDAR_TOKEN_ENCRYPTION_KEY),
  );

  try {
    await updateIntegrationMetadata(config, accountEmail, true, env, fetchImpl);
  } catch (error) {
    await env.CALENDAR_OAUTH_TOKENS.delete(tokenKey);
    await revokeGoogleRefreshToken(tokens.refresh_token, fetchImpl).catch(() => false);
    throw error;
  }

  const destination = new URL(env.CRM_RETURN_URL || 'https://vishar-crm-staging.pages.dev/appointments');
  destination.searchParams.set('calendar', 'connected');
  destination.searchParams.set('artist', stored.alias);
  return Response.redirect(destination.toString(), 302);
}

async function disconnect(request, alias, env, fetchImpl = fetch) {
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);

  if (request.method === 'GET') {
    return html(disconnectConfirmationPage(alias, request.url, env.CRM_RETURN_URL));
  }
  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
  if (!(await isConfirmedDisconnectRequest(request))) {
    return json({ ok: false, code: 'disconnect_confirmation_required' }, 400);
  }

  const tokenKey = `artist:${config.artistId}`;
  const rawEnvelope = await env.CALENDAR_OAUTH_TOKENS.get(tokenKey);
  let revoked = false;
  if (rawEnvelope) {
    try {
      const record = await decryptTokenRecord(rawEnvelope, env.CALENDAR_TOKEN_ENCRYPTION_KEY);
      revoked = await revokeGoogleRefreshToken(record.refreshToken, fetchImpl);
    } catch {
      // Local token deletion is authoritative for disconnect. A token that is
      // already invalid or unreadable must not keep the integration enabled.
    }
  }

  await env.CALENDAR_OAUTH_TOKENS.delete(tokenKey);
  await updateIntegrationMetadata(config, config.expectedEmail, false, env, fetchImpl);

  const url = new URL(request.url);
  const wantsJson = url.searchParams.get('format') === 'json'
    || (request.headers.get('Accept') || '').includes('application/json');
  if (wantsJson) return json({ ok: true, artist: alias, connected: false, revoked });
  return Response.redirect(disconnectReturnUrl(env, alias, revoked), 303);
}

async function runScheduledDrain(env) {
  const result = await drainCalendarOutbox(env);
  console.log('calendar outbox drain', JSON.stringify({
    claimed: result.claimed,
    succeeded: result.succeeded,
    obsolete: result.obsolete,
    failed: result.failed,
    unrecorded: result.unrecorded,
  }));
}

function errorResponse(error) {
  if (error instanceof OAuthSecurityError) {
    return json({ ok: false, code: error.code }, error.status);
  }
  return null;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(calendarReadiness(env));
      }
      const startMatch = url.pathname.match(/^\/oauth\/google\/start\/(vladimir|kristina)$/);
      if (request.method === 'GET' && startMatch) return startOAuth(request, startMatch[1], env);
      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
        return callback(request, env);
      }
      const disconnectMatch = url.pathname.match(/^\/oauth\/google\/disconnect\/(vladimir|kristina)$/);
      if (disconnectMatch) return disconnect(request, disconnectMatch[1], env);
      return json({ ok: false, code: 'not_found' }, 404);
    } catch (error) {
      const safe = errorResponse(error);
      if (safe) return safe;
      console.error('calendar oauth worker failure', JSON.stringify({
        code: typeof error?.code === 'string' ? error.code : 'calendar_connector_error',
      }));
      return json({ ok: false, code: 'calendar_connector_error' }, 500);
    }
  },

  scheduled(_controller, env, ctx) {
    if (env.CALENDAR_DRAIN_ENABLED !== 'true') {
      console.log('calendar outbox drain disabled');
      return;
    }
    ctx.waitUntil(runScheduledDrain(env));
  },
};

export const __testing = {
  artistConfig,
  supabaseBackend,
  updateIntegrationMetadata,
  startOAuth,
  callback,
  disconnect,
};
