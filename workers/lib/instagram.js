// Instagram Professional messaging adapter (Instagram API with Instagram Login).
//
// This module is the only place that knows Meta's Instagram wire format. The
// communications core above it deals in artists, conversations and normalised
// messages and never sees a token, an Instagram-scoped id or a Graph response.
//
// Contract this implements, from Meta's Instagram Platform reference:
//
//   authorize        https://www.instagram.com/oauth/authorize
//   code exchange    POST https://api.instagram.com/oauth/access_token
//   long-lived token GET  https://graph.instagram.com/access_token
//                         ?grant_type=ig_exchange_token          (60 days)
//   refresh          GET  https://graph.instagram.com/refresh_access_token
//                         ?grant_type=ig_refresh_token           (>= 24h old)
//   send             POST https://graph.instagram.com/v25.0/<IG_ID>/messages
//                         { recipient: { id }, message: { text } }
//
// Two properties differ from the WhatsApp adapter and shape everything here:
//
//   * The credential is a long-lived *user* access token that expires in 60
//     days and must be refreshed. It therefore cannot live in a static Worker
//     secret the way a WhatsApp envelope does; it lives encrypted in KV, keyed
//     by artist, exactly like the Gmail and Monzo refresh tokens.
//
//   * Meta opens a 24 hour messaging window after an inbound message. Sending
//     outside it requires the human agent tag and a different consent story,
//     so this adapter does not attempt it: the window error is surfaced to the
//     operator as an explicit, bounded state rather than worked around.
//
// The Graph API version is pinned deliberately. Meta's Instagram messaging
// reference documents v25.0; tracking the newest version automatically would
// change a production contract without review.

import { statusClass } from './logging.js';

export const INSTAGRAM_GRAPH_VERSION = 'v25.0';
const GRAPH_ORIGIN = 'https://graph.instagram.com';
const AUTHORIZE_ORIGIN = 'https://www.instagram.com';
const TOKEN_ORIGIN = 'https://api.instagram.com';

// Only what the CRM actually needs. Requesting publishing or comment scopes
// would widen App Review and the blast radius of a token for no feature here.
export const INSTAGRAM_SCOPES = Object.freeze([
  'instagram_business_basic',
  'instagram_business_manage_messages',
]);

export const LONG_LIVED_TOKEN_SECONDS = 60 * 24 * 60 * 60;
// Meta refuses a refresh for a token younger than 24 hours and after it has
// expired, so the connector renews well inside the window rather than at the
// edge of it.
export const REFRESH_WHEN_REMAINING_SECONDS = 7 * 24 * 60 * 60;

const INSTAGRAM_USER_ID = /^[0-9]{5,40}$/;
const IGSID = /^[0-9]{5,40}$/;
const USERNAME = /^[A-Za-z0-9._]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const MAX_BODY_LENGTH = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class InstagramError extends Error {
  constructor(code) {
    super('instagram request failed');
    this.name = 'InstagramError';
    this.code = code;
  }
}

function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------------------------------------------------------------------------
// Token custody
//
// The access token never leaves this Worker. It is sealed with AES-GCM under a
// dedicated encryption key and stored in KV keyed by artist, so a KV read alone
// is not enough to talk to Meta.
// ---------------------------------------------------------------------------

