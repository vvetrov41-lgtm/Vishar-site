// Credential-free edge for https://vishartattoo.com/book/{artist-slug}.
//
// This Worker is bound only to the /book/* zone route. It forwards to the
// credential-bearing intake Worker on a fixed first-party origin and strips all
// browser routing/authentication headers. The upstream database decides which
// immutable Artist/source the slug represents.
//
// Cloudflare route wildcards match zero or more characters, so /book/* also
// catches the pre-existing /book/ marketing page. That exact path is passed
// through to the zone origin so enabling the proxied apex cannot hide the book.

const HOST = 'vishartattoo.com';
const UPSTREAM_ORIGIN = 'https://tattooai.vvetrov41.workers.dev';
const BOOK_PREFIX = '/book/';
const MARKETING_BOOK_PATH = '/book/';
const BOOK_PATH = /^\/book\/[a-z][a-z0-9-]{1,62}\/?$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const MAX_REQUEST_BYTES = 13 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = Object.freeze([
  'allow',
  'cache-control',
  'content-security-policy',
  'content-type',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
  'x-robots-tag',
]);

function plain(status, message, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'text/plain; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      ...extraHeaders,
    },
  });
}

function responseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return headers;
}

function requestLength(request) {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function isPublicBookingNamespace(pathname) {
  return pathname.startsWith(BOOK_PREFIX);
}

export function isMarketingBookPath(pathname) {
  return pathname === MARKETING_BOOK_PATH;
}

export function isValidPublicBookingPath(pathname) {
  return BOOK_PATH.test(pathname);
}

export async function proxyPublicBooking(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== HOST) {
    return plain(404, 'Not found.');
  }

  // A Worker Route can transparently fetch the incoming Request to the zone
  // origin. Keep the existing public book page intact when the apex becomes
  // proxied so the booking route can execute.
  if (isMarketingBookPath(url.pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    }
    try {
      return await fetchImpl(request);
    } catch {
      return plain(502, 'The site is temporarily unavailable.');
    }
  }

  if (!isValidPublicBookingPath(url.pathname)) {
    return plain(404, 'Not found.');
  }
  if (!METHODS.has(request.method)) {
    return plain(405, 'Method not allowed.', { Allow: 'GET, HEAD, POST, OPTIONS' });
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { Allow: 'GET, HEAD, POST, OPTIONS', 'cache-control': 'no-store' },
    });
  }

  const upstreamUrl = `${UPSTREAM_ORIGIN}${url.pathname}${url.search}`;
  const headers = {
    'User-Agent': 'VisharPublicBookingEdge/1',
  };
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return Response.json(
        { ok: false, error: 'Please refresh this booking form and send it again.', code: 'multipart_required' },
        { status: 415, headers: responseHeaders(new Headers({ 'content-type': 'application/json' })) },
      );
    }
    const length = requestLength(request);
    if (length !== null && length > MAX_REQUEST_BYTES) {
      return Response.json(
        { ok: false, error: 'The enquiry is too large.' },
        { status: 413, headers: responseHeaders(new Headers({ 'content-type': 'application/json' })) },
      );
    }
    headers['content-type'] = contentType;
    init.body = request.body;
  } else {
    headers.Accept = 'text/html,application/xhtml+xml';
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, init);
  } catch {
    return plain(502, 'The booking service is temporarily unavailable.');
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return plain(502, 'The booking service is temporarily unavailable.');
  }

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  });
}

export default {
  async fetch(request) {
    return proxyPublicBooking(request);
  },
};

export const __testing = Object.freeze({
  HOST,
  UPSTREAM_ORIGIN,
  BOOK_PREFIX,
  MARKETING_BOOK_PATH,
  BOOK_PATH,
  METHODS,
  MAX_REQUEST_BYTES,
  SAFE_RESPONSE_HEADERS,
});
