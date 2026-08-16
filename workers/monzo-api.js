import {
  deleteMonzoWebhook,
  ensureMonzoAccessToken,
  exchangeMonzoAuthorizationCode,
  listMonzoAccounts,
  logoutMonzoAccessToken,
  monzoWhoAmI,
  registerMonzoWebhook,
  retrieveMonzoTransaction,
  verifyTransactionBelongsToAccount,
  MonzoApiError,
} from './lib/monzo-api-client.js';
import {
  artistMonzoConfig,
  assertMonzoAccountConfiguration,
  assertMonzoOAuthCallbackConfiguration,
  assertMonzoOAuthStartConfiguration,
  buildMonzoOAuthState,
  consumeMonzoOAuthState,
  monzoCrmReturnUrl,
  monzoOAuthRedirectUri,
  monzoReadiness,
  monzoWebhookCallbackUrl,
  randomMonzoToken,
  storeMonzoOAuthState,
  verifiedMonzoOwnerEmail,
  MonzoSecurityError,
} from './lib/monzo-oauth-security.js';
import {
  deleteMonzoTokenRecord,
  loadMonzoTokenRecord,
  saveMonzoTokenRecord,
  MonzoTokenError,
} from './lib/monzo-token-store.js';
import { createMonzoSupabaseClient, MonzoSupabaseError } from './lib/monzo-supabase.js';

const MONZO_AUTH_URL = 'https://auth.monzo.com/';
const WEBHOOK_PATH = /^\/webhooks\/monzo\/([A-Za-z0-9_-]{43,128})$/;
const ALIAS_PATH = '(vladimir|kristina)';
const WEBHOOK_BODY_LIMIT = 32 * 1024;

const securityHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: securityHeaders });
}

function safeError(error) {
  if (error instanceof MonzoSecurityError) return json({ ok: false, code: error.code }, error.status);
  if (error instanceof MonzoApiError) return json({ ok: false, code: error.code }, error.status);
  if (error instanceof MonzoTokenError) {
    const status = error.code === 'monzo_not_connected' ? 409 : 503;
    return json({ ok: false, code: error.code }, status);
  }
  return null;
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

function validStoredRoute(route, record, config, alias) {
  return Boolean(
    route
    && route.alias === alias
    && route.artistId === config.artistId
    && route.providerAccountKey === config.providerAccountKey
    && route.accountId === record.accountId
  );
}

async function saveConnectionStateBestEffort(env, record, connectionState) {
  try {
    await saveMonzoTokenRecord(env, { ...record, connectionState });
  } catch {
    // Preserve the original provider error and never leak token material.
  }
}

async function accessFor(env, record, fetchImpl = fetch) {
  try {
    return await ensureMonzoAccessToken(env, record, fetchImpl);
  } catch (error) {
    if (error instanceof MonzoApiError && error.code === 'monzo_reauthorization_required') {
      await saveConnectionStateBestEffort(env, record, 'reauthorization_required');
    }
    throw error;
  }
}

async function startOAuth(request, alias, env, fetchImpl = fetch) {
  const ownerEmail = await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  artistMonzoConfig(alias, env);
  assertMonzoOAuthStartConfiguration(env);

  const state = randomMonzoToken();
  await storeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, buildMonzoOAuthState(alias, ownerEmail));

  const params = new URLSearchParams({
    client_id: env.MONZO_OAUTH_CLIENT_ID,
    redirect_uri: monzoOAuthRedirectUri(env),
    response_type: 'code',
    state,
  });
  const destination = new URL(MONZO_AUTH_URL);
  destination.search = params.toString();
  return Response.redirect(destination.toString(), 302);
}

async function previousTokenRecord(env, artistId) {
  try {
    return await loadMonzoTokenRecord(env, artistId);
  } catch (error) {
    if (error instanceof MonzoTokenError && error.code === 'monzo_not_connected') return null;
    throw error;
  }
}

