import {
  drainPersonalTelegramNotifications,
  drainTelegramOutbox,
} from './lib/telegram-drain.js';
import { runAutomationTick, runLifecycleFailureAlerts } from './lib/automation-tick.js';
import { ConfigurationError } from './lib/http.js';
import { createSupabaseClient, SupabaseError } from './lib/supabase.js';
import {
  sendSharedTelegramNotification,
  sharedTelegramBotToken,
} from './lib/telegram.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
} from './routes/appointment-client-action.js';

const LINK_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const CHAT_ID = /^-?[0-9]{1,20}$/;
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{24,128}$/;
const MAX_WEBHOOK_BYTES = 16 * 1024;

function safeFailureCode(error, fallback = 'telegram_connector_error') {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : fallback;
}

async function runScheduledDrain(env) {
  try {
    const outbox = await drainTelegramOutbox(env);
    const personal = await drainPersonalTelegramNotifications(env);
    console.log('telegram outbox drain', JSON.stringify({
      claimed: outbox.claimed,
      succeeded: outbox.succeeded,
      failed: outbox.failed,
      unrecorded: outbox.unrecorded,
      personalClaimed: personal.claimed,
      personalSucceeded: personal.succeeded,
      personalFailed: personal.failed,
      personalUnrecorded: personal.unrecorded,
      personalSkipped: personal.skipped === true,
    }));
    return { outbox, personal };
  } catch (error) {
    console.error('telegram outbox drain failed', JSON.stringify({
      code: safeFailureCode(error),
    }));
    throw error;
  }
}

function assertGmailSummary(value) {
  if (!value || typeof value !== 'object') {
    throw Object.assign(new Error('invalid Gmail drain summary'), {
      code: 'gmail_shared_drain_summary_invalid',
    });
  }
  const fields = ['processed', 'sent', 'deduplicated', 'failed'];
  for (const field of fields) {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 20) {
      throw Object.assign(new Error('invalid Gmail drain summary'), {
        code: 'gmail_shared_drain_summary_invalid',
      });
    }
  }
  if (value.sent + value.deduplicated + value.failed > value.processed) {
    throw Object.assign(new Error('invalid Gmail drain summary'), {
      code: 'gmail_shared_drain_summary_invalid',
    });
  }
  return {
    skipped: value.skipped === true,
    processed: value.processed,
    sent: value.sent,
    deduplicated: value.deduplicated,
    failed: value.failed,
  };
}

async function runSharedGmailDrain(env) {
  try {
    if (!env?.GMAIL_SERVICE || typeof env.GMAIL_SERVICE.drainApprovedEmailOutbox !== 'function') {
      throw Object.assign(new Error('Gmail service binding unavailable'), {
        code: 'gmail_service_binding_unavailable',
      });
    }
    const summary = assertGmailSummary(await env.GMAIL_SERVICE.drainApprovedEmailOutbox());
    console.log('gmail outbox shared drain', JSON.stringify(summary));
    return summary;
  } catch (error) {
    console.error('gmail outbox shared drain failed', JSON.stringify({
      code: safeFailureCode(error, 'gmail_shared_drain_error'),
    }));
    throw error;
  }
}

async function runScheduledAutomationTick(env) {
  try {
    const summary = await runAutomationTick(env);
    console.log('automation tick', JSON.stringify(summary));
    return summary;
  } catch (error) {
    console.error('automation tick failed', JSON.stringify({
      code: safeFailureCode(error, 'automation_tick_error'),
    }));
    throw error;
  }
}

