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

function classifyTokenExchangeRejection(response, body) {
  if (transientStatus(response.status)) {
    return new MonzoApiError('monzo_provider_unavailable', 503);
  }

  const providerCode = typeof body?.code === 'string' ? body.code.toLowerCase() : '';
  const legacyError = typeof body?.error === 'string' ? body.error.toLowerCase() : '';
  const signal = `${providerCode} ${legacyError}`;

  // Never expose the provider's raw code/message to the browser. Only map a
  // small set of token-endpoint failure shapes to stable internal categories.
  if (signal.includes('client_not_enabled')) {
    return new MonzoApiError('monzo_oauth_client_not_enabled');
  }
  if (signal.includes('redirect_uri') || signal.includes('redirect')) {
    return new MonzoApiError('monzo_oauth_redirect_uri_rejected');
  }
  if (
    signal.includes('could_not_authenticate')
    || signal.includes('invalid_client')
    || signal.includes('client_secret')
    || signal.includes('client_credentials')
    || signal.includes('client_id')
  ) {
    return new MonzoApiError('monzo_oauth_client_rejected');
  }
  if (
    signal.includes('authorization_code')
    || signal.includes('invalid_grant')
    || signal.includes('bad_param.code')
    || signal.includes('invalid_code')
  ) {
    return new MonzoApiError('monzo_authorization_code_rejected');
  }
  if (response.status === 401) {
    return new MonzoApiError('monzo_token_exchange_unauthorized');
  }
  if (response.status === 400) {
    return new MonzoApiError('monzo_token_exchange_bad_request');
  }
  if (response.status === 403) {
    return new MonzoApiError('monzo_token_exchange_forbidden');
  }
  return new MonzoApiError('monzo_token_exchange_failed');
}

function validateTokenResponse(response, body, expectedClientId) {
  if (!response.ok) throw classifyTokenExchangeRejection(response, body);
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new MonzoApiError('monzo_access_token_missing');
  }
  if (typeof body?.refresh_token !== 'string' || !body.refresh_token) {
    throw new MonzoApiError('monzo_refresh_token_missing');
  }
  if (typeof body?.client_id !== 'string' || body.client_id !== expectedClientId) {
    throw new MonzoApiError('monzo_token_client_mismatch');
  }
  if (typeof body?.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
    throw new MonzoApiError('monzo_token_type_invalid');
  }
  if (typeof body?.user_id !== 'string' || !body.user_id) {
    throw new MonzoApiError('monzo_user_id_missing');
  }
  // OAuth 2.0 defines expires_in as a lifetime in seconds but does not cap it.
  // Reject malformed/non-positive lifetimes, but do not invent a provider
  // maximum that could reject an otherwise valid Monzo access token.
  if (!Number.isInteger(body?.expires_in) || body.expires_in < 60) {
    throw new MonzoApiError('monzo_token_expiry_invalid');
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
  if (!env?.MONZO_OAUTH_CLIENT_ID || record?.clientId !== env.MONZO_OAUTH_CLIENT_ID) {
    throw new MonzoApiError('monzo_account_mismatch', 403);
  }
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
    // Re-read encrypted storage and accept only a newer record bound to the
    // same artist/user and the currently configured OAuth client.
    const raw = await env.MONZO_OAUTH_TOKENS.get(`artist:${record.artistId}`);
    if (raw) {
      const { decryptMonzoTokenRecord } = await import('./monzo-token-store.js');
      const latest = await decryptMonzoTokenRecord(raw, env.MONZO_TOKEN_ENCRYPTION_KEY);
      if (
        latest.artistId === record.artistId
        && latest.refreshToken !== refreshTokenUsed
        && latest.userId === record.userId
        && latest.clientId === env.MONZO_OAUTH_CLIENT_ID
        && latest.expiresAt > now + 30_000
      ) {
        return { accessToken: latest.accessToken, record: latest };
      }
    }
    throw error;
  }
}