async function encryptionKey(secret) {
  if (typeof secret !== 'string' || secret.length < 43) {
    throw new InstagramError('instagram_encryption_key_unavailable');
  }
  const raw = b64urlDecode(secret);
  if (raw.byteLength !== 32) throw new InstagramError('instagram_encryption_key_invalid');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealToken(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}`;
}

export async function openToken(value, secret) {
  if (typeof value !== 'string' || value.length > 16384) {
    throw new InstagramError('instagram_token_envelope_invalid');
  }
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new InstagramError('instagram_token_envelope_invalid');
  }
  const iv = b64urlDecode(parts[1]);
  if (iv.byteLength !== 12) throw new InstagramError('instagram_token_envelope_invalid');

  let parsed;
  try {
    const key = await encryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(parts[2]));
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    if (error instanceof InstagramError) throw error;
    throw new InstagramError('instagram_token_envelope_invalid');
  }

  if (
    !parsed
    || parsed.v !== 1
    || !UUID.test(parsed.artist_id ?? '')
    || !INTEGRATION_KEY.test(parsed.integration_key ?? '')
    || !INSTAGRAM_USER_ID.test(parsed.instagram_user_id ?? '')
    || typeof parsed.access_token !== 'string'
    || parsed.access_token.length < 8
    || parsed.access_token.length > 8192
    || !Number.isFinite(parsed.expires_at)
  ) {
    throw new InstagramError('instagram_token_envelope_invalid');
  }
  return parsed;
}

function tokenKey(artistId) {
  if (!UUID.test(artistId ?? '')) throw new InstagramError('instagram_token_key_invalid');
  return `instagram:token:${artistId}`;
}

export async function storeToken(env, record) {
  if (!env?.INSTAGRAM_OAUTH_TOKENS || typeof env.INSTAGRAM_OAUTH_TOKENS.put !== 'function') {
    throw new InstagramError('instagram_token_store_unavailable');
  }
  const sealed = await sealToken({ ...record, v: 1 }, env.INSTAGRAM_TOKEN_ENCRYPTION_KEY);
  await env.INSTAGRAM_OAUTH_TOKENS.put(tokenKey(record.artist_id), sealed);
}

export async function loadToken(env, artistId) {
  if (!env?.INSTAGRAM_OAUTH_TOKENS || typeof env.INSTAGRAM_OAUTH_TOKENS.get !== 'function') {
    throw new InstagramError('instagram_token_store_unavailable');
  }
  const value = await env.INSTAGRAM_OAUTH_TOKENS.get(tokenKey(artistId));
  if (!value) throw new InstagramError('instagram_token_missing');
  const token = await openToken(value, env.INSTAGRAM_TOKEN_ENCRYPTION_KEY);
  if (token.artist_id !== artistId) throw new InstagramError('instagram_token_artist_mismatch');
  return token;
}

export async function deleteToken(env, artistId) {
  if (!env?.INSTAGRAM_OAUTH_TOKENS || typeof env.INSTAGRAM_OAUTH_TOKENS.delete !== 'function') return;
  await env.INSTAGRAM_OAUTH_TOKENS.delete(tokenKey(artistId));
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL('/oauth/authorize', AUTHORIZE_ORIGIN);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  // Do not let the Instagram iOS app silently reuse whichever account is
  // already active. Meta documents force_reauth for this exact case: the app
  // user must authenticate with the professional account being connected.
  url.searchParams.set('force_reauth', 'true');
  // Meta documents this list as comma separated for Instagram Business Login.
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url.toString();
}

async function readJson(response, errorCode) {
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new InstagramError(errorCode);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstagramError(errorCode);
  }
  return parsed;
}

/**
 * Instagram Business Login wraps a successful code exchange in a single-item
 * `data` array. Older examples and test tools returned the token object at the
 * top level, so accept that legacy shape too without weakening validation.
 */
function authorizationTokenRecord(parsed) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) return parsed;
  if (
    !Array.isArray(parsed.data)
    || parsed.data.length !== 1
    || !parsed.data[0]
    || typeof parsed.data[0] !== 'object'
    || Array.isArray(parsed.data[0])
  ) {
    throw new InstagramError('instagram_oauth_response_invalid');
  }
  return parsed.data[0];
}

/**
 * Exchanges the one-time authorization code for a short-lived token.
 *
 * The response also carries the app user's Instagram App-scoped User ID and
 * the permissions Meta actually granted. The app-scoped ID is not the
 * professional account ID returned by `/me` and used in webhook `entry.id`.
 */
export async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetchImpl = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });

  let response;
  try {
    response = await fetchImpl(`${TOKEN_ORIGIN}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
  } catch {
    throw new InstagramError('instagram_code_exchange_unreachable');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new InstagramError('instagram_code_exchange_redirected');
  }
  if (!response.ok) throw new InstagramError('instagram_oauth_exchange_failed');

  const parsed = await readJson(response, 'instagram_oauth_response_invalid');
  const record = authorizationTokenRecord(parsed);
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  const userId = record.user_id === undefined ? '' : String(record.user_id);
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.filter((value) => typeof value === 'string')
    : typeof record.permissions === 'string'
      ? record.permissions.split(',').map((value) => value.trim()).filter(Boolean)
      : [];

  if (!accessToken || !INSTAGRAM_USER_ID.test(userId)) {
    throw new InstagramError('instagram_oauth_response_invalid');
  }
  return { accessToken, appScopedUserId: userId, permissions };
}

