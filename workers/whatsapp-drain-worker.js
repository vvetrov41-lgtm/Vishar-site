import { drainWhatsappOutbox } from './lib/whatsapp-drain.js';
import { maintainWhatsappBookingTemplates } from './lib/whatsapp-booking-templates.js';

// Outbound WhatsApp drain. It has no public surface: workers_dev and preview
// URLs are off and the Worker has no route. Production invokes it from the
// shared scheduler's existing cron through a Service Binding, because the
// Cloudflare account has no spare cron trigger; the synthetic
// whatsapp.internal host below is only reachable that way and is checked
// exactly, like tattooai.internal.
//
// Sending stays gated: `WHATSAPP_DRAIN_ENABLED` must be exactly "true" (the
// tracked configuration keeps it "false"; only the guarded production deploy
// enables it), and each message is still claimed, leased, intent-marked and
// acknowledged by the database.

export const INTERNAL_DRAIN_HOST = 'whatsapp.internal';
export const INTERNAL_DRAIN_PATH = '/internal/whatsapp/drain';

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

export function isInternalDrainRequest(request) {
  try {
    const url = new URL(request?.url ?? '');
    return request.method === 'POST'
      && url.protocol === 'https:'
      && url.hostname === INTERNAL_DRAIN_HOST
      && url.pathname === INTERNAL_DRAIN_PATH
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

export async function handleInternalDrain(
  env,
  drain = drainWhatsappOutbox,
  maintainTemplates = maintainWhatsappBookingTemplates,
) {
  if (env?.VISHAR_ENVIRONMENT !== 'production' || env?.WHATSAPP_DRAIN_ENABLED !== 'true') {
    return json({ ok: true, skipped: true, claimed: 0, succeeded: 0, failed: 0, unrecorded: 0 });
  }

  if (env?.WHATSAPP_BOOKING_TEMPLATE_MAINTENANCE_ENABLED === 'true') {
    try {
      const templateSummary = await maintainTemplates(env);
      console.log('whatsapp booking template maintenance', JSON.stringify({
        targets: templateSummary.targets,
        checked: templateSummary.checked,
        created: templateSummary.created,
        approved: templateSummary.approved,
        failed: templateSummary.failed,
      }));
    } catch (error) {
      console.error('whatsapp booking template maintenance failed', JSON.stringify({
        code: safeFailureCode(error),
      }));
      // Template provisioning is independent of ordinary outbound draining.
      // Existing WhatsApp replies must keep flowing if Meta template admin is
      // temporarily unavailable.
    }
  }

  try {
    const result = await drain(env);
    const summary = {
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      unrecorded: result.unrecorded,
    };
    console.log('whatsapp outbox drain', JSON.stringify(summary));
    return json({ ok: true, skipped: false, ...summary });
  } catch (error) {
    const errorCode = safeFailureCode(error);
    console.error('whatsapp outbox drain failed', JSON.stringify({ code: errorCode }));
    return json({ ok: false, errorCode }, 200);
  }
}

export default {
  fetch(request, env) {
    if (!isInternalDrainRequest(request)) return new Response('Not found', { status: 404 });
    return handleInternalDrain(env);
  },
  scheduled(_controller, env, ctx) {
    if (env.WHATSAPP_DRAIN_ENABLED !== 'true') {
      console.log('whatsapp outbox drain disabled');
      return;
    }
    ctx.waitUntil(runScheduledDrain(env));
  },
};

export const __testing = { runScheduledDrain, safeFailureCode, handleInternalDrain, isInternalDrainRequest };
