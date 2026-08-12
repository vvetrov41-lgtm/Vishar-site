import { saveMonzoTokenRecord } from './monzo-token-store.js';

const MONZO_API_ORIGIN = 'https://api.monzo.com';
const TOKEN_URL = `${MONZO_API_ORIGIN}/oauth2/token`;
const LOGOUT_URL = `${MONZO_API_ORIGIN}/oauth2/logout`;
const WHOAMI_URL = `${MONZO_API_ORIGIN}/ping/whoami`;
const ACCOUNTS_URL = `${MONZO_API_ORIGIN}/accounts`;
const TRANSACTIONS_URL = `${MONZO_API_ORIGIN}/transactions`;
const WEBHOOKS_URL = `${MONZO_API_ORIGIN}/webhooks`;
const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9]+$/;
const TRANSACTION_ID_PATTERN = /^tx_[A-Za-z0-9]+$/;
const WEBHOOK_ID_PATTERN = /^webhook_[A-Za-z0-9]+$/;

export class MonzoApiError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'MonzoApiError';
    this.code = code;
    this.status = status;
  }
}

async function jsonBody(response) {
  return response.json().catch(() => ({}));
}

function transientStatus(status) {
  return status === 429 || status >= 500;
}

function validateTokenResponse(response, body, expectedClientId) {
  if (
    !response.ok
    || typeof body?.access_token !== 'string'
    || !body.access_token
    || typeof body?.refresh_token !== 'string'
    || !body.refresh_token
    || body.token_type !== 'Bearer'
    || typeof body?.client_id !== 'string'
    || body.client_id !== expectedClientId
    || typeof body?.user_id !== 'string'
    || !body.user_id
    || !Number.isInteger(body?.expires_in)
    || body.expires_in < 60
    || body.expires_in > 86400
  ) {
    if (transientStatus(response.status)) throw new MonzoApiError('monzo_provider_unavailable', 503);
    throw new MonzoApiError('monzo_token_exchange_failed');
  }
  return body;
}

export async function exchangeMonzoAuthorizationCode(env, code, fetchImpl = fetch) {
  if (
    !env?.MONZO_OAUTH_CLIENT_ID
    || !env?.MONZO_OAUTH_CLIENT_SECRET
    || !env?.MONZO_OAUTH_REDIRECT_URI
    || typeof code !== 'string'
    || !code
  ) {
    throw new MonzoApiError('monzo_not_configured', 503);
  }

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.MONZO_OAUTH_CLIENT_ID,
      client_secret: env.MONZO_OAUTH_CLIENT_SECRET,
      redirect_uri: env.MONZO_OAUTH_REDIRECT_URI,
      code,
    }),
  });
  return validateTokenResponse(response, await jsonBody(response), env.MONZO_OAUTH_CLIENT_ID);
}

export async function refreshMonzoToken(env, refreshToken, fetchImpl = fetch) {
  if (
    !env?.MONZO_OAUTH_CLIENT_ID
    || !env?.MONZO_OAUTH_CLIENT_SECRET
    || typeof refreshToken !== 'string'
    || !refreshToken
  ) {
    throw new MonzoApiError('monzo_not_configured', 503);
  }

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.MONZO_OAUTH_CLIENT_ID,
      client_secret: env.MONZO_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  const body = await jsonBody(response);
  if (!response.ok && (response.status === 400 || response.status === 401)) {
    throw new MonzoApiError('monzo_reauthorization_required', 401);
  }
  return validateTokenResponse(response, body, env.MONZO_OAUTH_CLIENT_ID);
}

export async function ensureMonzoAccessToken(env, record, fetchImpl = fetch, now = Date.now()) {
  if (record.expiresAt > now + 60_000) return { accessToken: record.accessToken, record };

  const refreshTokenUsed = record.refreshToken;
  try {
    const tokens = await refreshMonzoToken(env, refreshTokenUsed, fetchImpl);
    if (tokens.user_id !== record.userId) throw new MonzoApiError('monzo_account_mismatch', 403);
    const updated = {
      ...record,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
      refreshedAt: new Date(now).toISOString(),
    };
    await saveMonzoTokenRecord(env, updated);
    return { accessToken: updated.accessToken, record: updated };
  } catch (error) {
    if (!(error instanceof MonzoApiError) || error.code !== 'monzo_reauthorization_required') throw error;

    // A concurrent request may already have rotated the one-time refresh token.
    // Re-read encrypted storage and accept only a newer, currently usable record.
    const raw = await env.MONZO_OAUTH_TOKENS.get(`artist:${record.artistId}`);
    if (raw) {
      const { decryptMonzoTokenRecord } = await import('./monzo-token-store.js');
      const latest = await decryptMonzoTokenRecord(raw, env.MONZO_TOKEN_ENCRYPTION_KEY);
      if (
        latest.refreshToken !== refreshTokenUsed
        && latest.userId === record.userId
        && latest.clientId === record.clientId
        && latest.expiresAt > now + 30_000
      ) {
        return { accessToken: latest.accessToken, record: latest };
      }
    }
    throw error;
  }
}

async function authenticatedJson(url, accessToken, fetchImpl, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  const body = await jsonBody(response);
  if (!response.ok) {
    if (response.status === 401) throw new MonzoApiError('monzo_reauthorization_required', 401);
    if (response.status === 403) throw new MonzoApiError('monzo_approval_pending', 409);
    if (transientStatus(response.status)) throw new MonzoApiError('monzo_provider_unavailable', 503);
    throw new MonzoApiError('monzo_provider_rejected');
  }
  return body;
}

