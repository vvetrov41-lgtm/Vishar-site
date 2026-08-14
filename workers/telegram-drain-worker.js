import { drainTelegramOutbox } from './lib/telegram-drain.js';

function safeFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'telegram_connector_error';
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

export default {
  scheduled(_controller, env, ctx) {
    if (env.TELEGRAM_DRAIN_ENABLED !== 'true') {
      console.log('telegram outbox drain disabled');
      return;
    }
    ctx.waitUntil(runScheduledDrain(env));
  },
};

export const __testing = { runScheduledDrain, safeFailureCode };
