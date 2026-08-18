import monzoApi from './monzo-api.js';
import paymentRedirect from './payment-redirect.js';

const WEBHOOK_PATH = /^\/webhooks\/monzo\/([A-Za-z0-9_-]{43,128})$/;
const PAYMENT_HOST = 'vishartattoo.com';
const PAYMENT_PATH_PREFIX = '/pay-by-bank-transfer';
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

    // Cloudflare route matching has a documented specificity issue around a
    // trailing `/*`. Production therefore uses `/pay-by-bank-transfer*` and
    // lets this gateway send every request caught by that bounded prefix into
    // the strict payment handler. The payment handler still requires the exact
    // `/pay-by-bank-transfer/<opaque UUID>` shape, GET, no query string, rate
    // limiting, and the backend-only resolver before returning a Monzo URL.
    if (url.hostname === PAYMENT_HOST && url.pathname.startsWith(PAYMENT_PATH_PREFIX)) {
      return paymentRedirect.fetch(request, env);
    }

    const webhookMatch = request.method === 'POST' && url.pathname.match(WEBHOOK_PATH);

    // The Monzo provider webhook is public and rate limited unconditionally.
    // A missing or unavailable limiter fails closed with 503.
    if (webhookMatch) {
      const limited = await enforceMonzoWebhookRateLimit(env);
      if (limited) return limited;
    }

    return monzoApi.fetch(request, env);
  },
};

export const __testing = {
  WEBHOOK_PATH,
  PAYMENT_HOST,
  PAYMENT_PATH_PREFIX,
  RATE_LIMIT_KEY,
};
