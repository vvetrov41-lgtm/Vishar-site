const STATE_TTL_SECONDS = 600;
const DISCONNECT_TTL_SECONDS = 600;
const ACCESS_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const ALIASES = new Set(['vladimir', 'kristina']);
const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const ACCESS_JWT_ALGORITHM = 'RS256';
const accessJwksCache = new Map();

export class OAuthSecurityError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'OAuthSecurityError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function accessEmail(request) {
  return normalizeEmail(request?.headers?.get('Cf-Access-Authenticated-User-Email'));
}

export function ownerEmails(env) {
  return String(env?.CALENDAR_OWNER_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

function normalizeTeamDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || !url.hostname.endsWith('.cloudflareaccess.com')
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function base64UrlBytes(value) {
  if (typeof value !== 'string' || !value) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
}

function decodeJwtJson(value) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
  } catch (error) {
    if (error instanceof OAuthSecurityError) throw error;
    throw new OAuthSecurityError('owner_access_required', 403);
  }
}

async function accessJwks(teamDomain, fetchImpl, forceRefresh = false) {
  const cached = accessJwksCache.get(teamDomain);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: 'application/json' },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.keys)) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
  accessJwksCache.set(teamDomain, {
    keys: body.keys,
    expiresAt: Date.now() + ACCESS_JWKS_CACHE_TTL_MS,
  });
  return body.keys;
}

async function accessSigningKey(teamDomain, kid, fetchImpl) {
  let keys = await accessJwks(teamDomain, fetchImpl);
  let jwk = keys.find((candidate) => candidate?.kid === kid);
  if (!jwk) {
    keys = await accessJwks(teamDomain, fetchImpl, true);
    jwk = keys.find((candidate) => candidate?.kid === kid);
  }
  if (!jwk || (jwk.alg && jwk.alg !== ACCESS_JWT_ALGORITHM)) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
  try {
    return await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
}

export async function verifiedOwnerEmail(request, env, fetchImpl = fetch) {
  const teamDomain = normalizeTeamDomain(env?.CALENDAR_ACCESS_TEAM_DOMAIN);
  const audience = String(env?.CALENDAR_ACCESS_AUD || '').trim();
  const token = request?.headers?.get('Cf-Access-Jwt-Assertion') || '';
  const parts = token.split('.');
  if (!teamDomain || !audience || parts.length !== 3) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }

  const header = decodeJwtJson(parts[0]);
  const payload = decodeJwtJson(parts[1]);
  if (
    header?.alg !== ACCESS_JWT_ALGORITHM
    || typeof header?.kid !== 'string'
    || !header.kid
  ) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }

  const key = await accessSigningKey(teamDomain, header.kid, fetchImpl);
  const verified = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  ).catch(() => false);
  if (!verified) throw new OAuthSecurityError('owner_access_required', 403);

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  const email = normalizeEmail(payload?.email);
  const forwardedEmail = accessEmail(request);
  if (
    payload?.iss !== teamDomain
    || !audiences.includes(audience)
    || !Number.isFinite(payload?.exp)
    || payload.exp <= now
    || (Number.isFinite(payload?.nbf) && payload.nbf > now)
    || !email
    || (forwardedEmail && forwardedEmail !== email)
    || !ownerEmails(env).includes(email)
  ) {
    throw new OAuthSecurityError('owner_access_required', 403);
  }
  return email;
}

export async function requireOwnerAccess(request, env, fetchImpl = fetch) {
  try {
    await verifiedOwnerEmail(request, env, fetchImpl);
    return true;
  } catch {
    return false;
  }
}

export function assertOAuthStartConfiguration(env) {
  if (
    !env?.GOOGLE_OAUTH_CLIENT_ID
    || !env?.GOOGLE_OAUTH_REDIRECT_URI
    || !env?.CALENDAR_OAUTH_STATE
  ) {
    throw new OAuthSecurityError('calendar_not_configured', 503);
  }
}

