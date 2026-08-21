// Vishar CRM Instagram connector.
//
// One Worker owns the whole Instagram provider surface:
//
//   POST /v1/connections/start       operator-initiated OAuth, returns a URL
//   GET  /oauth/instagram/callback   Meta redirect, binds the account
//   GET  /v1/connections/status      non-secret connection state for the CRM
//   POST /v1/connections/disconnect  operator disconnect, destroys the token
//   GET  /webhook                    Meta verification challenge
//   POST /webhook                    signed Meta notifications
//   scheduled                        token renewal, outbound drain, enrichment
//
// Why a dedicated Worker rather than extending the live WhatsApp webhook
// Worker (see docs/crm/adr/0007):
//
//   * `vishar-whatsapp-webhook-production` is already serving Meta callbacks
//     for a production account. Adding an OAuth surface, two KV namespaces and
//     a token encryption key to it would force a redeploy of a live public
//     Meta callback for a feature it does not need.
//
//   * Instagram Login issues refreshable long-lived *user* tokens. Keeping
//     that store isolated from WhatsApp's static per-artist envelopes limits
//     what a single Worker compromise yields.
//
//   * The channel-neutral half of the engine already lives in Postgres, so a
//     second Worker is a second adapter, not a second engine.
//
// Nothing here logs a token, a participant identifier or message content.

