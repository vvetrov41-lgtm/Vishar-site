import { drainWhatsappOutbox } from './lib/whatsapp-drain.js';

// Scheduled-only connector. There is deliberately no `fetch` handler: the
// drain has no public surface, and an operator-triggered run imports the
// library directly from a guarded workflow instead.
//
// Sending is gated twice. `WHATSAPP_DRAIN_ENABLED` must be exactly "true", and
// the tracked Wrangler configuration declares no cron at all, so the platform
// never invokes `scheduled()` in the first place. Enabling production requires
// both to change through a separately approved activation.

function safeFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'whatsapp_connector_error';
}

async function runScheduledDrain(env) {
  try {
    const result = await drainWhatsappOutbox(env);
    // Counts only. No conversation, contact number, message body or provider
    // identifier is ever logged.
    console.log('whatsapp outbox drain', JSON.stringify({
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      unrecorded: result.unrecorded,
    }));
  } catch (error) {
    console.error('whatsapp outbox drain failed', JSON.stringify({
      code: safeFailureCode(error),
    }));
    throw error;
  }
}

export default {
  scheduled(_controller, env, ctx) {
    if (env.WHATSAPP_DRAIN_ENABLED !== 'true') {
      console.log('whatsapp outbox drain disabled');
      return;
    }
    ctx.waitUntil(runScheduledDrain(env));
  },
};

export const __testing = { runScheduledDrain, safeFailureCode };
