import {
  deleteMonzoWebhook,
  ensureMonzoAccessToken,
  listMonzoAccounts,
  monzoWhoAmI,
  registerMonzoWebhook,
  MonzoApiError,
} from './monzo-api-client.js';
import {
  artistMonzoConfig,
  assertMonzoAccountConfiguration,
  monzoCrmReturnUrl,
  monzoOAuthRedirectUri,
  monzoWebhookCallbackUrl,
  randomMonzoToken,
  verifiedMonzoOwnerEmail,
  MonzoSecurityError,
} from './monzo-oauth-security.js';
import {
  loadMonzoTokenRecord,
  saveMonzoTokenRecord,
  MonzoTokenError,
} from './monzo-token-store.js';

const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{96,512}$/;
const SETUP_TOKEN_VERSION = 1;
const SETUP_TTL_SECONDS = 600;
const SETUP_CLOCK_SKEW_MS = 30_000;
const SETUP_TOKEN_CONTEXT = new TextEncoder().encode('vishar-monzo-setup-confirmation-v1');
const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9]+$/;
const FORM_BODY_LIMIT = 4096;
const ALIASES = new Set(['vladimir', 'kristina']);

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function html(body, status = 200) {
  return new Response(body, { status, headers: htmlHeaders });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function artistName(alias) {
  return alias === 'vladimir' ? 'Vladimir' : 'Kristina';
}

function connectorOrigin(env) {
  const redirect = monzoOAuthRedirectUri(env);
  if (!redirect) throw new MonzoSecurityError('monzo_not_configured', 503);
  return new URL(redirect).origin;
}

export function monzoSetupUrl(env, alias) {
  if (!ALIASES.has(alias)) throw new MonzoSecurityError('artist_route_unconfigured', 404);
  return `${connectorOrigin(env)}/oauth/monzo/setup/${alias}`;
}

function monzoStartUrl(env, alias) {
  return `${connectorOrigin(env)}/oauth/monzo/start/${alias}`;
}

function monzoDisconnectUrl(env, alias) {
  return `${connectorOrigin(env)}/oauth/monzo/disconnect/${alias}`;
}

function connectedReturnUrl(env, alias) {
  const destination = new URL(monzoCrmReturnUrl(env));
  destination.searchParams.set('monzo', 'connected');
  destination.searchParams.set('artist', alias);
  return destination.toString();
}

function routeKey(webhookKey) {
  return `route:${webhookKey}`;
}

function routeRecord(alias, config, accountId) {
  return JSON.stringify({
    alias,
    artistId: config.artistId,
    providerAccountKey: config.providerAccountKey,
    accountId,
  });
}

function assertRecordRoute(record, config, alias, env) {
  if (
    record.alias !== alias
    || record.artistId !== config.artistId
    || record.providerAccountKey !== config.providerAccountKey
    || record.clientId !== env.MONZO_OAUTH_CLIENT_ID
  ) {
    throw new MonzoSecurityError('provider_route_invalid', 503);
  }
}

async function saveConnectionStateBestEffort(env, record, connectionState) {
  try {
    await saveMonzoTokenRecord(env, { ...record, connectionState });
  } catch {
    // Status is advisory. Preserve the provider error and never expose token material.
  }
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.5}a,button{display:inline-block;margin:8px 8px 0 0;padding:10px 14px}button{border:0;background:#111;color:#fff;border-radius:6px}fieldset{border:0;padding:0;margin:20px 0}label{display:block;padding:10px 0}small{color:#555}.danger{color:#8b1e1e}</style>
</head>
<body>${body}</body>
</html>`;
}

function notConnectedPage(env, alias) {
  return shell('Connect Monzo', `
<h1>Connect ${escapeHtml(artistName(alias))}’s Monzo account</h1>
<p>The connection is not active. OAuth credentials and account access stay inside the protected connector.</p>
<a href="${escapeHtml(monzoStartUrl(env, alias))}">Continue to Monzo</a>
<a href="${escapeHtml(monzoCrmReturnUrl(env))}">Back to CRM</a>`);
}

function connectedPage(env, alias, label) {
  return shell('Monzo connected', `
<h1>Monzo is connected for ${escapeHtml(artistName(alias))}</h1>
<p>Account: <strong>${escapeHtml(label || 'Connected account')}</strong></p>
<p>Incoming webhook events are still only hints. The connector re-fetches each transaction from Monzo before creating a reconciliation candidate.</p>
<a href="${escapeHtml(monzoCrmReturnUrl(env))}">Back to CRM</a>
<a class="danger" href="${escapeHtml(monzoDisconnectUrl(env, alias))}">Disconnect Monzo</a>`);
}

function approvalPendingPage(env, alias) {
  const setup = monzoSetupUrl(env, alias);
  return shell('Approve Monzo access', `
<h1>Approve access in the Monzo app</h1>
<p>Monzo has authenticated the connection, but the access token has no account permissions until you approve the request in the Monzo app with PIN, Face ID or Touch ID.</p>
<p>Open Monzo, approve the request, then return here.</p>
<form method="get" action="${escapeHtml(setup)}"><button type="submit">I approved it, continue</button></form>
<a href="${escapeHtml(monzoCrmReturnUrl(env))}">Back to CRM</a>`);
}

function accountsPage(env, alias, accounts, token) {
  const options = accounts.length
    ? accounts.map((account, index) => `
<label><input type="radio" name="account_id" value="${escapeHtml(account.id)}" ${index === 0 ? 'checked' : ''}> ${escapeHtml(account.description)}</label>`).join('')
    : '<p>No eligible Monzo accounts were returned for this user.</p>';
  const form = accounts.length ? `
<form method="post" action="${escapeHtml(monzoSetupUrl(env, alias))}">
<input type="hidden" name="setup_token" value="${escapeHtml(token)}">
<fieldset><legend>Select the account used to receive tattoo payments</legend>${options}</fieldset>
<button type="submit">Connect selected account</button>
</form>` : options;
  return shell('Select Monzo account', `
<h1>Select ${escapeHtml(artistName(alias))}’s Monzo account</h1>
<p>The account id shown by the browser is not authoritative. The connector will re-fetch the allowed accounts from Monzo before registering any webhook.</p>
${form}
<a href="${escapeHtml(monzoCrmReturnUrl(env))}">Cancel</a>`);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlBytes(value) {
  if (typeof value !== 'string' || !value) throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }
}

function setupKeyBytes(value) {
  const bytes = base64UrlBytes(String(value || ''));
  if (bytes.length !== 32) throw new MonzoSecurityError('monzo_not_configured', 503);
  return bytes;
}

async function setupEncryptionKey(value, usages) {
  return crypto.subtle.importKey(
    'raw',
    setupKeyBytes(value),
    'AES-GCM',
    false,
    usages,
  );
}

function normalizedOwnerEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  return email;
}

export async function createSetupConfirmationToken(env, alias, ownerEmail, record, now = Date.now()) {
  if (
    !ALIASES.has(alias)
    || !record
    || record.alias !== alias
    || typeof record.clientId !== 'string'
    || !record.clientId
    || typeof record.userId !== 'string'
    || !record.userId
    || !Number.isSafeInteger(now)
    || now <= 0
  ) {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }

  const payload = {
    v: SETUP_TOKEN_VERSION,
    a: alias,
    o: normalizedOwnerEmail(ownerEmail),
    c: record.clientId,
    u: record.userId,
    i: now,
    n: randomMonzoToken(16),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: SETUP_TOKEN_CONTEXT },
    await setupEncryptionKey(env?.MONZO_TOKEN_ENCRYPTION_KEY, ['encrypt']),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sealed = new Uint8Array(iv.length + encrypted.byteLength);
  sealed.set(iv, 0);
  sealed.set(new Uint8Array(encrypted), iv.length);
  const token = base64Url(sealed);
  if (!SETUP_TOKEN_PATTERN.test(token)) {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }
  return token;
}

export async function verifySetupConfirmationToken(env, token, alias, ownerEmail, record, now = Date.now()) {
  if (!SETUP_TOKEN_PATTERN.test(String(token || '')) || !ALIASES.has(alias) || !record) {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }

  let payload;
  try {
    const sealed = base64UrlBytes(token);
    if (sealed.length <= 28) throw new Error('sealed setup token too short');
    const iv = sealed.slice(0, 12);
    const ciphertext = sealed.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: SETUP_TOKEN_CONTEXT },
      await setupEncryptionKey(env?.MONZO_TOKEN_ENCRYPTION_KEY, ['decrypt']),
      ciphertext,
    );
    payload = JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    if (error instanceof MonzoSecurityError && error.code === 'monzo_not_configured') throw error;
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }

  const owner = normalizedOwnerEmail(ownerEmail);
  if (
    payload?.v !== SETUP_TOKEN_VERSION
    || payload.a !== alias
    || payload.o !== owner
    || payload.c !== record.clientId
    || payload.u !== record.userId
    || !Number.isSafeInteger(payload.i)
    || payload.i <= 0
    || payload.i > now + SETUP_CLOCK_SKEW_MS
    || now - payload.i > SETUP_TTL_SECONDS * 1000
    || typeof payload.n !== 'string'
    || !/^[A-Za-z0-9_-]{22,32}$/.test(payload.n)
  ) {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }
  return true;
}

async function readSetupForm(request) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declared) && declared > FORM_BODY_LIMIT) {
    throw new MonzoSecurityError('request_too_large', 413);
  }
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/x-www-form-urlencoded')) {
    throw new MonzoSecurityError('form_required', 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > FORM_BODY_LIMIT) {
    throw new MonzoSecurityError('request_too_large', 413);
  }
  const form = new URLSearchParams(text);
  const setupToken = form.get('setup_token') || '';
  const accountId = form.get('account_id') || '';
  if (!SETUP_TOKEN_PATTERN.test(setupToken) || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new MonzoSecurityError('setup_confirmation_invalid_or_expired');
  }
  return { setupToken, accountId };
}

async function accessForSetup(env, record, fetchImpl) {
  const access = await ensureMonzoAccessToken(env, record, fetchImpl);
  await monzoWhoAmI(access.accessToken, access.record.clientId, access.record.userId, fetchImpl);
  return access;
}

async function selectAndRegister(alias, accountId, env, record, fetchImpl) {
  const config = artistMonzoConfig(alias, env);
  assertRecordRoute(record, config, alias, env);
  if (record.webhookId) return record;

  const access = await accessForSetup(env, record, fetchImpl);
  const accounts = await listMonzoAccounts(access.accessToken, fetchImpl);
  const selected = accounts.find((account) => account.id === accountId);
  if (!selected) throw new MonzoSecurityError('monzo_account_not_allowed', 400);

  const updated = {
    ...access.record,
    connectionState: 'account_selected',
    accountId: selected.id,
    accountLabel: selected.description,
    webhookKey: access.record.webhookKey || randomMonzoToken(),
    webhookId: null,
    accountSelectedAt: new Date().toISOString(),
  };
  const previousRoute = record.accountId && record.webhookKey
    ? routeRecord(alias, config, record.accountId)
    : null;

  try {
    await saveMonzoTokenRecord(env, updated);
    await env.MONZO_WEBHOOK_ROUTES.put(
      routeKey(updated.webhookKey),
      routeRecord(alias, config, selected.id),
    );
  } catch (error) {
    await saveMonzoTokenRecord(env, record).catch(() => {});
    if (previousRoute) {
      await env.MONZO_WEBHOOK_ROUTES.put(routeKey(updated.webhookKey), previousRoute).catch(() => {});
    } else {
      await env.MONZO_WEBHOOK_ROUTES.delete(routeKey(updated.webhookKey)).catch(() => {});
    }
    throw error;
  }

  const callbackUrl = monzoWebhookCallbackUrl(env, updated.webhookKey);
  const webhook = await registerMonzoWebhook(
    access.accessToken,
    selected.id,
    callbackUrl,
    fetchImpl,
  );
  const connected = {
    ...updated,
    connectionState: 'webhook_registered',
    webhookId: webhook.id,
    webhookRegisteredAt: new Date().toISOString(),
  };
  try {
    await saveMonzoTokenRecord(env, connected);
  } catch (error) {
    await deleteMonzoWebhook(access.accessToken, webhook.id, fetchImpl).catch(() => false);
    throw error;
  }
  return connected;
}

export async function handleMonzoSetup(request, alias, env, fetchImpl = fetch) {
  const ownerEmail = await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoAccountConfiguration(env);
  const config = artistMonzoConfig(alias, env);

  let record;
  try {
    record = await loadMonzoTokenRecord(env, config.artistId);
  } catch (error) {
    if (error instanceof MonzoTokenError && error.code === 'monzo_not_connected' && request.method === 'GET') {
      return html(notConnectedPage(env, alias));
    }
    throw error;
  }
  assertRecordRoute(record, config, alias, env);

  if (request.method === 'GET') {
    if (record.webhookId) return html(connectedPage(env, alias, record.accountLabel));

    let accounts;
    try {
      const access = await accessForSetup(env, record, fetchImpl);
      record = access.record;
      accounts = await listMonzoAccounts(access.accessToken, fetchImpl);
    } catch (error) {
      if (error instanceof MonzoApiError && error.code === 'monzo_approval_pending') {
        await saveConnectionStateBestEffort(env, record, 'approval_pending');
        return html(approvalPendingPage(env, alias));
      }
      throw error;
    }
    const token = await createSetupConfirmationToken(env, alias, ownerEmail, record);
    return html(accountsPage(env, alias, accounts, token));
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, code: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const { setupToken, accountId } = await readSetupForm(request);
  await verifySetupConfirmationToken(env, setupToken, alias, ownerEmail, record);
  if (record.webhookId) return Response.redirect(connectedReturnUrl(env, alias), 303);

  const connected = await selectAndRegister(alias, accountId, env, record, fetchImpl);
  if (!connected.webhookId) throw new MonzoSecurityError('monzo_webhook_registration_failed', 502);
  return Response.redirect(connectedReturnUrl(env, alias), 303);
}

export const __testing = {
  SETUP_TOKEN_PATTERN,
  SETUP_TTL_SECONDS,
  readSetupForm,
  createSetupConfirmationToken,
  verifySetupConfirmationToken,
  selectAndRegister,
  notConnectedPage,
  approvalPendingPage,
  accountsPage,
};