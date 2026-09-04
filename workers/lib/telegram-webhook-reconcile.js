import { sharedTelegramBotToken } from './telegram.js';

const EXPECTED_PRODUCTION_WEBHOOK_URL = 'https://telegram.vishartattoo.com/webhook';
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{24,128}$/;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function safeWebhookInfo(info) {
  return {
    matchesExpected: info?.url === EXPECTED_PRODUCTION_WEBHOOK_URL,
    pendingUpdateCount: Number.isSafeInteger(info?.pending_update_count) && info.pending_update_count >= 0
      ? info.pending_update_count
      : 0,
    lastErrorDate: Number.isSafeInteger(info?.last_error_date) && info.last_error_date >= 0
      ? info.last_error_date
      : null,
  };
}

async function telegramApi(botToken, method, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      redirect: 'error',
    });
  } catch {
    throw failure('telegram_webhook_provider_unreachable');
  }

  if (response.status === 401) throw failure('telegram_webhook_bot_token_invalid');
  if (response.status === 429 || response.status >= 500) {
    throw failure('telegram_webhook_provider_unavailable');
  }
  if (!response.ok) throw failure('telegram_webhook_provider_rejected');

  const payload = await response.json().catch(() => null);
  if (payload?.ok !== true) throw failure('telegram_webhook_provider_response_invalid');
  return payload.result;
}

export function productionWebhookReconcileConfigured(env) {
  if (env?.VISHAR_ENVIRONMENT !== 'production') return false;
  if (env?.TELEGRAM_LINKING_ENABLED !== 'true') return false;
  if (!sharedTelegramBotToken(env)) return false;
  const secret = typeof env?.TELEGRAM_WEBHOOK_SECRET === 'string'
    ? env.TELEGRAM_WEBHOOK_SECRET.trim()
    : '';
  return WEBHOOK_SECRET.test(secret);
}

export async function reconcileProductionTelegramWebhook(env, fetchImpl = fetch) {
  if (env?.VISHAR_ENVIRONMENT !== 'production' || env?.TELEGRAM_LINKING_ENABLED !== 'true') {
    return { skipped: true, changed: false, matchesExpected: false, pendingUpdateCount: 0, lastErrorDate: null };
  }

  const botToken = sharedTelegramBotToken(env);
  const secret = typeof env?.TELEGRAM_WEBHOOK_SECRET === 'string'
    ? env.TELEGRAM_WEBHOOK_SECRET.trim()
    : '';
  if (!botToken || !WEBHOOK_SECRET.test(secret)) {
    throw failure('telegram_webhook_reconcile_not_configured');
  }

  const before = safeWebhookInfo(await telegramApi(botToken, 'getWebhookInfo', {}, fetchImpl));
  if (before.matchesExpected) return { skipped: false, changed: false, ...before };

  await telegramApi(botToken, 'setWebhook', {
    url: EXPECTED_PRODUCTION_WEBHOOK_URL,
    secret_token: secret,
    allowed_updates: ['message'],
    // Preserve any /start update Telegram queued while the production webhook
    // was missing. Reconciliation must repair routing, not discard user input.
    drop_pending_updates: false,
  }, fetchImpl);

  const after = safeWebhookInfo(await telegramApi(botToken, 'getWebhookInfo', {}, fetchImpl));
  if (!after.matchesExpected) throw failure('telegram_webhook_reconcile_readback_mismatch');
  return { skipped: false, changed: true, ...after };
}

export const __testing = {
  EXPECTED_PRODUCTION_WEBHOOK_URL,
  WEBHOOK_SECRET,
  safeWebhookInfo,
  telegramApi,
};
