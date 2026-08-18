// Public payment redirect Worker.
//
// It maps one opaque CRM payment-link id to the artist-specific Monzo Easy
// Bank Transfer reusable URL through a backend-only RPC. A GET redirect is
// navigation only: it never marks a deposit paid and never writes the ledger.

import { createPaymentSupabaseClient, PaymentSupabaseError } from './lib/payment-supabase.js';

const PAYMENT_PATH = /^\/pay-by-bank-transfer\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const RATE_LIMIT_KEY = 'public-payment-redirect';

function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function unavailable(status = 404) {
  return new Response('Payment link unavailable', {
    status,
    headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

function isAllowedMonzoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'monzo.com'
      && /^\/pay\/r\/[A-Za-z0-9_-]{4,255}$/.test(url.pathname)
      && !url.search
      && !url.hash
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

async function applyRateLimit(env) {
  const limiter = env?.PAYMENT_REDIRECT_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return 'unavailable';
  try {
    const result = await limiter.limit({ key: RATE_LIMIT_KEY });
    return result?.success === true ? 'allowed' : 'limited';
  } catch {
    return 'unavailable';
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return unavailable(405);

    const url = new URL(request.url);
    const match = url.pathname.match(PAYMENT_PATH);
    if (!match || url.search) return unavailable();

    const rateLimit = await applyRateLimit(env);
    if (rateLimit === 'limited') return unavailable(429);
    if (rateLimit !== 'allowed') return unavailable(503);

    try {
      const supabase = createPaymentSupabaseClient(env);
      const destination = await supabase.rpc('resolve_monzo_deposit_redirect', {
        p_public_id: match[1],
      });

      if (!isAllowedMonzoUrl(destination)) return unavailable();

      return new Response(null, {
        status: 302,
        headers: headers({ Location: destination }),
      });
    } catch (error) {
      if (error instanceof PaymentSupabaseError && error.status < 500) {
        return unavailable();
      }
      return unavailable(503);
    }
  },
};
