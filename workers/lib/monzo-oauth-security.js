import { verifiedOwnerEmail } from './calendar-oauth-security.js';

const ALIASES = new Set(['vladimir', 'kristina']);
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

export function artistMonzoConfig(alias, env) {
  const configs = {
    vladimir: {
      alias: 'vladimir',
      artistId: env?.VLADIMIR_ARTIST_ID,
      providerAccountKey: env?.VLADIMIR_ARTIST_ID
        ? `monzo_ebt_${String(env.VLADIMIR_ARTIST_ID).replace(/-/g, '')}`
        : '',
    },
    kristina: {
      alias: 'kristina',
      artistId: env?.KRISTINA_ARTIST_ID,
      providerAccountKey: env?.KRISTINA_ARTIST_ID
        ? `monzo_ebt_${String(env.KRISTINA_ARTIST_ID).replace(/-/g, '')}`
        : '',
    },
  };
  const config = configs[alias];
  if (!config?.artistId || !config.providerAccountKey) {
    throw new MonzoSecurityError('artist_route_unconfigured', 404);
  }
  return config;
}

export async function verifiedMonzoOwnerEmail(request, env, fetchImpl = fetch) {
  return verifiedOwnerEmail(request, {
    ...env,
    CALENDAR_ACCESS_TEAM_DOMAIN: env?.MONZO_ACCESS_TEAM_DOMAIN,
    CALENDAR_ACCESS_AUD: env?.MONZO_ACCESS_AUD,
    CALENDAR_OWNER_EMAILS: env?.MONZO_OWNER_EMAILS,
  }, fetchImpl);
}

export function assertMonzoOAuthStartConfiguration(env) {
  if (
    !env?.MONZO_OAUTH_CLIENT_ID
    || !env?.MONZO_OAUTH_REDIRECT_URI
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
  ) {
    throw new MonzoSecurityError('monzo_not_configured', 503);
  }
}

export function assertMonzoAccountConfiguration(env) {
  assertMonzoOAuthCallbackConfiguration(env);
  if (!env?.MONZO_WEBHOOK_ROUTES) throw new MonzoSecurityError('monzo_not_configured', 503);
}

export function assertMonzoWebhookRegistrationConfiguration(env) {
  assertMonzoAccountConfiguration(env);
  if (env?.MONZO_WEBHOOK_REGISTRATION_ENABLED !== 'true' || !monzoWebhookBaseUrl(env)) {
    throw new MonzoSecurityError('monzo_webhook_registration_disabled', 503);
  }
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

export function buildMonzoOAuthState(alias, ownerEmail) {
  if (!ALIASES.has(alias) || typeof ownerEmail !== 'string' || !ownerEmail.trim()) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  return {
    alias,
    ownerEmail: ownerEmail.trim().toLowerCase(),
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

export async function consumeMonzoOAuthState(namespace, state, ownerEmail) {
  if (!namespace || !STATE_PATTERN.test(String(state || ''))) {
    throw new MonzoSecurityError('oauth_state_invalid_or_expired');
  }
  const key = `state:${state}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  if (
    !stored
    || !ALIASES.has(stored.alias)
    || typeof stored.ownerEmail !== 'string'
    || stored.ownerEmail !== String(ownerEmail || '').trim().toLowerCase()
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
    const vladimir = artistMonzoConfig('vladimir', env);
    const kristina = artistMonzoConfig('kristina', env);
    artists = vladimir.artistId !== kristina.artistId;
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
        && env?.MONZO_OAUTH_REDIRECT_URI
        && env?.MONZO_TOKEN_ENCRYPTION_KEY
      ),
      ownerAccess: Boolean(
        env?.MONZO_ACCESS_TEAM_DOMAIN
        && env?.MONZO_ACCESS_AUD
        && env?.MONZO_OWNER_EMAILS
      ),
      webhookBase: Boolean(monzoWebhookBaseUrl(env)),
      artists,
    },
    webhookRegistrationEnabled: env?.MONZO_WEBHOOK_REGISTRATION_ENABLED === 'true',
    reconciliationEnabled: env?.MONZO_RECONCILIATION_ENABLED === 'true',
  };
}

export const __testing = {
  STATE_PATTERN,
  WEBHOOK_KEY_PATTERN,
  STATE_TTL_SECONDS,
};
