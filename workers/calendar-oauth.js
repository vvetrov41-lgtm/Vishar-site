import { drainCalendarOutbox } from './lib/calendar-drain.js';
import { drainCalendarAvailabilityOutbox } from './lib/calendar-availability-drain.js';
import {
  decryptTokenRecord,
  encryptTokenRecord,
  revokeGoogleRefreshToken,
} from './lib/google-calendar.js';
import {
  OAuthSecurityError,
  assertDisconnectConfiguration,
  assertOAuthCallbackConfiguration,
  assertOAuthStartConfiguration,
  buildOAuthStateRecord,
  calendarReadiness,
  isCalendarArtistRef,
  validateGoogleAccount,
  validateTokenExchange,
  verifiedCalendarActorEmail,
} from './lib/calendar-oauth-security.js';
import {
  CalendarCrmSessionError,
  bearerToken,
  consumeCrmOAuthState,
  verifiedCrmActorEmail,
} from './lib/calendar-crm-session.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_PRIMARY_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_CALENDAR_METADATA_SCOPE = 'https://www.googleapis.com/auth/calendar.calendars.readonly';
const OAUTH_SCOPE = `openid email ${GOOGLE_CALENDAR_EVENTS_SCOPE} ${GOOGLE_CALENDAR_METADATA_SCOPE}`;
const EVENT_LABEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const STATE_TTL_SECONDS = 600;
const CRM_ORIGIN = 'https://crm.vishartattoo.com';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
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

// The artist reference is not part of the rate-limit key: an operator who may
// manage several artists still shares one budget per route class, and an
// unknown reference cannot buy itself a fresh bucket.
const ARTIST_ROUTE_PATTERN = /^\/oauth\/google\/(start|disconnect)\/([^/]+)$/;

function rateLimitRouteClass(pathname) {
  if (pathname === '/health') return 'health';
  if (pathname === '/oauth/google/callback') return 'oauth_callback';
  const match = pathname.match(ARTIST_ROUTE_PATTERN);
  if (match) return match[1] === 'start' ? 'oauth_start' : 'oauth_disconnect';
  return 'other';
}

async function rateLimitActor(request) {
  const crmToken = bearerToken(request);
  if (crmToken) return `crm:${await sha256Base64Url(crmToken)}`;
  const assertion = request?.headers?.get('Cf-Access-Jwt-Assertion') || '';
  if (assertion) return `access:${await sha256Base64Url(assertion)}`;
  return `edge:${request?.headers?.get('CF-Connecting-IP') || 'unknown'}`;
}

async function enforceRateLimit(request, url, env) {
  const limiter = env?.CALENDAR_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const key = `${rateLimitRouteClass(url.pathname)}:${await rateLimitActor(request)}`;
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return json({ ok: false, code: 'rate_limited' }, 429);
}

function isCrmOrigin(request) {
  return request?.headers?.get('Origin') === CRM_ORIGIN;
}

function requireCrmOrigin(request) {
  if (!isCrmOrigin(request)) {
    throw new CalendarCrmSessionError('crm_origin_required', 403);
  }
}

function withCrmCors(response, request) {
  if (!isCrmOrigin(request)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', CRM_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '600');
  headers.append('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(request) {
  if (!isCrmOrigin(request)) return json({ ok: false, code: 'crm_origin_required' }, 403);
  return withCrmCors(new Response(null, { status: 204 }), request);
}

const ARTIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIST_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

// Shape check on what the backend returned. The Worker keeps no artist table of
// its own, so this is the only place that decides a resolver answer is usable.
function normalizedArtistRoute(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const artistId = typeof payload.artist_id === 'string' ? payload.artist_id.toLowerCase() : '';
  const alias = typeof payload.artist_slug === 'string' ? payload.artist_slug : '';
  const displayName = typeof payload.artist_display_name === 'string'
    ? payload.artist_display_name.trim()
    : '';
  const integrationKey = typeof payload.integration_key === 'string' ? payload.integration_key : '';
  const expectedEmail = typeof payload.expected_account_email === 'string'
    ? payload.expected_account_email.trim().toLowerCase()
    : '';
  if (
    !ARTIST_ID_PATTERN.test(artistId)
    || !ARTIST_SLUG_PATTERN.test(alias)
    || !displayName
    || displayName.length > 120
    || integrationKey !== `google_calendar_${alias}`
    || (expectedEmail && !EMAIL_PATTERN.test(expectedEmail))
  ) {
    return null;
  }
  const presentation = payload.presentation && typeof payload.presentation === 'object'
    ? payload.presentation
    : {};
  return {
    artistId,
    alias,
    displayName,
    integrationKey,
    expectedEmail,
    connected: payload.connected === true,
    eventLabelName: typeof presentation.event_label_name === 'string'
      ? presentation.event_label_name
      : '',
    eventLabelColor: typeof presentation.event_label_color === 'string'
      ? presentation.event_label_color
      : '',
  };
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

// The single authority on which artist an OAuth URL means, whether that artist
// is active and whether this authenticated CRM identity may manage integrations.
async function resolveArtistRoute(artistRef, actorEmail, env, fetchImpl = fetch) {
  if (!isCalendarArtistRef(artistRef)) {
    throw new OAuthSecurityError('calendar_artist_access_denied', 403);
  }
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/resolve_calendar_artist_route`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...supabaseBackend(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_actor_email: actorEmail,
      p_artist_ref: artistRef,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OAuthSecurityError('calendar_actor_authorization_failed', 502);
  }
  const route = normalizedArtistRoute(payload);
  if (!route) {
    throw new OAuthSecurityError('calendar_artist_access_denied', 403);
  }
  return route;
}

// Re-checked immediately before every write, so a capability revoked between
// consent and callback still blocks the token from landing.
async function authorizeCalendarActor(config, actorEmail, env, fetchImpl = fetch) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/authorize_calendar_actor`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...supabaseBackend(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_actor_email: actorEmail,
      p_artist_id: config.artistId,
    }),
  });
  const allowed = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OAuthSecurityError('calendar_actor_authorization_failed', 502);
  }
  if (allowed !== true) {
    throw new OAuthSecurityError('calendar_artist_access_denied', 403);
  }
}

