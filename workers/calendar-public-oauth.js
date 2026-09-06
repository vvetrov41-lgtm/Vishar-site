import calendarWorker, { __testing as calendar } from './calendar-oauth.js';
import {
  OAuthSecurityError,
  assertOAuthCallbackConfiguration,
  assertOAuthStartConfiguration,
  buildOAuthStateRecord,
  consumeOAuthState,
  validateGoogleAccount,
  validateTokenExchange,
} from './lib/calendar-oauth-security.js';
import { encryptTokenRecord, revokeGoogleRefreshToken } from './lib/google-calendar.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_TTL_SECONDS = 600;
const OAUTH_SCOPE = calendar.OAUTH_SCOPE;
const START_PATTERN = /^\/oauth\/google\/start\/([^/]+)$/;

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', ...headers },
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

function crmOrigin(env) {
  try {
    const parsed = new URL(env.CRM_RETURN_URL || '');
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.vishartattoo.com')
      ? parsed.origin
      : '';
  } catch {
    return '';
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = crmOrigin(env);
  if (!allowed || origin !== allowed) return null;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function verifiedSupabaseActorEmail(request, env, fetchImpl = fetch) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new OAuthSecurityError('calendar_session_required', 401);
  }
  const backend = calendar.supabaseBackend(env);
  const response = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: authorization,
      apikey: backend.apikey,
      Accept: 'application/json',
    },
  });
  const user = await response.json().catch(() => null);
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!response.ok || !email || !email.includes('@')) {
    throw new OAuthSecurityError('calendar_session_required', 401);
  }
  return email;
}

async function publicStart(request, artistRef, env, fetchImpl = fetch) {
  const cors = corsHeaders(request, env);
  if (!cors) return json({ ok: false, code: 'calendar_origin_denied' }, 403);
  assertOAuthStartConfiguration(env);
  const actorEmail = await verifiedSupabaseActorEmail(request, env, fetchImpl);
  const config = await calendar.resolveArtistRoute(artistRef, actorEmail, env, fetchImpl);
  await calendar.authorizeCalendarActor(config, actorEmail, env, fetchImpl);

  const state = randomToken();
  const verifier = randomToken(64);
  const challenge = await sha256Base64Url(verifier);
  const stateRecord = buildOAuthStateRecord(config.artistId, config.alias, verifier, actorEmail);
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
  return json({ ok: true, authorize_url: `${GOOGLE_AUTH_URL}?${params}` }, 200, cors);
}

async function publicCallback(request, env, fetchImpl = fetch) {
  assertOAuthCallbackConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (!state) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const raw = await env.CALENDAR_OAUTH_STATE.get(`state:${state}`, 'json');
  const actorEmail = typeof raw?.ownerEmail === 'string' ? raw.ownerEmail.trim().toLowerCase() : '';
  if (!actorEmail) throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  const stored = await consumeOAuthState(env.CALENDAR_OAUTH_STATE, state, actorEmail);
  if (oauthError) return json({ ok: false, code: 'google_authorisation_denied' }, 400);
  if (!code) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const config = await calendar.resolveArtistRoute(stored.artistId, actorEmail, env, fetchImpl);
  if (config.artistId !== stored.artistId || config.alias !== stored.alias) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  await calendar.authorizeCalendarActor(config, actorEmail, env, fetchImpl);

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

  let eventLabelId = null;
  try {
    eventLabelId = await calendar.resolveGoogleEventLabel(tokens.access_token, config, fetchImpl);
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
      eventLabelId,
    }, env.CALENDAR_TOKEN_ENCRYPTION_KEY),
  );
  try {
    await calendar.updateIntegrationMetadata(config, accountEmail, true, env, fetchImpl);
  } catch (error) {
    await env.CALENDAR_OAUTH_TOKENS.delete(tokenKey);
    await revokeGoogleRefreshToken(tokens.refresh_token, fetchImpl).catch(() => false);
    throw error;
  }

  const destination = new URL(env.CRM_RETURN_URL || 'https://crm.vishartattoo.com/#/appointments');
  destination.searchParams.set('calendar', 'connected');
  destination.searchParams.set('artist', stored.alias);
  return Response.redirect(destination.toString(), 302);
}

function errorResponse(error) {
  if (error instanceof OAuthSecurityError) {
    return json({ ok: false, code: error.code }, error.status);
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const start = url.pathname.match(START_PATTERN);
      if (start) {
        if (request.method === 'OPTIONS') {
          const cors = corsHeaders(request, env);
          return cors ? new Response(null, { status: 204, headers: cors }) : json({ ok: false, code: 'calendar_origin_denied' }, 403);
        }
        if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
        const limited = await calendar.enforceRateLimit(request, url, env);
        if (limited) return limited;
        return await publicStart(request, decodeURIComponent(start[1]), env);
      }
      if (url.pathname === '/oauth/google/callback') {
        if (request.method !== 'GET') return json({ ok: false, code: 'method_not_allowed' }, 405);
        const limited = await calendar.enforceRateLimit(request, url, env);
        if (limited) return limited;
        return await publicCallback(request, env);
      }
      return calendarWorker.fetch(request, env, ctx);
    } catch (error) {
      const safe = errorResponse(error);
      if (safe) return safe;
      console.error('calendar public oauth worker failure', JSON.stringify({
        code: typeof error?.code === 'string' ? error.code : 'calendar_connector_error',
      }));
      return json({ ok: false, code: 'calendar_connector_error' }, 500);
    }
  },
  scheduled(controller, env, ctx) {
    return calendarWorker.scheduled(controller, env, ctx);
  },
};

export const __testing = {
  crmOrigin,
  corsHeaders,
  verifiedSupabaseActorEmail,
  publicStart,
  publicCallback,
};
