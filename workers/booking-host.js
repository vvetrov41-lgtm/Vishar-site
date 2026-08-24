// Dedicated public frontend for booking.vishartattoo.com.
//
// The Worker carries no CRM, Supabase, Telegram or provider credentials. It
// mirrors only the public booking/privacy pages and required static assets.
// Booking submissions stay same-origin in the browser and are relayed as the
// current multipart payload to the canonical production booking Worker.

const HOST = 'booking.vishartattoo.com';
const ORIGIN = `https://${HOST}`;
const UPSTREAM_ORIGIN = 'https://vishartattoo.com';
const BOOKING_ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';
const RELAY_PATH = '/api/enquiry';
const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

const EXACT_STATIC_PATHS = new Set([
  '/assets/css/fonts.css',
  '/assets/css/tailwind.css',
  '/favicon-v4.png',
  '/favicon-v4.ico',
  '/apple-touch-icon-v4.png',
]);

const NAV = '<div id="site-nav"><nav class="fixed top-0 inset-x-0 z-50 border-b border-white/10 bg-black/90 px-6 py-4 backdrop-blur"><div class="mx-auto flex max-w-[1200px] items-center justify-between"><a href="/" class="font-medium text-white">Vladimir Vishar</a><a href="/privacy/" class="text-sm text-white/60 hover:text-white">Privacy</a></div></nav></div>';
const FOOTER = '<div id="site-footer"><footer class="border-t border-white/10 px-6 py-10"><div class="mx-auto flex max-w-[1200px] flex-col gap-3 text-sm text-white/40 md:flex-row md:items-center md:justify-between"><span>Vladimir Vishar Tattoo</span><a href="mailto:info@vishartattoo.com" class="hover:text-white">info@vishartattoo.com</a></div></footer></div>';

export function classifyBookingHostPath(pathname) {
  if (pathname === '/') return { type: 'html', upstreamPath: '/booking/' };
  if (pathname === '/booking' || pathname === '/booking/') return { type: 'redirect', location: '/' };
  if (pathname === '/privacy' || pathname === '/privacy/') {
    return pathname === '/privacy'
      ? { type: 'redirect', location: '/privacy/' }
      : { type: 'html', upstreamPath: '/privacy/' };
  }
  if (EXACT_STATIC_PATHS.has(pathname)) return { type: 'asset', upstreamPath: pathname };
  if (/^\/assets\/vendor\/fonts\/[a-z0-9._/-]+$/i.test(pathname) && !pathname.includes('..')) {
    return { type: 'asset', upstreamPath: pathname };
  }
  return null;
}

export function rewriteBookingHostHtml(html, upstreamPath) {
  let output = html
    .replace(/<meta name="robots" content="index, follow">/g, '<meta name="robots" content="noindex, follow">')
    .replace(/<script src="\/components\.js" defer><\/script>/g, '')
    .replace('<div id="site-nav"></div>', NAV)
    .replace('<div id="site-footer"></div>', FOOTER);

  if (upstreamPath === '/booking/') {
    const relayEndpoint = `${ORIGIN}${RELAY_PATH}`;
    output = output
      .replaceAll(BOOKING_ENDPOINT, relayEndpoint)
      .replace(
        /<meta name="vishar-booking-endpoint" content="[^"]*">/,
        `<meta name="vishar-booking-endpoint" content="${relayEndpoint}">`
      )
      .replaceAll('https://vishartattoo.com/booking/', `${ORIGIN}/`);
  }

  if (upstreamPath === '/privacy/') {
    output = output.replaceAll('https://vishartattoo.com/privacy/', `${ORIGIN}/privacy/`);
  }

  return output;
}

function responseHeaders(upstreamHeaders, contentType) {
  const headers = new Headers(upstreamHeaders);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('set-cookie');
  if (contentType) headers.set('content-type', contentType);
  headers.set('x-robots-tag', 'noindex, follow');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return headers;
}

function relayJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

