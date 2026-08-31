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
  buildDisconnectStateRecord,
  buildOAuthStateRecord,
  calendarReadiness,
  canManageCalendarAlias,
  consumeDisconnectState,
  consumeOAuthState,
  disconnectConfirmationPage,
  disconnectConfirmationToken,
  disconnectReturnUrl,
  validateGoogleAccount,
  validateTokenExchange,
  verifiedCalendarActorEmail,
} from './lib/calendar-oauth-security.js';

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
const DISCONNECT_TTL_SECONDS = 600;

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

function rateLimitRouteClass(pathname) {
  if (pathname === '/health') return 'health';
  if (/^\/oauth\/google\/start\/(vladimir|kristina)$/.test(pathname)) return 'oauth_start';
  if (pathname === '/oauth/google/callback') return 'oauth_callback';
  if (/^\/oauth\/google\/disconnect\/(vladimir|kristina)$/.test(pathname)) return 'oauth_disconnect';
  return 'other';
}

async function rateLimitActor(request) {
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

function artistConfig(alias, env) {
  const configs = {
    vladimir: {
      artistId: env.VLADIMIR_ARTIST_ID,
      expectedEmail: env.VLADIMIR_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_vladimir',
      eventLabelName: env.VLADIMIR_GOOGLE_EVENT_LABEL_NAME || '',
      eventLabelColor: env.VLADIMIR_GOOGLE_EVENT_LABEL_COLOR || '',
    },
    kristina: {
      artistId: env.KRISTINA_ARTIST_ID,
      expectedEmail: env.KRISTINA_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_kristina',
      eventLabelName: env.KRISTINA_GOOGLE_EVENT_LABEL_NAME || '',
      eventLabelColor: env.KRISTINA_GOOGLE_EVENT_LABEL_COLOR || '',
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

function assertCalendarActorRoute(actorEmail, alias, env) {
  if (!canManageCalendarAlias(actorEmail, alias, env)) {
    throw new OAuthSecurityError('calendar_artist_access_denied', 403);
  }
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

async function startOAuth(request, alias, env, fetchImpl = fetch) {
  const actorEmail = await verifiedCalendarActorEmail(request, env, fetchImpl);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);
  assertCalendarActorRoute(actorEmail, alias, env);
  assertOAuthStartConfiguration(env);
  await authorizeCalendarActor(config, actorEmail, env, fetchImpl);

  const state = randomToken();
  const verifier = randomToken(64);
  const challenge = await sha256Base64Url(verifier);
  const stateRecord = buildOAuthStateRecord(alias, verifier, actorEmail);
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
  const actorEmail = await verifiedCalendarActorEmail(request, env, fetchImpl);
  assertOAuthCallbackConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (!state) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const stored = await consumeOAuthState(env.CALENDAR_OAUTH_STATE, state, actorEmail);
  if (oauthError) return json({ ok: false, code: 'google_authorisation_denied' }, 400);
  if (!code) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const config = artistConfig(stored.alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 400);
  assertCalendarActorRoute(actorEmail, stored.alias, env);
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

async function disconnect(request, alias, env, fetchImpl = fetch) {
  const actorEmail = await verifiedCalendarActorEmail(request, env, fetchImpl);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);
  assertCalendarActorRoute(actorEmail, alias, env);
  assertDisconnectConfiguration(env);
  await authorizeCalendarActor(config, actorEmail, env, fetchImpl);

  if (request.method === 'GET') {
    const disconnectToken = randomToken();
    await env.CALENDAR_OAUTH_STATE.put(
      `disconnect:${disconnectToken}`,
      JSON.stringify(buildDisconnectStateRecord(alias, actorEmail)),
      { expirationTtl: DISCONNECT_TTL_SECONDS },
    );
    const returnUrl = env.CRM_RETURN_URL
      || 'https://vishar-crm-staging.pages.dev/#/appointments';
    return html(disconnectConfirmationPage(alias, request.url, returnUrl, disconnectToken));
  }
  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
  const disconnectToken = await disconnectConfirmationToken(request);
  if (!disconnectToken) {
    return json({ ok: false, code: 'disconnect_confirmation_required' }, 400);
  }
  await consumeDisconnectState(
    env.CALENDAR_OAUTH_STATE,
    alias,
    disconnectToken,
    actorEmail,
  );

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
  await updateIntegrationMetadata(config, config.expectedEmail, false, env, fetchImpl);

  const responseUrl = new URL(request.url);
  const wantsJson = responseUrl.searchParams.get('format') === 'json'
    || (request.headers.get('Accept') || '').includes('application/json');
  if (wantsJson) return json({ ok: true, artist: alias, connected: false, revoked });
  return Response.redirect(disconnectReturnUrl(env, alias, revoked), 303);
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
  if (error instanceof OAuthSecurityError) {
    return json({ ok: false, code: error.code }, error.status);
  }
  return null;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const limited = await enforceRateLimit(request, url, env);
      if (limited) return limited;
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(calendarReadiness(env));
      }
      const startMatch = url.pathname.match(/^\/oauth\/google\/start\/(vladimir|kristina)$/);
      if (request.method === 'GET' && startMatch) return await startOAuth(request, startMatch[1], env);
      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
        return await callback(request, env);
      }
      const disconnectMatch = url.pathname.match(/^\/oauth\/google\/disconnect\/(vladimir|kristina)$/);
      if (disconnectMatch) return await disconnect(request, disconnectMatch[1], env);
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
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_METADATA_SCOPE,
  OAUTH_SCOPE,
  artistConfig,
  assertCalendarActorRoute,
  authorizeCalendarActor,
  enforceRateLimit,
  rateLimitActor,
  rateLimitRouteClass,
  supabaseBackend,
  updateIntegrationMetadata,
  normalizedLabelTarget,
  resolveGoogleEventLabel,
  startOAuth,
  callback,
  disconnect,
};