async function oauthCallback(request, env, fetchImpl = fetch) {
  const ownerEmail = await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoOAuthCallbackConfiguration(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const providerError = url.searchParams.get('error');
  if (!state) throw new MonzoSecurityError('oauth_callback_invalid');

  const stored = await consumeMonzoOAuthState(env.MONZO_OAUTH_STATE, state, ownerEmail);
  if (providerError) throw new MonzoSecurityError('monzo_authorisation_denied');
  if (!code) throw new MonzoSecurityError('oauth_callback_invalid');

  const config = artistMonzoConfig(stored.alias, env);
  const previous = await previousTokenRecord(env, config.artistId);
  const tokens = await exchangeMonzoAuthorizationCode(env, code, fetchImpl);
  try {
    await monzoWhoAmI(
      tokens.access_token,
      env.MONZO_OAUTH_CLIENT_ID,
      tokens.user_id,
      fetchImpl,
    );
  } catch (error) {
    await logoutMonzoAccessToken(tokens.access_token, fetchImpl).catch(() => false);
    throw error;
  }

  const record = {
    alias: stored.alias,
    connectionState: 'oauth_authorized',
    artistId: config.artistId,
    providerAccountKey: config.providerAccountKey,
    clientId: tokens.client_id,
    userId: tokens.user_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    connectedAt: new Date().toISOString(),
    accountId: null,
    accountLabel: null,
    webhookKey: randomMonzoToken(),
    webhookId: null,
  };

  try {
    await saveMonzoTokenRecord(env, record);
    if (
      env.MONZO_WEBHOOK_ROUTES
      && previous?.webhookKey
      && previous.webhookKey !== record.webhookKey
    ) {
      await env.MONZO_WEBHOOK_ROUTES.delete(routeKey(previous.webhookKey)).catch(() => {});
    }
  } catch (error) {
    if (previous) {
      await saveMonzoTokenRecord(env, previous).catch(() => {});
    } else {
      await deleteMonzoTokenRecord(env, config.artistId).catch(() => {});
    }
    await logoutMonzoAccessToken(tokens.access_token, fetchImpl).catch(() => false);
    throw error;
  }

  const destination = new URL(monzoCrmReturnUrl(env));
  destination.searchParams.set('monzo', 'authorized');
  destination.searchParams.set('artist', stored.alias);
  return Response.redirect(destination.toString(), 302);
}

async function connectionStatus(request, alias, env, fetchImpl = fetch) {
  await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoOAuthCallbackConfiguration(env);
  const config = artistMonzoConfig(alias, env);
  let record;
  try {
    record = await loadMonzoTokenRecord(env, config.artistId);
  } catch (error) {
    if (error instanceof MonzoTokenError && error.code === 'monzo_not_connected') {
      return json({
        ok: true,
        artist: alias,
        state: 'not_connected',
        account_label: null,
        webhook_registered: false,
      });
    }
    throw error;
  }

  if (
    record.alias !== alias
    || record.artistId !== config.artistId
    || record.providerAccountKey !== config.providerAccountKey
    || record.clientId !== env.MONZO_OAUTH_CLIENT_ID
  ) {
    throw new MonzoSecurityError('provider_route_invalid', 503);
  }

  return json({
    ok: true,
    artist: alias,
    state: record.connectionState,
    account_label: record.accountLabel || null,
    webhook_registered: Boolean(record.webhookId),
  });
}

async function listAccounts(request, alias, env, fetchImpl = fetch) {
  await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoAccountConfiguration(env);
  const config = artistMonzoConfig(alias, env);
  let record = await loadMonzoTokenRecord(env, config.artistId);
  const access = await accessFor(env, record, fetchImpl);
  record = access.record;
  try {
    await monzoWhoAmI(access.accessToken, record.clientId, record.userId, fetchImpl);
    const accounts = await listMonzoAccounts(access.accessToken, fetchImpl);
    return json({ ok: true, artist: alias, accounts });
  } catch (error) {
    if (error instanceof MonzoApiError && error.code === 'monzo_approval_pending') {
      await saveConnectionStateBestEffort(env, record, 'approval_pending');
    }
    throw error;
  }
}

async function readJsonBody(request, maxBytes = WEBHOOK_BODY_LIMIT) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new MonzoSecurityError('request_too_large', 413);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new MonzoSecurityError('json_required', 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new MonzoSecurityError('request_too_large', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new MonzoSecurityError('json_invalid');
  }
}

async function selectAccount(request, alias, env, fetchImpl = fetch) {
  await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoAccountConfiguration(env);
  const config = artistMonzoConfig(alias, env);
  const input = await readJsonBody(request, 4096);
  const proposedAccountId = typeof input?.account_id === 'string' ? input.account_id : '';
  const previous = await loadMonzoTokenRecord(env, config.artistId);
  if (previous.webhookId) throw new MonzoSecurityError('monzo_account_locked', 409);

  const access = await accessFor(env, previous, fetchImpl);
  const accounts = await listMonzoAccounts(access.accessToken, fetchImpl);
  const selected = accounts.find((account) => account.id === proposedAccountId);
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
  const previousRoute = previous.accountId && previous.webhookKey
    ? routeRecord(alias, config, previous.accountId)
    : null;

  try {
    await saveMonzoTokenRecord(env, updated);
    await env.MONZO_WEBHOOK_ROUTES.put(
      routeKey(updated.webhookKey),
      routeRecord(alias, config, selected.id),
    );
  } catch (error) {
    await saveMonzoTokenRecord(env, previous).catch(() => {});
    if (previousRoute) {
      await env.MONZO_WEBHOOK_ROUTES.put(routeKey(updated.webhookKey), previousRoute).catch(() => {});
    } else {
      await env.MONZO_WEBHOOK_ROUTES.delete(routeKey(updated.webhookKey)).catch(() => {});
    }
    throw error;
  }

  return json({
    ok: true,
    artist: alias,
    account: { id: selected.id, description: selected.description },
    webhook_registered: false,
  });
}

async function registerSelectedAccountWebhook(request, alias, env, fetchImpl = fetch) {
  await verifiedMonzoOwnerEmail(request, env, fetchImpl);
  assertMonzoAccountConfiguration(env);
  const config = artistMonzoConfig(alias, env);
  let record = await loadMonzoTokenRecord(env, config.artistId);

  if (
    record.alias !== alias
    || record.artistId !== config.artistId
    || record.providerAccountKey !== config.providerAccountKey
    || record.clientId !== env.MONZO_OAUTH_CLIENT_ID
  ) {
    throw new MonzoSecurityError('provider_route_invalid', 503);
  }
  if (!record.accountId || !record.webhookKey) {
    throw new MonzoSecurityError('monzo_account_not_selected', 409);
  }
  if (record.webhookId) {
    return json({
      ok: true,
      artist: alias,
      state: record.connectionState,
      account_label: record.accountLabel || null,
      webhook_registered: true,
      replayed: true,
    });
  }

  const route = await env.MONZO_WEBHOOK_ROUTES.get(routeKey(record.webhookKey), 'json');
  if (!validStoredRoute(route, record, config, alias)) {
    throw new MonzoSecurityError('provider_route_invalid', 503);
  }

  const access = await accessFor(env, record, fetchImpl);
  record = access.record;
  await monzoWhoAmI(access.accessToken, record.clientId, record.userId, fetchImpl);
  const accounts = await listMonzoAccounts(access.accessToken, fetchImpl);
  if (!accounts.some((account) => account.id === record.accountId)) {
    throw new MonzoSecurityError('monzo_account_not_allowed', 409);
  }

  const callbackUrl = monzoWebhookCallbackUrl(env, record.webhookKey);
  const webhook = await registerMonzoWebhook(
    access.accessToken,
    record.accountId,
    callbackUrl,
    fetchImpl,
  );
  const updated = {
    ...record,
    connectionState: 'connected',
    webhookId: webhook.id,
    webhookRegisteredAt: new Date().toISOString(),
  };

  try {
    await saveMonzoTokenRecord(env, updated);
  } catch (error) {
    await deleteMonzoWebhook(access.accessToken, webhook.id, fetchImpl).catch(() => false);
    throw error;
  }

  return json({
    ok: true,
    artist: alias,
    state: 'connected',
    account_label: updated.accountLabel || null,
    webhook_registered: true,
    replayed: false,
  });
}

function validWebhookHint(body) {
  const transactionId = body?.type === 'transaction.created' && typeof body?.data?.id === 'string'
    ? body.data.id
    : '';
  if (!/^tx_[A-Za-z0-9]+$/.test(transactionId)) return null;
  return {
    transactionId,
    accountId: typeof body?.data?.account_id === 'string' ? body.data.account_id : '',
  };
}

async function handleWebhook(request, webhookKey, env, fetchImpl = fetch) {
  if (env?.MONZO_RECONCILIATION_ENABLED !== 'true') {
    return json({ ok: false, code: 'reconciliation_disabled' }, 503);
  }
  if (!env?.MONZO_WEBHOOK_ROUTES) return json({ ok: false, code: 'monzo_not_configured' }, 503);

  const route = await env.MONZO_WEBHOOK_ROUTES.get(routeKey(webhookKey), 'json');
  if (!route?.artistId || !route?.accountId || !route?.providerAccountKey || !route?.alias) {
    return json({ ok: false, code: 'not_found' }, 404);
  }

  const body = await readJsonBody(request);
  const hint = validWebhookHint(body);
  if (!hint) return json({ ok: true, ignored: true }, 202);
  if (hint.accountId && hint.accountId !== route.accountId) return json({ ok: true, ignored: true }, 202);

  const config = artistMonzoConfig(route.alias, env);
  if (config.artistId !== route.artistId || config.providerAccountKey !== route.providerAccountKey) {
    return json({ ok: false, code: 'provider_route_invalid' }, 503);
  }
  const record = await loadMonzoTokenRecord(env, config.artistId);
  if (
    record.alias !== route.alias
    || record.artistId !== route.artistId
    || record.providerAccountKey !== route.providerAccountKey
    || record.accountId !== route.accountId
    || record.webhookKey !== webhookKey
  ) {
    return json({ ok: false, code: 'provider_route_invalid' }, 503);
  }

  const access = await accessFor(env, record, fetchImpl);
  const transaction = await retrieveMonzoTransaction(access.accessToken, hint.transactionId, fetchImpl);
  await verifyTransactionBelongsToAccount(
    access.accessToken,
    transaction,
    route.accountId,
    fetchImpl,
  );

  if (
    !Number.isSafeInteger(transaction.amount)
    || transaction.amount <= 0
    || String(transaction.currency).toUpperCase() !== 'GBP'
  ) {
    return json({ ok: true, ignored: true }, 202);
  }

  const supabase = createMonzoSupabaseClient(env, fetchImpl);
  await supabase.rpc('register_monzo_reconciliation_candidate', {
    p_provider_account_key: route.providerAccountKey,
    p_provider_event_id: `monzo:transaction.created:${transaction.id}`,
    p_provider_transaction_id: transaction.id,
    p_amount: transaction.amount / 100,
    p_currency: 'GBP',
    p_occurred_at: transaction.created,
  });

  return json({ ok: true }, 202);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json(monzoReadiness(env));

      const startMatch = url.pathname.match(new RegExp(`^/oauth/monzo/start/${ALIAS_PATH}$`));
      if (request.method === 'GET' && startMatch) return await startOAuth(request, startMatch[1], env);
      if (request.method === 'GET' && url.pathname === '/oauth/monzo/callback') {
        return await oauthCallback(request, env);
      }

      const statusMatch = url.pathname.match(new RegExp(`^/oauth/monzo/status/${ALIAS_PATH}$`));
      if (request.method === 'GET' && statusMatch) return await connectionStatus(request, statusMatch[1], env);

      const accountsMatch = url.pathname.match(new RegExp(`^/oauth/monzo/accounts/${ALIAS_PATH}$`));
      if (request.method === 'GET' && accountsMatch) return await listAccounts(request, accountsMatch[1], env);

      const selectMatch = url.pathname.match(new RegExp(`^/oauth/monzo/select-account/${ALIAS_PATH}$`));
      if (request.method === 'POST' && selectMatch) return await selectAccount(request, selectMatch[1], env);

      const registerMatch = url.pathname.match(new RegExp(`^/oauth/monzo/register-webhook/${ALIAS_PATH}$`));
      if (request.method === 'POST' && registerMatch) {
        return await registerSelectedAccountWebhook(request, registerMatch[1], env);
      }

      const webhookMatch = url.pathname.match(WEBHOOK_PATH);
      if (request.method === 'POST' && webhookMatch) return await handleWebhook(request, webhookMatch[1], env);

      return json({ ok: false, code: 'not_found' }, 404);
    } catch (error) {
      const safe = safeError(error);
      if (safe) return safe;
      if (error instanceof MonzoSupabaseError) return json({ ok: false, code: error.code }, 503);
      console.error('monzo api worker failure', JSON.stringify({
        code: typeof error?.code === 'string' ? error.code : 'monzo_connector_error',
      }));
      return json({ ok: false, code: 'monzo_connector_error' }, 500);
    }
  },
};

export const __testing = {
  startOAuth,
  oauthCallback,
  connectionStatus,
  listAccounts,
  selectAccount,
  registerSelectedAccountWebhook,
  handleWebhook,
  readJsonBody,
  validWebhookHint,
  validStoredRoute,
  accessFor,
};
