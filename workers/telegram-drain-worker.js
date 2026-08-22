import {
  drainPersonalTelegramNotifications,
  drainTelegramOutbox,
} from './lib/telegram-drain.js';
import { createSupabaseClient } from './lib/supabase.js';
import { sendSharedTelegramNotification } from './lib/telegram.js';

const LINK_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const CHAT_ID = /^-?[0-9]{1,20}$/;
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{24,128}$/;
const MAX_WEBHOOK_BYTES = 16 * 1024;

function safeFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'telegram_connector_error';
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
      : '');
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

async function handleLinkingWebhook(request, env, fetchImpl = fetch) {
  if (!linkingConfigured(env)) return json(404, { error: 'not_found' });
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
    // Confirmation is best-effort. Link completion is the durable operation;
    // a provider outage must not consume the challenge twice on retry.
    await sendSharedTelegramNotification(
      env,
      link.chatId,
      'Vishar CRM: Telegram connected.',
      fetchImpl,
    );
  } catch {
    // Do not expose whether a guessed token exists. A stale or revoked
    // challenge receives the same provider-level acknowledgement as any other
    // invalid start parameter and will not be retried indefinitely.
  }

  return json(200, { ok: true });
}

export default {
  fetch(request, env) {
    return handleLinkingWebhook(request, env);
  },
  scheduled(_controller, env, ctx) {
    if (env.TELEGRAM_DRAIN_ENABLED !== 'true') {
      console.log('telegram outbox drain disabled');
      return;
    }
    ctx.waitUntil(runScheduledDrain(env));
  },
};

export const __testing = {
  handleLinkingWebhook,
  linkingConfigured,
  linkingMessage,
  readWebhookJson,
  runScheduledDrain,
  safeFailureCode,
};