async function settleScheduledTasks(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

async function runScheduledLifecycleAlerts(env) {
  try {
    const summary = await runLifecycleFailureAlerts(env);
    console.log('lifecycle failure alerts', JSON.stringify(summary));
    return summary;
  } catch (error) {
    console.error('lifecycle failure alerts failed', JSON.stringify({
      code: safeFailureCode(error, 'lifecycle_alert_error'),
    }));
    throw error;
  }
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function linkingConfigured(env) {
  return env?.TELEGRAM_LINKING_ENABLED === 'true'
    && WEBHOOK_SECRET.test(typeof env?.TELEGRAM_WEBHOOK_SECRET === 'string'
      ? env.TELEGRAM_WEBHOOK_SECRET.trim()
      : '')
    && Boolean(sharedTelegramBotToken(env));
}

function isWebhookPath(request) {
  try {
    const url = new URL(request?.url ?? '');
    return url.pathname === '/webhook' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function readWebhookJson(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_WEBHOOK_BYTES) throw new Error('body_too_large');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('invalid_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_json');
  return value;
}

function linkingMessage(update) {
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const match = /^\/start(?:@[A-Za-z][A-Za-z0-9_]{4,31})?\s+([A-Za-z0-9_-]{20,64})$/.exec(text);
  const chatId = String(message?.chat?.id ?? '');
  const chatType = typeof message?.chat?.type === 'string' ? message.chat.type : '';
  if (!match || !LINK_TOKEN.test(match[1]) || !CHAT_ID.test(chatId)) return null;
  if (!['private', 'group', 'supergroup'].includes(chatType)) return null;
  return { token: match[1], chatId, chatType };
}

function shouldRetryLinkingFailure(error) {
  if (error instanceof ConfigurationError) return true;
  return error instanceof SupabaseError && (error.status === 429 || error.status >= 500);
}

async function handleLinkingWebhook(request, env, fetchImpl = fetch) {
  if (!linkingConfigured(env)) return json(404, { error: 'not_found' });
  if (!isWebhookPath(request)) return json(404, { error: 'not_found' });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const expected = env.TELEGRAM_WEBHOOK_SECRET.trim();
  const supplied = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (supplied !== expected) return json(401, { error: 'webhook_unauthorized' });

  let update;
  try { update = await readWebhookJson(request); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_json';
    if (reason === 'body_too_large') return json(413, { error: reason });
    if (reason === 'unsupported_media_type') return json(415, { error: reason });
    return json(400, { error: 'invalid_json' });
  }

  const link = linkingMessage(update);
  if (!link) {
    // Telegram retries non-2xx webhook responses. Unknown updates are not an
    // error and must not create a retry loop.
    return json(200, { ok: true });
  }

  try {
    const supabase = createSupabaseClient(env, fetchImpl);
    await supabase.rpc('service_complete_telegram_link', {
      p_token: link.token,
      p_chat_id: link.chatId,
      p_chat_type: link.chatType,
    });
  } catch (error) {
    // A guessed, stale, revoked or already-consumed challenge must not become
    // an oracle: database 4xx responses are acknowledged exactly like success.
    // Transient backend/config failures are different - returning 503 lets
    // Telegram retry the same update while the still-unconsumed challenge is
    // valid instead of silently losing the connection attempt.
    if (shouldRetryLinkingFailure(error)) {
      return json(503, { error: 'temporarily_unavailable' });
    }
    return json(200, { ok: true });
  }

  // Confirmation is best-effort and happens only after durable completion. A
  // Telegram send failure must not ask Telegram to replay the /start command,
  // because that could only hit an already-consumed challenge.
  await sendSharedTelegramNotification(
    env,
    link.chatId,
    'Vishar CRM: Telegram connected.',
    fetchImpl,
  );

  return json(200, { ok: true });
}

export default {
  fetch(request, env) {
    // Appointment action capabilities are independent of Telegram linking.
    // The namespace is owned explicitly so malformed/expired links cannot fall
    // through to the webhook surface, and browser authority remains the opaque
    // one-time token handled by the shared backend-only Supabase client.
    if (isAppointmentClientActionPath(request)) {
      return handleAppointmentClientActionRequest(request, env);
    }
    return handleLinkingWebhook(request, env);
  },
  scheduled(_controller, env, ctx) {
    const tasks = [];

    if (env.TELEGRAM_DRAIN_ENABLED === 'true') tasks.push(runScheduledDrain(env));
    else console.log('telegram outbox drain disabled');

    // Production already shares this cron with the Gmail Worker. Keep each
    // bounded task independent so one failure cannot suppress another task's
    // execution or release the Worker lifetime while a sibling is still
    // running. The first failure is rethrown only after every task settles.
    if (env.GMAIL_SHARED_DRAIN_ENABLED === 'true') tasks.push(runSharedGmailDrain(env));
    else console.log('gmail outbox shared drain disabled');

    if (env.AUTOMATION_TICK_ENABLED === 'true') {
      tasks.push(runScheduledAutomationTick(env));
      // Independent of the tick and provider drains: observe already-recorded
      // failures even if another responsibility fails during this cron window.
      tasks.push(runScheduledLifecycleAlerts(env));
    }
    else console.log('automation tick disabled');

    if (!tasks.length) return;
    ctx.waitUntil(settleScheduledTasks(tasks));
  },
};

export const __testing = {
  assertGmailSummary,
  handleLinkingWebhook,
  isWebhookPath,
  linkingConfigured,
  linkingMessage,
  readWebhookJson,
  runScheduledAutomationTick,
  runScheduledDrain,
  runSharedGmailDrain,
  safeFailureCode,
  settleScheduledTasks,
  shouldRetryLinkingFailure,
};
