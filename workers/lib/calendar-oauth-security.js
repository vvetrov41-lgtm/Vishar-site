const STATE_TTL_SECONDS = 600;
const ALIASES = new Set(['vladimir', 'kristina']);

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

export function requireOwnerAccess(request, env) {
  const email = accessEmail(request);
  return Boolean(email && ownerEmails(env).includes(email));
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

export function buildOAuthStateRecord(alias, verifier, request) {
  if (!ALIASES.has(alias) || typeof verifier !== 'string' || verifier.length < 43) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
  }
  const ownerEmail = accessEmail(request);
  if (!ownerEmail) throw new OAuthSecurityError('owner_access_required', 403);
  return {
    alias,
    verifier,
    ownerEmail,
    createdAt: new Date().toISOString(),
  };
}

export async function consumeOAuthState(namespace, state, request) {
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
    || normalizeEmail(stored.ownerEmail) !== accessEmail(request)
  ) {
    throw new OAuthSecurityError('oauth_state_invalid_or_expired');
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
      ownerAccess: ownerEmails(env).length > 0,
      crmReturn: Boolean(env?.CRM_RETURN_URL),
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

export function disconnectConfirmationPage(alias, actionUrl, crmReturnUrl) {
  if (!ALIASES.has(alias)) throw new OAuthSecurityError('artist_route_unconfigured', 404);
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
<button type="submit">Disconnect calendar</button>
<a href="${escapeHtml(crmReturnUrl)}">Cancel</a>
</form>
</body>
</html>`;
}

export async function isConfirmedDisconnectRequest(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    return form.get('confirm') === 'disconnect';
  }
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);
    return body?.confirm === 'disconnect';
  }
  return false;
}

export function disconnectReturnUrl(env, alias, revoked) {
  const destination = new URL(env?.CRM_RETURN_URL || 'https://vishar-crm-staging.pages.dev/appointments');
  destination.searchParams.set('calendar', 'disconnected');
  destination.searchParams.set('artist', alias);
  destination.searchParams.set('revoked', revoked ? 'true' : 'false');
  return destination.toString();
}

export const __testing = {
  ALIASES,
  STATE_TTL_SECONDS,
  escapeHtml,
};
