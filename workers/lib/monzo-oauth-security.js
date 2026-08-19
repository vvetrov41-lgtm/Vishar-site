import { OAuthSecurityError, verifiedOwnerEmail } from './calendar-oauth-security.js';
import {
  MONZO_ARTIST_ALIASES,
  isMonzoArtistAlias,
  monzoArtistDisplayName,
  monzoArtistIdFromEnv,
  monzoArtistOAuthCredentials,
  monzoArtistOAuthEnv,
} from './monzo-artist-registry.js';

const ARTIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const STATE_TTL_SECONDS = 600;

export class MonzoSecurityError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'MonzoSecurityError';
    this.code = code;
    this.status = status;
  }
}

function exactHttpsUrl(value, expectedPath = null) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || (expectedPath && url.pathname !== expectedPath)
    ) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function monzoOAuthRedirectUri(env) {
  return exactHttpsUrl(env?.MONZO_OAUTH_REDIRECT_URI, '/oauth/monzo/callback');
}

export function monzoCrmReturnUrl(env) {
  const raw = String(env?.MONZO_CRM_RETURN_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.pathname !== '/'
      || url.search
      || url.hash !== '#/payments'
    ) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

// Everything artist-scoped is derived here from the registry and the deployed
// configuration: the CRM artist id, the deterministic provider account key, the
// display name and the OAuth client this artist authorises against. No caller
// may pass any of these in from a browser.
export function artistMonzoConfig(alias, env) {
  const artistId = monzoArtistIdFromEnv(alias, env);
  if (!isMonzoArtistAlias(alias) || !ARTIST_ID_PATTERN.test(artistId)) {
    throw new MonzoSecurityError('artist_route_unconfigured', 404);
  }
  const { clientId } = monzoArtistOAuthCredentials(alias, env);
  return {
    alias,
    displayName: monzoArtistDisplayName(alias),
    artistId,
    providerAccountKey: `monzo_ebt_${artistId.replace(/-/g, '')}`,
    oauthClientId: clientId,
    // Provider calls for this artist must use this env view, never the raw
    // Worker env, so a future per-artist OAuth client needs no code change.
    oauthEnv: monzoArtistOAuthEnv(alias, env),
  };
}

export async function verifiedMonzoOwnerEmail(request, env, fetchImpl = fetch) {
  try {
    return await verifiedOwnerEmail(request, {
      ...env,
      CALENDAR_ACCESS_TEAM_DOMAIN: env?.MONZO_ACCESS_TEAM_DOMAIN,
      CALENDAR_ACCESS_AUD: env?.MONZO_ACCESS_AUD,
      CALENDAR_OWNER_EMAILS: env?.MONZO_OWNER_EMAILS,
    }, fetchImpl);
  } catch (error) {
    if (error instanceof OAuthSecurityError) {
      const status = error.code === 'owner_access_required' ? 404 : error.status;
      throw new MonzoSecurityError(error.code, status);
    }
    throw error;
  }
}

export function assertMonzoOAuthStartConfiguration(env) {
  if (
    !env?.MONZO_OAUTH_CLIENT_ID
    || !monzoOAuthRedirectUri(env)
    || !env?.MONZO_OAUTH_STATE
  ) {
    throw new MonzoSecurityError('monzo_not_configured', 503);
  }
}

export function assertMonzoOAuthCallbackConfiguration(env) {
  assertMonzoOAuthStartConfiguration(env);
  if (
    !env?.MONZO_OAUTH_CLIENT_SECRET
    || !env?.MONZO_OAUTH_TOKENS
    || !env?.MONZO_TOKEN_ENCRYPTION_KEY
    || !monzoCrmReturnUrl(env)
  ) {
    throw new MonzoSecurityError('monzo_not_configured', 503);
  }
}

export function assertMonzoAccountConfiguration(env) {
  assertMonzoOAuthCallbackConfiguration(env);
  if (!env?.MONZO_WEBHOOK_ROUTES) throw new MonzoSecurityError('monzo_not_configured', 503);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function randomMonzoToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function buildMonzoOAuthState(alias, ownerEmail, clientId) {
  if (
    !isMonzoArtistAlias(alias)
    || typeof ownerEmail !== 'string'
    || !ownerEmail.trim()
    || typeof clientId !== 'string'
    || !clientId.trim()
  ) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  return {
    alias,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    clientId: clientId.trim(),
    createdAt: new Date().toISOString(),
  };
}

export async function storeMonzoOAuthState(namespace, state, record) {
  if (!namespace || !STATE_PATTERN.test(String(state || ''))) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  await namespace.put(`state:${state}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

// `expectedClientId` is either the OAuth client id itself or a resolver taking
// the alias recorded in the stored state. The resolver form exists because the
// artist is only known once the single-use state has been read, and each artist
// may in future authorise against its own OAuth client. Either way the stored
// state stays bound to owner, alias and the client that started the flow.
export async function consumeMonzoOAuthState(namespace, state, ownerEmail, expectedClientId) {
  if (!namespace || !STATE_PATTERN.test(String(state || ''))) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  const key = `state:${state}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  if (!stored || !isMonzoArtistAlias(stored.alias)) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }

  let expected = '';
  if (typeof expectedClientId === 'function') {
    try {
      expected = String(expectedClientId(stored.alias) || '').trim();
    } catch {
      expected = '';
    }
  } else {
    expected = String(expectedClientId || '').trim();
  }

  if (
    !expected
    || typeof stored.ownerEmail !== 'string'
    || stored.ownerEmail !== String(ownerEmail || '').trim().toLowerCase()
    || typeof stored.clientId !== 'string'
    || !stored.clientId
    || stored.clientId !== expected
  ) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  return stored;
}

export function monzoWebhookBaseUrl(env) {
  const raw = String(env?.MONZO_WEBHOOK_BASE_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

export function monzoWebhookCallbackUrl(env, webhookKey) {
  const origin = monzoWebhookBaseUrl(env);
  if (!origin || !WEBHOOK_KEY_PATTERN.test(String(webhookKey || ''))) {
    throw new MonzoSecurityError('monzo_webhook_configuration_invalid', 503);
  }
  return `${origin}/webhooks/monzo/${webhookKey}`;
}

export function monzoReadiness(env) {
  let artists = false;
  try {
    const ids = MONZO_ARTIST_ALIASES.map((alias) => artistMonzoConfig(alias, env).artistId);
    artists = ids.length > 0 && new Set(ids).size === ids.length;
  } catch {
    artists = false;
  }
  return {
    ok: true,
    service: 'vishar-monzo-api',
    environment: env?.VISHAR_ENVIRONMENT || 'unknown',
    bindings: {
      oauthState: Boolean(env?.MONZO_OAUTH_STATE),
      oauthTokens: Boolean(env?.MONZO_OAUTH_TOKENS),
      webhookRoutes: Boolean(env?.MONZO_WEBHOOK_ROUTES),
    },
    configuration: {
      oauth: Boolean(
        env?.MONZO_OAUTH_CLIENT_ID
        && env?.MONZO_OAUTH_CLIENT_SECRET
        && monzoOAuthRedirectUri(env)
        && env?.MONZO_TOKEN_ENCRYPTION_KEY
        && monzoCrmReturnUrl(env)
      ),
      ownerAccess: Boolean(
        env?.MONZO_ACCESS_TEAM_DOMAIN
        && env?.MONZO_ACCESS_AUD
        && env?.MONZO_OWNER_EMAILS
      ),
      webhookBase: Boolean(monzoWebhookBaseUrl(env)),
      artists,
    },
    reconciliationEnabled: env?.MONZO_RECONCILIATION_ENABLED === 'true',
  };
}

export const __testing = {
  ARTIST_ID_PATTERN,
  STATE_PATTERN,
  WEBHOOK_KEY_PATTERN,
  STATE_TTL_SECONDS,
  exactHttpsUrl,
};