export function assertOAuthCallbackConfiguration(env) {
  assertOAuthStartConfiguration(env);
  if (
    !env?.GOOGLE_OAUTH_CLIENT_SECRET
    || !env?.CALENDAR_OAUTH_TOKENS
    || !env?.CALENDAR_TOKEN_ENCRYPTION_KEY
  ) {
    throw new OAuthSecurityError('calendar_not_configured', 503);
  }
}

export function assertDisconnectConfiguration(env) {
  if (
    !env?.CALENDAR_OAUTH_STATE
    || !env?.CALENDAR_OAUTH_TOKENS
    || !env?.CALENDAR_TOKEN_ENCRYPTION_KEY
  ) {
    throw new OAuthSecurityError('calendar_not_configured', 503);
  }
}

export function buildOAuthStateRecord(alias, verifier, ownerEmail) {
  if (
    !ALIASES.has(alias)
    || typeof verifier !== 'string'
    || verifier.length < 43
    || !normalizeEmail(ownerEmail)
  ) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  return {
    alias,
    verifier,
    ownerEmail: normalizeEmail(ownerEmail),
    createdAt: new Date().toISOString(),
  };
}

export async function consumeOAuthState(namespace, state, ownerEmail) {
  if (!namespace || typeof state !== 'string' || !state) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  const key = `state:${state}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  if (
    !stored
    || !ALIASES.has(stored.alias)
    || typeof stored.verifier !== 'string'
    || stored.verifier.length < 43
    || normalizeEmail(stored.ownerEmail) !== normalizeEmail(ownerEmail)
  ) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  return stored;
}

export function buildDisconnectStateRecord(alias, ownerEmail) {
  if (!ALIASES.has(alias) || !normalizeEmail(ownerEmail)) {
    throw new OAuthSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  return {
    alias,
    ownerEmail: normalizeEmail(ownerEmail),
    createdAt: new Date().toISOString(),
  };
}

export async function consumeDisconnectState(namespace, alias, token, ownerEmail) {
  if (
    !namespace
    || !ALIASES.has(alias)
    || typeof token !== 'string'
    || !CONFIRMATION_TOKEN_PATTERN.test(token)
  ) {
    throw new OAuthSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  const key = `disconnect:${token}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  if (
    !stored
    || stored.alias !== alias
    || normalizeEmail(stored.ownerEmail) !== normalizeEmail(ownerEmail)
  ) {
    throw new OAuthSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  return stored;
}

export function validateTokenExchange(responseOk, tokens) {
  if (
    !responseOk
    || typeof tokens?.access_token !== 'string'
    || !tokens.access_token
    || typeof tokens?.refresh_token !== 'string'
    || !tokens.refresh_token
  ) {
    throw new OAuthSecurityError('google_token_exchange_failed', 502);
  }
  return tokens;
}

export function validateGoogleAccount(responseOk, user, expectedEmail) {
  const accountEmail = normalizeEmail(user?.email);
  if (
    !responseOk
    || user?.email_verified !== true
    || !accountEmail
    || accountEmail !== normalizeEmail(expectedEmail)
  ) {
    throw new OAuthSecurityError('google_account_mismatch', 403);
  }
  return accountEmail;
}

export function calendarReadiness(env) {
  const hasSecretKey = Boolean(env?.SUPABASE_SECRET_KEY);
  const hasLegacyKey = Boolean(env?.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseConfigured = Boolean(env?.SUPABASE_URL && (hasSecretKey !== hasLegacyKey));
  const artistsConfigured = Boolean(
    env?.VLADIMIR_ARTIST_ID
    && env?.VLADIMIR_GOOGLE_EMAIL
    && env?.KRISTINA_ARTIST_ID
    && env?.KRISTINA_GOOGLE_EMAIL
    && env.VLADIMIR_ARTIST_ID !== env.KRISTINA_ARTIST_ID
    && normalizeEmail(env.VLADIMIR_GOOGLE_EMAIL) !== normalizeEmail(env.KRISTINA_GOOGLE_EMAIL)
  );
  return {
    ok: true,
    service: 'vishar-calendar-oauth',
    environment: env?.VISHAR_ENVIRONMENT || 'unknown',
    bindings: {
      oauthState: Boolean(env?.CALENDAR_OAUTH_STATE),
      oauthTokens: Boolean(env?.CALENDAR_OAUTH_TOKENS),
    },
    configuration: {
      googleOauth: Boolean(
        env?.GOOGLE_OAUTH_CLIENT_ID
        && env?.GOOGLE_OAUTH_CLIENT_SECRET
        && env?.GOOGLE_OAUTH_REDIRECT_URI
        && env?.CALENDAR_TOKEN_ENCRYPTION_KEY
      ),
      supabase: supabaseConfigured,
      artists: artistsConfigured,
      ownerAccess: Boolean(
        normalizeTeamDomain(env?.CALENDAR_ACCESS_TEAM_DOMAIN)
        && String(env?.CALENDAR_ACCESS_AUD || '').trim()
        && ownerEmails(env).length > 0
      ),
      crmReturn: Boolean(env?.CRM_RETURN_URL),
      crmAppointments: Boolean(env?.CRM_APPOINTMENTS_URL),
    },
    scheduledDrain: env?.CALENDAR_DRAIN_ENABLED === 'true',
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function disconnectConfirmationPage(alias, actionUrl, crmReturnUrl, token) {
  if (!ALIASES.has(alias)) throw new OAuthSecurityError('artist_route_unconfigured', 404);
  if (typeof token !== 'string' || !CONFIRMATION_TOKEN_PATTERN.test(token)) {
    throw new OAuthSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  const artistName = alias === 'vladimir' ? 'Vladimir' : 'Kristina';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Disconnect Google Calendar</title>
<style>body{font:16px system-ui;max-width:560px;margin:48px auto;padding:0 20px;line-height:1.5}button,a{display:inline-block;margin:8px 8px 0 0;padding:10px 14px}button{border:0;background:#8b1e1e;color:#fff;border-radius:6px}a{color:inherit}</style>
</head>
<body>
<h1>Disconnect ${escapeHtml(artistName)}’s Google Calendar?</h1>
<p>This removes the encrypted local connection and attempts to revoke the Google grant. Existing CRM appointments remain unchanged.</p>
<form method="post" action="${escapeHtml(actionUrl)}">
<input type="hidden" name="confirm" value="disconnect">
<input type="hidden" name="disconnect_token" value="${escapeHtml(token)}">
<button type="submit">Disconnect calendar</button>
<a href="${escapeHtml(crmReturnUrl)}">Cancel</a>
</form>
</body>
</html>`;
}

export async function disconnectConfirmationToken(request) {
  const contentType = request.headers.get('Content-Type') || '';
  let confirm = null;
  let token = null;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    confirm = form.get('confirm');
    token = form.get('disconnect_token');
  } else if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);
    confirm = body?.confirm;
    token = body?.disconnect_token;
  }
  return confirm === 'disconnect'
    && typeof token === 'string'
    && CONFIRMATION_TOKEN_PATTERN.test(token)
    ? token
    : '';
}

export async function isConfirmedDisconnectRequest(request) {
  return Boolean(await disconnectConfirmationToken(request));
}

export function disconnectReturnUrl(env, alias, revoked) {
  const destination = new URL(
    env?.CRM_RETURN_URL || 'https://vishar-crm-staging.pages.dev/#/appointments',
  );
  destination.searchParams.set('calendar', 'disconnected');
  destination.searchParams.set('artist', alias);
  destination.searchParams.set('revoked', revoked ? 'true' : 'false');
  return destination.toString();
}

export const __testing = {
  ALIASES,
  STATE_TTL_SECONDS,
  DISCONNECT_TTL_SECONDS,
  CONFIRMATION_TOKEN_PATTERN,
  ACCESS_JWKS_CACHE_TTL_MS,
  normalizeTeamDomain,
  decodeJwtJson,
  accessJwksCache,
  escapeHtml,
};