function requestLength(request) {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function relayEnquiry(request, fetchImpl) {
  const observedOrigin = request.headers.get('Origin') || '';
  if (observedOrigin !== ORIGIN) {
    return relayJson({ ok: false, error: 'This request could not be accepted.' }, 403);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return relayJson(
      {
        ok: false,
        error: 'Please refresh the booking page and send the form again.',
        code: 'multipart_required',
      },
      415
    );
  }

  const length = requestLength(request);
  if (length !== null && length > MAX_REQUEST_BYTES) {
    return relayJson({ ok: false, error: 'The enquiry is too large.' }, 413);
  }

  let upstream;
  try {
    // This Worker is an owned first-party transport boundary. The canonical
    // booking Worker already authorises the Vladimir website origin and maps it
    // to the current vladimir-website booking source. We therefore preserve the
    // browser's actual booking-host URL inside the multipart attribution fields,
    // while the server-to-server hop uses the canonical trusted website Origin.
    upstream = await fetchImpl(BOOKING_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        Origin: UPSTREAM_ORIGIN,
        'User-Agent': 'VisharBookingHost/2.0',
      },
      body: request.body,
    });
  } catch {
    return relayJson({ ok: false, error: 'The booking service could not be reached. Please try again.' }, 502);
  }

  let result;
  try {
    result = await upstream.json();
  } catch {
    result = null;
  }

  if (!upstream.ok || !result || result.ok !== true) {
    const message = result && typeof result.error === 'string'
      ? result.error
      : 'The booking service could not accept the enquiry. Please try again.';
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    const body = { ok: false, error: message };
    if (result && typeof result.code === 'string') body.code = result.code;
    return relayJson(body, status);
  }

  return relayJson({
    ok: true,
    ...(typeof result.reference === 'string' && result.reference ? { reference: result.reference } : {}),
    notificationWarning: Boolean(result.notificationWarning),
    imageWarning: Boolean(result.imageWarning),
    failedNotificationCount: Number.isInteger(Number(result.failedNotificationCount))
      ? Number(result.failedNotificationCount)
      : 0,
  });
}

async function fetchUpstream(path, fetchImpl) {
  const response = await fetchImpl(`${UPSTREAM_ORIGIN}${path}`, {
    method: 'GET',
    headers: {
      Accept: path.endsWith('.html') || path.endsWith('/') ? 'text/html' : '*/*',
      'User-Agent': 'VisharBookingHost/2.0',
    },
  });
  if (!response.ok) {
    return new Response('Booking service temporarily unavailable.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return response;
}

export async function handleBookingHostRequest(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);

  if (url.hostname !== HOST) return new Response('Not found.', { status: 404 });

  if (url.pathname === RELAY_PATH) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { Allow: 'POST', 'cache-control': 'no-store' },
      });
    }
    return relayEnquiry(request, fetchImpl);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'cache-control': 'no-store' },
    });
  }

  const route = classifyBookingHostPath(url.pathname);
  if (!route) return new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });

  if (route.type === 'redirect') {
    const location = new URL(route.location, ORIGIN);
    location.search = url.search;
    return Response.redirect(location.toString(), 308);
  }

  const upstream = await fetchUpstream(route.upstreamPath, fetchImpl);
  if (!upstream.ok) return upstream;

  if (route.type === 'asset') {
    const headers = responseHeaders(upstream.headers);
    headers.set(
      'cache-control',
      route.upstreamPath.startsWith('/assets/vendor/fonts/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600'
    );
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  const html = rewriteBookingHostHtml(await upstream.text(), route.upstreamPath);
  const headers = responseHeaders(upstream.headers, 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
}

export default {
  async fetch(request) {
    return handleBookingHostRequest(request);
  },
};

export const __testing = Object.freeze({
  HOST,
  ORIGIN,
  UPSTREAM_ORIGIN,
  BOOKING_ENDPOINT,
  RELAY_PATH,
  MAX_REQUEST_BYTES,
});
