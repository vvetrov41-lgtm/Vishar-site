import monzoApi from './monzo-api.js';

const WEBHOOK_PATH = /^\/webhooks\/monzo\/([A-Za-z0-9_-]{43,128})$/;
const RATE_LIMIT_KEY = 'monzo-provider-webhook';

const securityHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status) {
  return Response.json(body, { status, headers: securityHeaders });
}

export async function enforceMonzoWebhookRateLimit(env) {
  const limiter = env?.MONZO_WEBHOOK_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') {
    return json({ ok: false, code: 'webhook_rate_limit_unconfigured' }, 503);
  }

  let decision;
  try {
    decision = await limiter.limit({ key: RATE_LIMIT_KEY });
  } catch {
    return json({ ok: false, code: 'webhook_rate_limit_unavailable' }, 503);
  }

  if (!decision?.success) {
    return json({ ok: false, code: 'rate_limited' }, 429);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookMatch = request.method === 'POST' && url.pathname.match(WEBHOOK_PATH);

    // Reconciliation is deliberately dormant by default. Requiring the limiter
    // only when the public reconciliation path is enabled keeps the inert
    // foundation testable while making a live public webhook fail closed if the
    // isolated Worker rate-limit binding is missing or unavailable.
    if (webhookMatch && env?.MONZO_RECONCILIATION_ENABLED === 'true') {
      const limited = await enforceMonzoWebhookRateLimit(env);
      if (limited) return limited;
    }

    return monzoApi.fetch(request, env);
  },
};

export const __testing = {
  WEBHOOK_PATH,
  RATE_LIMIT_KEY,
};