// Monzo documents 401 for "not authenticated", but the live API answers an
// invalid or expired bearer token with HTTP 400 and a body carrying
// `code: "bad_request.invalid_token"`. Treating that as a generic rejection
// would strand a connection that only needs a refresh or a reauthorisation, so
// the token-shaped 400 is classified alongside 401.
function invalidTokenBody(body) {
  const code = typeof body?.code === 'string' ? body.code : '';
  const legacy = typeof body?.error === 'string' ? body.error : '';
  return code.includes('invalid_token') || legacy.includes('invalid_token');
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
    if (response.status === 400 && invalidTokenBody(body)) {
      throw new MonzoApiError('monzo_reauthorization_required', 401);
    }
    // Monzo grants an access token no permissions until the account owner
    // approves the connection in the Monzo app, and reports that as a 403.
    if (response.status === 403) throw new MonzoApiError('monzo_approval_pending', 409);
    if (transientStatus(response.status)) throw new MonzoApiError('monzo_provider_unavailable', 503);
    throw new MonzoApiError('monzo_provider_rejected');
  }
  return body;
}

export async function monzoWhoAmI(accessToken, expectedClientId, expectedUserId, fetchImpl = fetch) {
  try {
    const body = await authenticatedJson(WHOAMI_URL, accessToken, fetchImpl);
    if (
      body?.authenticated !== true
      || body.client_id !== expectedClientId
      || body.user_id !== expectedUserId
    ) {
      throw new MonzoApiError('monzo_account_mismatch', 403);
    }
    return {
      clientId: body.client_id,
      userId: body.user_id,
      approvalPending: false,
    };
  } catch (error) {
    // Monzo may issue the access/refresh-token pair before the account owner
    // finishes the separate SCA approval in the Monzo app. At that point the
    // token endpoint has already bound the token to the expected client/user,
    // while /ping/whoami is expected to answer 403 because the token has no
    // permissions yet. Preserve the encrypted token for the callback instead
    // of logging it out. Every account/webhook path still performs a provider
    // request after this probe, so a pending token remains unable to select an
    // account, register a webhook or create a reconciliation candidate.
    if (error instanceof MonzoApiError && error.code === 'monzo_approval_pending') {
      return {
        clientId: expectedClientId,
        userId: expectedUserId,
        approvalPending: true,
      };
    }
    throw error;
  }
}

export async function listMonzoAccounts(accessToken, fetchImpl = fetch) {
  const body = await authenticatedJson(ACCOUNTS_URL, accessToken, fetchImpl);
  if (!Array.isArray(body?.accounts)) throw new MonzoApiError('monzo_provider_invalid_response');
  // `/accounts` also returns closed and non-retail accounts. They are absent
  // from the documented schema but present in real responses, and offering a
  // closed account as a deposit destination would silently fail later.
  const accounts = body.accounts.filter((account) => account?.closed !== true).map((account) => {
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

// Monzo documents that positive amounts are credits, that top-ups carry
// `is_load: true`, that refunds/reversals/chargebacks are positive amounts with
// `is_load: false` and a merchant, and that `decline_reason` is present only on
// declined transactions. `scheme` is undocumented for the Developer API but is
// the only discriminator between an inbound bank transfer and pot/card
// movement, so it is allow-listed when the provider supplies it.
const INBOUND_TRANSFER_SCHEMES = new Set([
  'payport_faster_payments',
  'faster_payments',
  'bacs',
  'chaps',
  'sepa',
  'p2p_payment',
]);

export function isIncomingGbpTransferCredit(transaction) {
  if (!transaction || typeof transaction !== 'object') return false;
  if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0) return false;
  if (String(transaction.currency || '').toUpperCase() !== 'GBP') return false;
  if (transaction.decline_reason != null && transaction.decline_reason !== '') return false;
  if (transaction.is_load === true) return false;
  if (transaction.merchant != null) return false;
  if (typeof transaction.scheme === 'string' && transaction.scheme) {
    return INBOUND_TRANSFER_SCHEMES.has(transaction.scheme);
  }
  return true;
}

export async function registerMonzoWebhook(accessToken, accountId, callbackUrl, fetchImpl = fetch) {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) throw new MonzoApiError('monzo_account_mismatch', 403);
  const callback = new URL(callbackUrl);
  if (
    callback.protocol !== 'https:'
    || callback.username
    || callback.password
    || callback.port
    || callback.search
    || callback.hash
  ) {
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
  INBOUND_TRANSFER_SCHEMES,
  classifyTokenExchangeRejection,
  validateTokenResponse,
  invalidTokenBody,
};