import {
  INSTAGRAM_SCOPES,
  REFRESH_WHEN_REMAINING_SECONDS,
  authorizationUrl,
  deleteToken,
  exchangeAuthorizationCode,
  exchangeLongLivedToken,
  getConnectedAccount,
  getParticipantProfile,
  loadToken,
  refreshLongLivedToken,
  sendInstagramMessage,
  storeToken,
} from './lib/instagram.js';
import {
  createInstagramSupabase,
  isSupabasePublishableKey,
  isSupabaseSecretKey,
} from './lib/instagram-supabase.js';
import {
  INSTAGRAM_WEBHOOK_PATH,
  handleInstagramWebhook,
} from './lib/instagram-webhook.js';
import { drainCommunicationOutbox, randomWorkerId } from './lib/communications-drain.js';

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const INSTAGRAM_PUBLIC_HOST = 'instagram.vishartattoo.com';
const REDIRECT_URI = 'https://instagram.vishartattoo.com/oauth/instagram/callback';
const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const STATE_PREFIX = 'instagram:state:';
const STATE_TTL_SECONDS = 600;
const MAX_BODY_BYTES = 4 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const INSTAGRAM_USER_ID = /^[0-9]{5,40}$/;

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});
const HTML_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
});

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function html(status, title, message) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escape(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.55}`
    + `h1{font-size:1.6rem}a{color:inherit}</style></head><body>`
    + `<h1>${escape(title)}</h1><p>${escape(message)}</p>`
    + `<p><a href="${CRM_ORIGIN}/#/integrations/instagram">Return to Vishar CRM</a></p>`
    + `</body></html>`;
  return new Response(body, { status, headers: HTML_HEADERS });
}

/**
 * The Worker refuses to do anything until its whole production configuration
 * is present and correct. A partially configured connector is a connector that
 * fails in the middle of an OAuth exchange.
 */
export function configured(env) {
  return Boolean(
    env?.VISHAR_ENVIRONMENT === 'production'
    && env?.SUPABASE_URL === PRODUCTION_SUPABASE_ORIGIN
    && typeof env?.INSTAGRAM_APP_ID === 'string'
    && /^[0-9]{5,40}$/.test(env.INSTAGRAM_APP_ID)
    && typeof env?.INSTAGRAM_APP_SECRET === 'string' && env.INSTAGRAM_APP_SECRET.length >= 16
    && typeof env?.INSTAGRAM_TOKEN_ENCRYPTION_KEY === 'string'
    && env.INSTAGRAM_TOKEN_ENCRYPTION_KEY.length >= 43
    && typeof env?.INSTAGRAM_WEBHOOK_VERIFY_TOKEN === 'string'
    && env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN.length >= 16
    && isSupabaseSecretKey(env?.SUPABASE_SECRET_KEY)
    && isSupabasePublishableKey(env?.SUPABASE_PUBLISHABLE_KEY)
    && env?.INSTAGRAM_OAUTH_STATE
    && env?.INSTAGRAM_OAUTH_TOKENS,
  );
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(request.headers.get('authorization') || '');
  return match?.[1] || null;
}

function randomB64url(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stateKey(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    throw new Error('instagram_oauth_state_invalid');
  }
  return `${STATE_PREFIX}${state}`;
}

async function readJsonBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  const parsed = JSON.parse(text || '{}');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_json');
  return parsed;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Proves the caller may manage this artist's integrations without trusting a
 * profile id from the browser.
 *
 * First Supabase Auth verifies the CRM bearer and returns the authoritative
 * user/profile id. Only then does the backend-only RPC evaluate that profile's
 * active role and artist membership. The selector still comes back from the
 * database, derived from the artist slug.
 */
async function authorizeConnection(db, token, artistId) {
  const actor = await db.verifyUser(token);
  const row = firstRow(await db.rpc('service_authorize_instagram_connection', {
    p_profile_id: actor.id,
    p_artist_id: artistId,
  }));
  if (
    !row
    || row.artist_id !== artistId
    || typeof row.integration_key !== 'string'
    || !INTEGRATION_KEY.test(row.integration_key)
  ) {
    const error = new Error('instagram_connection_scope_invalid');
    error.code = 'instagram_authorization_unavailable';
    throw error;
  }
  return row;
}

function authorizationFailure(error) {
  if (error?.code === 'instagram_session_invalid') {
    return json(401, { error: 'session_required' });
  }
  if (error?.code === 'instagram_permission_denied' || error?.pgcode === '42501') {
    return json(403, { error: 'not_permitted' });
  }

  // These codes are deliberately narrow, stable operational categories. They
  // reveal neither a CRM session nor a database response, but let the CRM and
  // Worker logs distinguish Auth verification from the backend-only scope RPC.
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  const pgcode = typeof error?.pgcode === 'string' ? error.pgcode : null;
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status
    : null;
  console.warn(JSON.stringify({
    event: 'instagram_connection_authorization_failed',
    code,
    pgcode,
    status,
  }));
  if (
    code === 'instagram_supabase_url_invalid'
    || code === 'instagram_supabase_secret_unavailable'
    || code === 'instagram_supabase_publishable_unavailable'
  ) {
    return json(503, { error: 'session_verification_unavailable' });
  }
  if (code === 'instagram_session_verification_request_failed') {
    return json(503, { error: 'session_verification_request_failed' });
  }
  if (code === 'instagram_session_verification_upstream_failed') {
    return json(503, { error: 'session_verification_upstream_failed' });
  }
  if (code === 'instagram_session_verification_response_invalid') {
    return json(503, { error: 'session_verification_response_invalid' });
  }
  if (code === 'instagram_rpc_unavailable' || code === 'instagram_rpc_failed') {
    return json(503, { error: 'authorization_backend_unavailable' });
  }
  return json(503, { error: 'authorization_unavailable' });
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async function startConnection(request, url, env, db) {
  if (url.hostname !== INSTAGRAM_PUBLIC_HOST) return null;
  if (url.pathname.replace(/\/+$/, '') !== '/v1/connections/start') return null;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (env?.INSTAGRAM_OAUTH_ENABLED !== 'true') return json(404, { error: 'not_found' });

  const token = bearer(request);
  if (!token) return json(401, { error: 'session_required' });

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return json(400, { error: 'invalid_request' });
  }
  const artistId = typeof body.artist_id === 'string' && UUID.test(body.artist_id)
    ? body.artist_id
    : null;
  if (!artistId) return json(400, { error: 'invalid_artist_id' });

  let authorised;
  try {
    authorised = await authorizeConnection(db, token, artistId);
  } catch (error) {
    return authorizationFailure(error);
  }

  const state = randomB64url(32);
  // The state is the whole CSRF and binding story for Instagram Business
  // Login, which does not document PKCE. It is single use, short lived, and
  // carries the artist and the operator who started the flow so the callback
  // cannot be replayed into a different artist's connection.
  await env.INSTAGRAM_OAUTH_STATE.put(stateKey(state), JSON.stringify({
    v: 1,
    artist_id: authorised.artist_id,
    artist_slug: authorised.artist_slug,
    integration_key: authorised.integration_key,
    created_at: Date.now(),
  }), { expirationTtl: STATE_TTL_SECONDS });

  return json(200, {
    authorize_url: authorizationUrl({
      clientId: env.INSTAGRAM_APP_ID,
      redirectUri: REDIRECT_URI,
      state,
    }),
    scopes: INSTAGRAM_SCOPES,
    expires_in: STATE_TTL_SECONDS,
  });
}

/**
 * Optional hard pin for an artist's Instagram account.
 *
 * Before the first connection the account id is unknown, so it cannot be a
 * required variable. Once the owner knows it, setting
 * `INSTAGRAM_ACCOUNT_<SLUG>` makes any other account fail the callback, which
 * is the strongest available guard against connecting the wrong profile.
 */
function pinnedAccountFor(env, slug) {
  const raw = env?.[`INSTAGRAM_ACCOUNT_${String(slug).toUpperCase().replace(/-/g, '_')}`];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return INSTAGRAM_USER_ID.test(value) ? value : null;
}

async function oauthCallback(request, url, env, db, fetchImpl) {
  if (url.hostname !== INSTAGRAM_PUBLIC_HOST) return null;
  if (url.pathname.replace(/\/+$/, '') !== '/oauth/instagram/callback') return null;
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  }
  if (env?.INSTAGRAM_OAUTH_ENABLED !== 'true') {
    return html(404, 'Instagram connection unavailable', 'The Instagram connector is disabled.');
  }

  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.get('error')) {
    return html(400, 'Instagram connection cancelled',
      'Instagram did not grant access. Nothing was connected. You can start again from the CRM.');
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !code || code.length > 4096) {
    return html(400, 'Instagram connection failed',
      'The Instagram callback was invalid. Start the connection again from the CRM.');
  }

  // Single use: the state is consumed before the code is spent, so a replayed
  // callback cannot bind a second time.
  const key = stateKey(state);
  const raw = await env.INSTAGRAM_OAUTH_STATE.get(key);
  await env.INSTAGRAM_OAUTH_STATE.delete(key);
  if (!raw) {
    return html(400, 'Instagram connection failed',
      'The connection request expired or was already used. Start it again from the CRM.');
  }

  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    pending = null;
  }
  if (
    !pending
    || pending.v !== 1
    || !UUID.test(pending.artist_id ?? '')
    || !INTEGRATION_KEY.test(pending.integration_key ?? '')
    || !Number.isFinite(pending.created_at)
    || Date.now() - pending.created_at > STATE_TTL_SECONDS * 1000
  ) {
    return html(400, 'Instagram connection failed', 'The artist binding was invalid.');
  }

  try {
    const exchanged = await exchangeAuthorizationCode({
      clientId: env.INSTAGRAM_APP_ID,
      clientSecret: env.INSTAGRAM_APP_SECRET,
      redirectUri: REDIRECT_URI,
      code,
      fetchImpl,
    });

    if (!exchanged.permissions.includes('instagram_business_manage_messages')) {
      return html(403, 'Instagram permission missing',
        'Instagram did not grant permission to manage messages, so no connection was enabled. '
        + 'Start again and allow message access.');
    }

    const longLived = await exchangeLongLivedToken({
      clientSecret: env.INSTAGRAM_APP_SECRET,
      accessToken: exchanged.accessToken,
      fetchImpl,
    });

    // The code exchange returns an Instagram App-scoped User ID. It is a
    // different namespace from the professional account ID returned by `/me`,
    // so comparing the two rejects valid Business Login grants. Re-read the
    // account with the issued token and use that token-bound professional ID
    // as the canonical database, KV and webhook-routing identity.
    const account = await getConnectedAccount(longLived.accessToken, fetchImpl);

    const pinned = pinnedAccountFor(env, pending.artist_slug);
    if (pinned && pinned !== account.instagramUserId) {
      return html(403, 'Wrong Instagram account',
        'This connector is pinned to a different Instagram professional account for this artist. '
        + 'Sign in with the expected account.');
    }

    const expiresAt = Date.now() + longLived.expiresIn * 1000;
    await storeToken(env, {
      artist_id: pending.artist_id,
      integration_key: pending.integration_key,
      instagram_user_id: account.instagramUserId,
      access_token: longLived.accessToken,
      expires_at: expiresAt,
    });

    try {
      await db.rpc('service_set_instagram_integration', {
        p_artist_id: pending.artist_id,
        p_integration_key: pending.integration_key,
        p_instagram_user_id: account.instagramUserId,
        p_username: account.username,
        p_scopes: exchanged.permissions,
      });
    } catch (error) {
      // The database refused the binding, so the token must not survive it.
      await deleteToken(env, pending.artist_id);
      throw error;
    }

    return html(200, 'Instagram connected',
      `The Instagram professional account @${account.username} is now connected to this artist. `
      + 'Messages will appear in the CRM inbox.');
  } catch (error) {
    const code = safeFailureCode(error);
    console.warn(JSON.stringify({
      event: 'instagram_oauth_callback_failed',
      code,
    }));
    return html(400, 'Instagram connection failed',
      'The Instagram exchange or account verification failed. No connection was enabled. '
      + `Error reference: ${code}.`);
  }
}

async function connectionStatus(request, url, env, db) {
  if (url.hostname !== INSTAGRAM_PUBLIC_HOST) return null;
  if (url.pathname.replace(/\/+$/, '') !== '/v1/connections/status') return null;
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  }

  const token = bearer(request);
  if (!token) return json(401, { error: 'session_required' });
  const artistId = url.searchParams.get('artist_id') || '';
  if (!UUID.test(artistId)) return json(400, { error: 'invalid_artist_id' });

  let authorised;
  try {
    authorised = await authorizeConnection(db, token, artistId);
  } catch (error) {
    return authorizationFailure(error);
  }

  // Token lifetime lives only in the connector's own store, so the CRM cannot
  // learn it any other way. The token itself never crosses this boundary.
  let expiresAt = null;
  let hasToken = false;
  try {
    const stored = await loadToken(env, artistId);
    hasToken = stored.instagram_user_id === authorised.instagram_user_id;
    expiresAt = new Date(stored.expires_at).toISOString();
  } catch {
    hasToken = false;
  }

  return json(200, {
    artist_id: artistId,
    integration_key: authorised.integration_key,
    is_enabled: Boolean(authorised.is_enabled),
    username: null,
    connected: Boolean(authorised.is_enabled) && hasToken,
    token_expires_at: expiresAt,
    needs_reconnect: Boolean(authorised.is_enabled) && !hasToken,
  });
}

async function disconnect(request, url, env, db) {
  if (url.hostname !== INSTAGRAM_PUBLIC_HOST) return null;
  if (url.pathname.replace(/\/+$/, '') !== '/v1/connections/disconnect') return null;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  const token = bearer(request);
  if (!token) return json(401, { error: 'session_required' });

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return json(400, { error: 'invalid_request' });
  }
  const artistId = typeof body.artist_id === 'string' && UUID.test(body.artist_id)
    ? body.artist_id
    : null;
  if (!artistId) return json(400, { error: 'invalid_artist_id' });

  let authorised;
  try {
    authorised = await authorizeConnection(db, token, artistId);
  } catch (error) {
    return authorizationFailure(error);
  }

  await db.rpc('service_disable_instagram_integration', {
    p_artist_id: artistId,
    p_integration_key: authorised.integration_key,
    p_error_code: 'operator_disconnect',
  });
  // The database row is disabled first so that nothing can route to the
  // account while the token still exists.
  await deleteToken(env, artistId);

  return json(200, { artist_id: artistId, connected: false });
}

// ---------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------

/**
 * Returns a usable access token for an artist, renewing it when it is close to
 * expiry. Meta refuses a refresh for a token younger than 24 hours or already
 * expired, so renewal happens a week ahead rather than at the boundary.
 */
export async function usableToken(env, db, artistId, fetchImpl = fetch) {
  const stored = await loadToken(env, artistId);
  const remaining = stored.expires_at - Date.now();
  if (remaining > REFRESH_WHEN_REMAINING_SECONDS * 1000) return stored;

  try {
    const renewed = await refreshLongLivedToken({
      accessToken: stored.access_token,
      fetchImpl,
    });
    const next = {
      ...stored,
      access_token: renewed.accessToken,
      expires_at: Date.now() + renewed.expiresIn * 1000,
    };
    await storeToken(env, next);
    return next;
  } catch (error) {
    if (error?.code === 'instagram_token_revoked') {
      // A revoked token cannot be recovered by retrying. Disabling the route
      // stops the CRM offering a reply that could never be delivered.
      await db.rpc('service_disable_instagram_integration', {
        p_artist_id: artistId,
        p_integration_key: stored.integration_key,
        p_error_code: 'instagram_token_revoked',
      });
      await deleteToken(env, artistId);
    }
    throw error;
  }
}

/**
 * Delivers one queued message.
 *
 * Everything authoritative comes from the route the database resolved. The
 * account the message is sent from must be the account the token was issued
 * for, or the CRM would be replying from a different profile than the
 * conversation belongs to.
 */
function instagramDeliver(env, db, fetchImpl) {
  return async (route, message) => {
    if (route?.provider !== 'instagram_login') {
      return { delivered: false, errorCode: 'instagram_provider_unsupported' };
    }
    const routeAccount = typeof route?.configuration?.instagram_user_id === 'string'
      ? route.configuration.instagram_user_id
      : '';
    if (!INSTAGRAM_USER_ID.test(routeAccount)) {
      return { delivered: false, errorCode: 'instagram_account_invalid' };
    }

    let token;
    try {
      token = await usableToken(env, db, route.artist_id, fetchImpl);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'instagram_token_missing';
      return { delivered: false, errorCode: code };
    }
    if (token.instagram_user_id !== routeAccount) {
      return { delivered: false, errorCode: 'instagram_token_binding_mismatch' };
    }

    return sendInstagramMessage({
      accessToken: token.access_token,
      instagramUserId: routeAccount,
      recipientId: message.recipientId,
      body: message.body,
      fetchImpl,
    });
  };
}

export async function runInstagramDrain(env, fetchImpl = fetch) {
  const db = createInstagramSupabase(env, fetchImpl);
  return drainCommunicationOutbox({
    supabase: db,
    channel: 'instagram',
    deliver: instagramDeliver(env, db, fetchImpl),
    workerId: randomWorkerId('instagram-worker'),
  });
}

/**
 * Fills in participant handles learned outside the webhook path.
 *
 * Doing this during ingestion would put a slow, failure-prone Graph call in
 * front of message persistence, which is the one thing the webhook must never
 * risk.
 */
export async function enrichInstagramParticipants(env, fetchImpl = fetch, limit = 10) {
  const db = createInstagramSupabase(env, fetchImpl);
  const pending = await db.rpc('service_list_unenriched_participants', {
    p_channel: 'instagram',
    p_limit: limit,
  });
  const rows = Array.isArray(pending) ? pending : [];
  let enriched = 0;

  for (const row of rows) {
    try {
      const token = await usableToken(env, db, row.artist_id, fetchImpl);
      const profile = await getParticipantProfile(row.external_contact_id, token.access_token, fetchImpl);
      if (!profile.username && !profile.name) continue;
      await db.rpc('service_update_communication_participant', {
        p_artist_id: row.artist_id,
        p_channel: 'instagram',
        p_external_contact_id: row.external_contact_id,
        p_username: profile.username,
        p_display_label: profile.name,
      });
      enriched += 1;
    } catch {
      // Enrichment is cosmetic. A participant whose profile cannot be read
      // stays addressable by id and is retried on a later tick.
    }
  }

  return { considered: rows.length, enriched };
}

function safeFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'instagram_connector_error';
}

async function runScheduled(env) {
  if (env?.INSTAGRAM_DRAIN_ENABLED === 'true') {
    try {
      const result = await runInstagramDrain(env);
      console.log('instagram outbox drain', JSON.stringify({
        claimed: result.claimed,
        succeeded: result.succeeded,
        failed: result.failed,
        unrecorded: result.unrecorded,
      }));
    } catch (error) {
      console.error('instagram outbox drain failed', JSON.stringify({
        code: safeFailureCode(error),
      }));
    }
  }

  if (env?.INSTAGRAM_ENRICHMENT_ENABLED === 'true') {
    try {
      const result = await enrichInstagramParticipants(env);
      console.log('instagram participant enrichment', JSON.stringify(result));
    } catch (error) {
      console.error('instagram participant enrichment failed', JSON.stringify({
        code: safeFailureCode(error),
      }));
    }
  }
}

async function enforceRateLimit(request, env, route) {
  const limiter = env?.INSTAGRAM_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await limiter.limit({ key: `${route}:${address}` });
  return result.success ? null : json(429, { error: 'rate_limited' });
}

export default {
  async fetch(request, env) {
    if (!configured(env)) return json(404, { error: 'not_found' });
    const url = new URL(request.url);

    // The Meta callback must not sit behind the same rate limiter as the
    // operator surface: Meta bursts, and a dropped notification is a lost
    // message.
    if (url.pathname === INSTAGRAM_WEBHOOK_PATH) {
      if (request.method === 'GET') return handleInstagramWebhook(request, env, null);
      let db;
      try {
        db = createInstagramSupabase(env);
      } catch {
        return json(503, { ok: false });
      }
      return handleInstagramWebhook(request, env, db);
    }

    const limited = await enforceRateLimit(
      request,
      env,
      url.pathname.startsWith('/oauth/') ? 'oauth' : 'connection',
    );
    if (limited) return limited;

    let db;
    try {
      db = createInstagramSupabase(env);
    } catch {
      return json(503, { error: 'unavailable' });
    }

    const start = await startConnection(request, url, env, db);
    if (start) return start;
    const callback = await oauthCallback(request, url, env, db, fetch);
    if (callback) return callback;
    const status = await connectionStatus(request, url, env, db);
    if (status) return status;
    const disconnected = await disconnect(request, url, env, db);
    if (disconnected) return disconnected;

    return json(404, { error: 'not_found' });
  },

  async scheduled(_controller, env, ctx) {
    if (!configured(env)) return;
    ctx.waitUntil(runScheduled(env));
  },
};

export const __testing = Object.freeze({
  configured,
  bearer,
  stateKey,
  pinnedAccountFor,
  authorizeConnection,
  startConnection,
  oauthCallback,
  connectionStatus,
  disconnect,
  instagramDeliver,
  runScheduled,
  safeFailureCode,
  REDIRECT_URI,
  INSTAGRAM_PUBLIC_HOST,
});