/** Exchanges the short-lived token for the 60 day long-lived token. */
export async function exchangeLongLivedToken({ clientSecret, accessToken, fetchImpl = fetch }) {
  const url = new URL('/access_token', GRAPH_ORIGIN);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('access_token', accessToken);

  let response;
  try {
    response = await fetchImpl(url.toString(), { redirect: 'manual' });
  } catch {
    throw new InstagramError('instagram_long_token_exchange_unreachable');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new InstagramError('instagram_long_token_exchange_redirected');
  }
  if (!response.ok) throw new InstagramError('instagram_long_lived_exchange_failed');

  const parsed = await readJson(response, 'instagram_oauth_response_invalid');
  const token = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const expiresIn = Number(parsed.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new InstagramError('instagram_oauth_response_invalid');
  }
  return { accessToken: token, expiresIn: Math.min(expiresIn, LONG_LIVED_TOKEN_SECONDS) };
}

/** Renews a long-lived token that is at least 24 hours old and not expired. */
export async function refreshLongLivedToken({ accessToken, fetchImpl = fetch }) {
  const url = new URL('/refresh_access_token', GRAPH_ORIGIN);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);

  let response;
  try {
    response = await fetchImpl(url.toString(), { redirect: 'error' });
  } catch {
    throw new InstagramError('instagram_unreachable');
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new InstagramError('instagram_token_revoked');
  }
  if (!response.ok) throw new InstagramError('instagram_token_refresh_failed');

  const parsed = await readJson(response, 'instagram_oauth_response_invalid');
  const token = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const expiresIn = Number(parsed.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new InstagramError('instagram_oauth_response_invalid');
  }
  return { accessToken: token, expiresIn: Math.min(expiresIn, LONG_LIVED_TOKEN_SECONDS) };
}

// ---------------------------------------------------------------------------
// Graph reads
// ---------------------------------------------------------------------------

async function graphGet(path, {
  accessToken,
  fields,
  fetchImpl = fetch,
  unreachableCode = 'instagram_unreachable',
  redirectedCode = 'instagram_graph_redirected',
}) {
  const url = new URL(`/${INSTAGRAM_GRAPH_VERSION}${path}`, GRAPH_ORIGIN);
  if (fields) url.searchParams.set('fields', fields);

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    });
  } catch {
    throw new InstagramError(unreachableCode);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new InstagramError(redirectedCode);
  }
  if (response.status === 401 || response.status === 403) {
    throw new InstagramError('instagram_credentials_rejected');
  }
  if (!response.ok) throw new InstagramError('instagram_read_failed');
  return readJson(response, 'instagram_response_invalid');
}

/** The connected account itself, used to verify the binding server-side. */
export async function getConnectedAccount(accessToken, fetchImpl = fetch) {
  const parsed = await graphGet('/me', {
    accessToken,
    fields: 'user_id,username',
    fetchImpl,
    unreachableCode: 'instagram_account_verification_unreachable',
    redirectedCode: 'instagram_account_verification_redirected',
  });
  const userId = parsed.user_id === undefined ? '' : String(parsed.user_id);
  const username = typeof parsed.username === 'string' ? parsed.username : '';
  if (!INSTAGRAM_USER_ID.test(userId) || !USERNAME.test(username)) {
    throw new InstagramError('instagram_account_response_invalid');
  }
  return { instagramUserId: userId, username };
}

