import { drainTelegramOutbox } from './lib/telegram-drain.js';

function safeFailureCode(error, fallback = 'telegram_connector_error') {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : fallback;
}

async function runScheduledDrain(env) {
  try {
    const result = await drainTelegramOutbox(env);
    console.log('telegram outbox drain', JSON.stringify({
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      unrecorded: result.unrecorded,
    }));
  } catch (error) {
    console.error('telegram outbox drain failed', JSON.stringify({
      code: safeFailureCode(error),
    }));
    throw error;
  }
}

function assertGmailSummary(value) {
  if (!value || typeof value !== 'object') throw Object.assign(new Error('invalid Gmail drain summary'), { code: 'gmail_shared_drain_summary_invalid' });
  const fields = ['processed', 'sent', 'deduplicated', 'failed'];
  for (const field of fields) {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 20) {
      throw Object.assign(new Error('invalid Gmail drain summary'), { code: 'gmail_shared_drain_summary_invalid' });
    }
  }
  if (value.sent + value.deduplicated + value.failed > value.processed) {
    throw Object.assign(new Error('invalid Gmail drain summary'), { code: 'gmail_shared_drain_summary_invalid' });
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
      throw Object.assign(new Error('Gmail service binding unavailable'), { code: 'gmail_service_binding_unavailable' });
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

export default {
  scheduled(_controller, env, ctx) {
    const tasks = [];

    if (env.TELEGRAM_DRAIN_ENABLED === 'true') tasks.push(runScheduledDrain(env));
    else console.log('telegram outbox drain disabled');

    if (env.GMAIL_SHARED_DRAIN_ENABLED === 'true') tasks.push(runSharedGmailDrain(env));
    else console.log('gmail outbox shared drain disabled');

    if (!tasks.length) return;
    ctx.waitUntil(Promise.all(tasks));
  },
};

export const __testing = { runScheduledDrain, runSharedGmailDrain, assertGmailSummary, safeFailureCode };