export async function monzoWhoAmI(accessToken, expectedClientId, expectedUserId, fetchImpl = fetch) {
  const body = await authenticatedJson(WHOAMI_URL, accessToken, fetchImpl);
  if (
    body?.authenticated !== true
    || body.client_id !== expectedClientId
    || body.user_id !== expectedUserId
  ) {
    throw new MonzoApiError('monzo_account_mismatch', 403);
  }
  return { clientId: body.client_id, userId: body.user_id };
}

export async function listMonzoAccounts(accessToken, fetchImpl = fetch) {
  const body = await authenticatedJson(ACCOUNTS_URL, accessToken, fetchImpl);
  if (!Array.isArray(body?.accounts)) throw new MonzoApiError('monzo_provider_invalid_response');
  const accounts = body.accounts.map((account) => {
    const id = typeof account?.id === 'string' ? account.id : '';
    const description = typeof account?.description === 'string'
      ? account.description.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
      : '';
    if (!ACCOUNT_ID_PATTERN.test(id) || !description) {
      throw new MonzoApiError('monzo_provider_invalid_response');
    }
    return { id, description };
  });
  const unique = new Set(accounts.map((account) => account.id));
  if (unique.size !== accounts.length) throw new MonzoApiError('monzo_provider_invalid_response');
  return accounts;
}

export async function retrieveMonzoTransaction(accessToken, transactionId, fetchImpl = fetch) {
  if (!TRANSACTION_ID_PATTERN.test(String(transactionId || ''))) {
    throw new MonzoApiError('monzo_webhook_invalid', 400);
  }
  const body = await authenticatedJson(
    `${TRANSACTIONS_URL}/${encodeURIComponent(transactionId)}`,
    accessToken,
    fetchImpl,
  );
  const transaction = body?.transaction;
  if (
    !transaction
    || transaction.id !== transactionId
    || !Number.isInteger(transaction.amount)
    || typeof transaction.currency !== 'string'
    || typeof transaction.created !== 'string'
    || Number.isNaN(Date.parse(transaction.created))
  ) {
    throw new MonzoApiError('monzo_provider_invalid_response');
  }
  return transaction;
}

export async function verifyTransactionBelongsToAccount(
  accessToken,
  transaction,
  accountId,
  fetchImpl = fetch,
) {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) {
    throw new MonzoApiError('monzo_account_mismatch', 403);
  }
  if (transaction.account_id != null && transaction.account_id !== accountId) {
    throw new MonzoApiError('monzo_account_mismatch', 403);
  }

  const created = Date.parse(transaction.created);
  if (!Number.isFinite(created)) throw new MonzoApiError('monzo_provider_invalid_response');
  const since = new Date(created - 60_000).toISOString();
  const before = new Date(created + 60_000).toISOString();
  const url = new URL(TRANSACTIONS_URL);
  url.searchParams.set('account_id', accountId);
  url.searchParams.set('since', since);
  url.searchParams.set('before', before);
  url.searchParams.set('limit', '100');

  const body = await authenticatedJson(url.toString(), accessToken, fetchImpl);
  if (!Array.isArray(body?.transactions)) throw new MonzoApiError('monzo_provider_invalid_response');
  const verified = body.transactions.find((item) => item?.id === transaction.id);
  if (!verified) throw new MonzoApiError('monzo_account_mismatch', 403);
  if (
    verified.amount !== transaction.amount
    || verified.currency !== transaction.currency
    || verified.created !== transaction.created
  ) {
    throw new MonzoApiError('monzo_provider_invalid_response');
  }
  return transaction;
}

export async function registerMonzoWebhook(accessToken, accountId, callbackUrl, fetchImpl = fetch) {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) throw new MonzoApiError('monzo_account_mismatch', 403);
  const callback = new URL(callbackUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
    throw new MonzoApiError('monzo_webhook_configuration_invalid', 503);
  }

  const body = await authenticatedJson(WEBHOOKS_URL, accessToken, fetchImpl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account_id: accountId, url: callback.toString() }),
  });
  const webhook = body?.webhook;
  if (
    !webhook
    || !WEBHOOK_ID_PATTERN.test(String(webhook.id || ''))
    || webhook.account_id !== accountId
    || webhook.url !== callback.toString()
  ) {
    throw new MonzoApiError('monzo_provider_invalid_response');
  }
  return { id: webhook.id, accountId: webhook.account_id, url: webhook.url };
}

export async function deleteMonzoWebhook(accessToken, webhookId, fetchImpl = fetch) {
  if (!WEBHOOK_ID_PATTERN.test(String(webhookId || ''))) return false;
  const response = await fetchImpl(`${WEBHOOKS_URL}/${encodeURIComponent(webhookId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return response.ok || response.status === 404;
}

export async function logoutMonzoAccessToken(accessToken, fetchImpl = fetch) {
  if (!accessToken) return false;
  const response = await fetchImpl(LOGOUT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.ok;
}

export const __testing = {
  MONZO_API_ORIGIN,
  TOKEN_URL,
  WHOAMI_URL,
  ACCOUNTS_URL,
  TRANSACTIONS_URL,
  WEBHOOKS_URL,
  validateTokenResponse,
};
