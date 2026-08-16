import { monzoCrmReturnUrl, MonzoSecurityError } from './monzo-oauth-security.js';

const ALIASES = new Set(['vladimir', 'kristina']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CONFIRMATION_TTL_SECONDS = 600;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildMonzoDisconnectState(alias, ownerEmail) {
  const email = String(ownerEmail || '').trim().toLowerCase();
  if (!ALIASES.has(alias) || !email) {
    throw new MonzoSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  return { alias, ownerEmail: email, createdAt: new Date().toISOString() };
}

export async function storeMonzoDisconnectState(namespace, token, record) {
  if (!namespace || !TOKEN_PATTERN.test(String(token || ''))) {
    throw new MonzoSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  await namespace.put(`disconnect:${token}`, JSON.stringify(record), {
    expirationTtl: CONFIRMATION_TTL_SECONDS,
  });
}

export async function consumeMonzoDisconnectState(namespace, alias, token, ownerEmail) {
  if (!namespace || !ALIASES.has(alias) || !TOKEN_PATTERN.test(String(token || ''))) {
    throw new MonzoSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  const key = `disconnect:${token}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  if (
    !stored
    || stored.alias !== alias
    || String(stored.ownerEmail || '').trim().toLowerCase() !== String(ownerEmail || '').trim().toLowerCase()
  ) {
    throw new MonzoSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  return stored;
}

export function monzoDisconnectConfirmationPage(alias, actionUrl, env, token) {
  if (!ALIASES.has(alias)) throw new MonzoSecurityError('artist_route_unconfigured', 404);
  if (!TOKEN_PATTERN.test(String(token || ''))) {
    throw new MonzoSecurityError('disconnect_confirmation_invalid_or_expired');
  }
  const returnUrl = monzoCrmReturnUrl(env);
  if (!returnUrl) throw new MonzoSecurityError('monzo_not_configured', 503);
  const artistName = alias === 'vladimir' ? 'Vladimir' : 'Kristina';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Disconnect Monzo</title>
<style>body{font:16px system-ui;max-width:560px;margin:48px auto;padding:0 20px;line-height:1.5}button,a{display:inline-block;margin:8px 8px 0 0;padding:10px 14px}button{border:0;background:#8b1e1e;color:#fff;border-radius:6px}a{color:inherit}</style>
</head>
<body>
<h1>Disconnect ${escapeHtml(artistName)}’s Monzo connection?</h1>
<p>This removes the encrypted CRM connection and stops local reconciliation. The connector also attempts to delete its Monzo webhook and invalidate its current access token.</p>
<form method="post" action="${escapeHtml(actionUrl)}">
<input type="hidden" name="confirm" value="disconnect">
<input type="hidden" name="disconnect_token" value="${escapeHtml(token)}">
<button type="submit">Disconnect Monzo</button>
<a href="${escapeHtml(returnUrl)}">Cancel</a>
</form>
</body>
</html>`;
}

export async function monzoDisconnectConfirmationToken(request) {
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
  return confirm === 'disconnect' && typeof token === 'string' && TOKEN_PATTERN.test(token)
    ? token
    : null;
}

export function monzoDisconnectReturnUrl(env, alias) {
  if (!ALIASES.has(alias)) throw new MonzoSecurityError('artist_route_unconfigured', 404);
  const destination = new URL(monzoCrmReturnUrl(env));
  destination.searchParams.set('monzo', 'disconnected');
  destination.searchParams.set('artist', alias);
  return destination.toString();
}

export const __testing = { TOKEN_PATTERN, CONFIRMATION_TTL_SECONDS };