/**
 * The public profile of a participant, looked up outside the webhook path.
 *
 * Meta's messaging webhook carries only the participant id. Resolving the
 * handle during ingestion would put a slow, failure-prone provider call in
 * front of message persistence, so this runs afterwards instead.
 */
export async function getParticipantProfile(igsid, accessToken, fetchImpl = fetch) {
  if (!IGSID.test(igsid ?? '')) throw new InstagramError('instagram_participant_invalid');
  const parsed = await graphGet(`/${igsid}`, {
    accessToken,
    fields: 'name,username',
    fetchImpl,
  });
  const username = typeof parsed.username === 'string' && USERNAME.test(parsed.username)
    ? parsed.username
    : null;
  const name = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim().slice(0, 160)
    : null;
  return { username, name };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Maps a Meta HTTP status to a safe machine code.
 *
 * Meta reports an expired messaging window as a 400 with error subcode 2534022
 * ("This message is sent outside of allowed window"). That is a policy state,
 * not a transport failure: the CRM shows it to the operator rather than
 * retrying into a wall, so it is classified separately from a generic
 * rejection.
 */
function deliveryError(status, payload) {
  const statusGroup = statusClass(status);
  const subcode = Number(payload?.error?.error_subcode);
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';

  if (subcode === 2534022 || /outside of allowed window/i.test(message)) {
    return {
      delivered: false,
      errorCode: 'instagram_outside_messaging_window',
      statusClass: statusGroup,
    };
  }
  if (status === 401 || status === 403) {
    return { delivered: false, errorCode: 'instagram_credentials_rejected', statusClass: statusGroup };
  }
  if (status === 429) {
    return { delivered: false, errorCode: 'instagram_rate_limited', statusClass: statusGroup };
  }
  if (status >= 500) {
    return { delivered: false, errorCode: 'instagram_provider_unavailable', statusClass: statusGroup };
  }
  return { delivered: false, errorCode: 'instagram_rejected', statusClass: statusGroup };
}

/**
 * Sends one text message inside Meta's standard messaging window.
 *
 * Nothing here throws. Every failure is a short machine code that is safe to
 * log and safe to store in `integration_outbox.last_error_code`.
 */
export async function sendInstagramMessage({
  accessToken,
  instagramUserId,
  recipientId,
  body,
  fetchImpl = fetch,
}) {
  if (!INSTAGRAM_USER_ID.test(instagramUserId ?? '')) {
    return { delivered: false, errorCode: 'instagram_account_invalid' };
  }
  if (!IGSID.test(recipientId ?? '')) {
    return { delivered: false, errorCode: 'instagram_destination_invalid' };
  }
  const text = typeof body === 'string' ? body : '';
  if (!text.trim() || text.length > MAX_BODY_LENGTH) {
    return { delivered: false, errorCode: 'instagram_message_invalid' };
  }
  if (typeof accessToken !== 'string' || !accessToken) {
    return { delivered: false, errorCode: 'instagram_token_missing' };
  }

  let response;
  try {
    response = await fetchImpl(
      `${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/${instagramUserId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
        redirect: 'error',
      },
    );
  } catch {
    return { delivered: false, errorCode: 'instagram_unreachable' };
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return deliveryError(response.status, payload);
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { delivered: false, errorCode: 'instagram_response_invalid' };
  }

  const providerMessageId = typeof parsed?.message_id === 'string' ? parsed.message_id : '';
  if (!providerMessageId) {
    return { delivered: false, errorCode: 'instagram_response_invalid' };
  }

  // Only the message id crosses back. The rest of Meta's response echoes the
  // recipient id, which must not reach the acknowledgement path.
  return { delivered: true, providerMessageId };
}

export const __testing = Object.freeze({
  b64urlEncode,
  b64urlDecode,
  deliveryError,
  tokenKey,
  MAX_BODY_LENGTH,
});
