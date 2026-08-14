// Dedicated public frontend for booking.vishartattoo.com.
//
// This Worker carries no CRM, Supabase or provider credentials. It serves only
// the booking form, privacy notice and the small set of static assets those two
// pages require. The authoritative booking POST still goes to the existing
// tattooai Worker, where exact Origin and trusted booking-source checks run
// before persistence.

const HOST = 'booking.vishartattoo.com';
const ORIGIN = `https://${HOST}`;
const UPSTREAM_ORIGIN = 'https://vishartattoo.com';
const BOOKING_ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';

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
    output = output
      .replace('<meta name="vishar-booking-endpoint" content="">', `<meta name="vishar-booking-endpoint" content="${BOOKING_ENDPOINT}">`)
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

async function fetchUpstream(path, fetchImpl) {
  const response = await fetchImpl(`${UPSTREAM_ORIGIN}${path}`, {
    method: 'GET',
    headers: {
      Accept: path.endsWith('.html') || path.endsWith('/') ? 'text/html' : '*/*',
      'User-Agent': 'VisharBookingHost/1.0',
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

  if (url.hostname !== HOST) {
    return new Response('Not found.', { status: 404 });
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
    if (route.upstreamPath.startsWith('/assets/vendor/fonts/')) {
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    } else {
      headers.set('cache-control', 'public, max-age=3600');
    }
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
});