async function updateIntegrationMetadata(config, accountEmail, enabled, env, fetchImpl = fetch) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/set_calendar_connection_metadata`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...supabaseBackend(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_artist_id: config.artistId,
      p_integration_key: config.integrationKey,
      p_external_account_label: accountEmail,
      p_is_enabled: enabled,
    }),
  });
  if (!response.ok) throw new OAuthSecurityError('calendar_metadata_update_failed', 502);
}

function normalizedLabelTarget(config) {
  const name = typeof config?.eventLabelName === 'string' ? config.eventLabelName.trim() : '';
  const color = typeof config?.eventLabelColor === 'string' ? config.eventLabelColor.trim().toLowerCase() : '';
  if (!name && !color) return null;
  if (!name || name.length > 50 || !EVENT_LABEL_COLOR_PATTERN.test(color)) {
    throw new OAuthSecurityError('calendar_event_label_target_invalid', 503);
  }
  return { name, color };
}

async function resolveGoogleEventLabel(accessToken, config, fetchImpl = fetch) {
  const target = normalizedLabelTarget(config);
  if (!target) return null;
  if (!accessToken) throw new OAuthSecurityError('calendar_label_lookup_failed', 502);

  const response = await fetchImpl(GOOGLE_PRIMARY_CALENDAR_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const calendar = await response.json().catch(() => ({}));
  if (!response.ok) throw new OAuthSecurityError('calendar_label_lookup_failed', 502);

  const labels = Array.isArray(calendar?.labelProperties?.eventLabels)
    ? calendar.labelProperties.eventLabels
    : [];
  const targetName = target.name.toLowerCase();
  const matches = labels.filter((label) => {
    const id = typeof label?.id === 'string' ? label.id.trim() : '';
    const color = typeof label?.backgroundColor === 'string'
      ? label.backgroundColor.trim().toLowerCase()
      : '';
    const name = typeof label?.name === 'string' ? label.name.trim().toLowerCase() : '';
    return EVENT_LABEL_ID_PATTERN.test(id)
      && color === target.color
      && (!name || name === targetName);
  });
  if (matches.length !== 1) {
    throw new OAuthSecurityError('calendar_event_label_missing', 409);
  }
  return matches[0].id.trim().toLowerCase();
}

async function oauthActorEmail(request, env, fetchImpl = fetch) {
  if (bearerToken(request)) return verifiedCrmActorEmail(request, env, fetchImpl);
  // Kept for direct/internal compatibility tests. Public self-service routing
  // below requires a CRM bearer token before this function is called.
  return verifiedCalendarActorEmail(request, env, fetchImpl);
}

async function startOAuth(request, artistRef, env, fetchImpl = fetch) {
  const actorEmail = await oauthActorEmail(request, env, fetchImpl);
  assertOAuthStartConfiguration(env);
  const config = await resolveArtistRoute(artistRef, actorEmail, env, fetchImpl);
  await authorizeCalendarActor(config, actorEmail, env, fetchImpl);

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
  const authorizationUrl = `${GOOGLE_AUTH_URL}?${params}`;
  if (bearerToken(request)) return json({ ok: true, authorization_url: authorizationUrl });
  return Response.redirect(authorizationUrl, 302);
}

async function callback(request, env, fetchImpl = fetch) {
  assertOAuthCallbackConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (!state) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const stored = await consumeCrmOAuthState(env.CALENDAR_OAUTH_STATE, state);
  const actorEmail = stored.actorEmail;
  if (oauthError) return json({ ok: false, code: 'google_authorisation_denied' }, 400);
  if (!code) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  // Resolve by the artist UUID the authenticated start route recorded, never by
  // callback input, and re-authorize before the code is exchanged.
  const config = await resolveArtistRoute(stored.artistId, actorEmail, env, fetchImpl);
  if (config.artistId !== stored.artistId || config.alias !== stored.alias) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  await authorizeCalendarActor(config, actorEmail, env, fetchImpl);

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
    eventLabelId = await resolveGoogleEventLabel(tokens.access_token, config, fetchImpl);
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
    await updateIntegrationMetadata(config, accountEmail, true, env, fetchImpl);
  } catch (error) {
    await env.CALENDAR_OAUTH_TOKENS.delete(tokenKey);
    await revokeGoogleRefreshToken(tokens.refresh_token, fetchImpl).catch(() => false);
    throw error;
  }

  const destination = new URL(
    env.CRM_RETURN_URL || 'https://vishar-crm-staging.pages.dev/#/appointments',
  );
  destination.searchParams.set('calendar', 'connected');
  destination.searchParams.set('artist', stored.alias);
  return Response.redirect(destination.toString(), 302);
}

async function disconnect(request, artistRef, env, fetchImpl = fetch) {
  const actorEmail = await oauthActorEmail(request, env, fetchImpl);
  assertDisconnectConfiguration(env);
  const config = await resolveArtistRoute(artistRef, actorEmail, env, fetchImpl);
  await authorizeCalendarActor(config, actorEmail, env, fetchImpl);
  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);

  const body = await request.json().catch(() => null);
  if (body?.confirm !== 'disconnect') {
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
    }
  }

  await env.CALENDAR_OAUTH_TOKENS.delete(tokenKey);
  // With no account on record there is no metadata row to disable, and the
  // upsert would reject the empty label. Clearing the envelope is the whole
  // disconnect in that case.
  if (config.expectedEmail) {
    await updateIntegrationMetadata(config, config.expectedEmail, false, env, fetchImpl);
  }

  return json({ ok: true, artist: config.alias, connected: false, revoked });
}

async function runScheduledDrain(env) {
  const appointments = await drainCalendarOutbox(env);
  const availability = await drainCalendarAvailabilityOutbox(env);
  console.log('calendar outbox drain', JSON.stringify({
    appointments: {
      claimed: appointments.claimed,
      succeeded: appointments.succeeded,
      obsolete: appointments.obsolete,
      failed: appointments.failed,
      unrecorded: appointments.unrecorded,
    },
    availability: {
      claimed: availability.claimed,
      succeeded: availability.succeeded,
      obsolete: availability.obsolete,
      failed: availability.failed,
      unrecorded: availability.unrecorded,
    },
  }));
}

function errorResponse(error) {
  if (error instanceof OAuthSecurityError || error instanceof CalendarCrmSessionError) {
    return json({ ok: false, code: error.code }, error.status);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const artistRoute = url.pathname.match(ARTIST_ROUTE_PATTERN);
    const isSelfService = url.pathname === '/oauth/google/callback' || Boolean(artistRoute);
    try {
      const limited = await enforceRateLimit(request, url, env);
      if (limited) return isSelfService ? withCrmCors(limited, request) : limited;
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(calendarReadiness(env));
      }
      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
        return await callback(request, env);
      }
      if (artistRoute) {
        const artistRef = decodeURIComponent(artistRoute[2]);
        if (request.method === 'OPTIONS') return preflight(request);
        if (request.method !== 'POST') {
          return withCrmCors(json({ ok: false, code: 'method_not_allowed' }, 405), request);
        }
        requireCrmOrigin(request);
        if (!bearerToken(request)) throw new CalendarCrmSessionError('crm_session_required', 401);
        const response = artistRoute[1] === 'start'
          ? await startOAuth(request, artistRef, env)
          : await disconnect(request, artistRef, env);
        return withCrmCors(response, request);
      }
      return json({ ok: false, code: 'not_found' }, 404);
    } catch (error) {
      const safe = errorResponse(error);
      if (safe) return isSelfService ? withCrmCors(safe, request) : safe;
      console.error('calendar oauth worker failure', JSON.stringify({
        code: typeof error?.code === 'string' ? error.code : 'calendar_connector_error',
      }));
      const response = json({ ok: false, code: 'calendar_connector_error' }, 500);
      return isSelfService ? withCrmCors(response, request) : response;
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
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_METADATA_SCOPE,
  OAUTH_SCOPE,
  ARTIST_ROUTE_PATTERN,
  CRM_ORIGIN,
  normalizedArtistRoute,
  resolveArtistRoute,
  authorizeCalendarActor,
  enforceRateLimit,
  rateLimitActor,
  rateLimitRouteClass,
  isCrmOrigin,
  requireCrmOrigin,
  withCrmCors,
  preflight,
  supabaseBackend,
  updateIntegrationMetadata,
  normalizedLabelTarget,
  resolveGoogleEventLabel,
  oauthActorEmail,
  startOAuth,
  callback,
  disconnect,
};
