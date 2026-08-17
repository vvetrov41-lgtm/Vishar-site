import {
  ensureMonzoAccessToken,
  isIncomingGbpTransferCredit,
  monzoWhoAmI,
  retrieveMonzoTransaction,
  verifyTransactionBelongsToAccount,
  MonzoApiError,
} from './monzo-api-client.js';
import { artistMonzoConfig, MonzoSecurityError } from './monzo-oauth-security.js';
import { createMonzoSupabaseClient } from './monzo-supabase.js';
import { loadMonzoTokenRecord } from './monzo-token-store.js';

const TRANSACTIONS_URL = 'https://api.monzo.com/transactions';
const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9]+$/;
const TRANSACTION_ID_PATTERN = /^tx_[A-Za-z0-9]+$/;
const RECOVERY_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_LISTED_TRANSACTIONS = 100;
const MAX_RECOVERY_CANDIDATES = 10;

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

function providerInvalidToken(body) {
  const code = typeof body?.code === 'string' ? body.code : '';
  const legacy = typeof body?.error === 'string' ? body.error : '';
  return code.includes('invalid_token') || legacy.includes('invalid_token');
}

function assertConnectedRecord(record, config, alias) {
  if (
    !record
    || record.alias !== alias
    || record.artistId !== config.artistId
    || record.providerAccountKey !== config.providerAccountKey
    || !ACCOUNT_ID_PATTERN.test(String(record.accountId || ''))
    || typeof record.webhookId !== 'string'
    || !record.webhookId
  ) {
    throw new MonzoSecurityError('provider_route_invalid', 503);
  }
}

async function listRecentTransactionHints(accessToken, accountId, now, fetchImpl) {
  if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) {
    throw new MonzoApiError('monzo_account_mismatch', 403);
  }
  if (!Number.isSafeInteger(now) || now <= RECOVERY_WINDOW_MS) {
    throw new MonzoApiError('monzo_provider_invalid_response');
  }

  const url = new URL(TRANSACTIONS_URL);
  url.searchParams.set('account_id', accountId);
  url.searchParams.set('since', new Date(now - RECOVERY_WINDOW_MS).toISOString());
  url.searchParams.set('before', new Date(now + 60_000).toISOString());
  url.searchParams.set('limit', String(MAX_LISTED_TRANSACTIONS));

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    if (response.status === 401 || (response.status === 400 && providerInvalidToken(body))) {
      throw new MonzoApiError('monzo_reauthorization_required', 401);
    }
    if (response.status === 403) throw new MonzoApiError('monzo_approval_pending', 409);
    if (response.status === 429 || response.status >= 500) {
      throw new MonzoApiError('monzo_provider_unavailable', 503);
    }
    throw new MonzoApiError('monzo_provider_rejected');
  }
  if (!Array.isArray(body?.transactions)) {
    throw new MonzoApiError('monzo_provider_invalid_response');
  }

  const seen = new Set();
  const hints = [];
  for (const item of body.transactions) {
    const id = typeof item?.id === 'string' ? item.id : '';
    const created = typeof item?.created === 'string' ? Date.parse(item.created) : NaN;
    if (!TRANSACTION_ID_PATTERN.test(id) || !Number.isFinite(created) || seen.has(id)) continue;
    seen.add(id);
    hints.push({ id, created, incomingHint: isIncomingGbpTransferCredit(item) });
  }

  return {
    scanned: body.transactions.length,
    hints: hints
      .filter((item) => item.incomingHint)
      .sort((left, right) => right.created - left.created)
      .slice(0, MAX_RECOVERY_CANDIDATES),
  };
}

export async function syncRecentMonzoReconciliation(alias, env, fetchImpl = fetch, now = Date.now()) {
  const config = artistMonzoConfig(alias, env);
  const initial = await loadMonzoTokenRecord(env, config.artistId);
  assertConnectedRecord(initial, config, alias);

  const access = await ensureMonzoAccessToken(env, initial, fetchImpl, now);
  assertConnectedRecord(access.record, config, alias);
  const identity = await monzoWhoAmI(
    access.accessToken,
    access.record.clientId,
    access.record.userId,
    fetchImpl,
  );
  if (identity.approvalPending) throw new MonzoApiError('monzo_approval_pending', 409);

  const listed = await listRecentTransactionHints(
    access.accessToken,
    access.record.accountId,
    now,
    fetchImpl,
  );
  const supabase = createMonzoSupabaseClient(env, fetchImpl);

  let verified = 0;
  let registered = 0;
  let replayed = 0;
  for (const hint of listed.hints) {
    const transaction = await retrieveMonzoTransaction(access.accessToken, hint.id, fetchImpl);
    await verifyTransactionBelongsToAccount(
      access.accessToken,
      transaction,
      access.record.accountId,
      fetchImpl,
    );
    if (!isIncomingGbpTransferCredit(transaction)) continue;
    verified += 1;

    const result = await supabase.rpc('register_monzo_reconciliation_candidate', {
      p_provider_account_key: config.providerAccountKey,
      p_provider_event_id: `monzo:transaction.created:${transaction.id}`,
      p_provider_transaction_id: transaction.id,
      p_amount: transaction.amount / 100,
      p_currency: 'GBP',
      p_occurred_at: transaction.created,
    });
    if (result?.replayed === true) replayed += 1;
    else registered += 1;
  }

  return {
    scanned: listed.scanned,
    eligible: listed.hints.length,
    verified,
    registered,
    replayed,
  };
}

export const __testing = {
  RECOVERY_WINDOW_MS,
  MAX_LISTED_TRANSACTIONS,
  MAX_RECOVERY_CANDIDATES,
  listRecentTransactionHints,
  assertConnectedRecord,
};
