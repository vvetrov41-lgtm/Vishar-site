// Production entrypoint for booking.vishartattoo.com.
//
// The base booking host remains credential-free. This wrapper adds only the
// branded appointment client-action namespace and proxies it to the existing
// shared production action runtime. The upstream is a fixed first-party origin;
// browser cookies, authorization headers, request bodies and arbitrary URLs are
// never forwarded.

import { handleBookingHostRequest } from './booking-host.js';

const HOST = 'booking.vishartattoo.com';
const ACTION_UPSTREAM_ORIGIN = 'https://telegram.vishartattoo.com';
const ACTION_NAMESPACE_PREFIX = '/appointments/respond/';
const ACTION_PATH_RE = /^\/appointments\/respond\/[0-9a-f]{64}\/?$/;
const ACTION_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const SAFE_RESPONSE_HEADERS = Object.freeze([
  'allow',
  'cache-control',
  'content-security-policy',
  'content-type',
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

function copyActionResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return headers;
}

export function isAppointmentActionNamespace(pathname) {
  return pathname.startsWith(ACTION_NAMESPACE_PREFIX);
}

export function isValidAppointmentActionPath(pathname) {
  return ACTION_PATH_RE.test(pathname);
}

export async function proxyAppointmentClientAction(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);

  if (!isValidAppointmentActionPath(url.pathname)) {
    return plain(404, 'Not found.');
  }

  if (!ACTION_METHODS.has(request.method)) {
    return plain(405, 'Method not allowed.', { Allow: 'GET, HEAD, POST, OPTIONS' });
  }

  const upstreamUrl = `${ACTION_UPSTREAM_ORIGIN}${url.pathname}`;
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'VisharBookingHost/AppointmentActions',
      },
      // The capability path is the complete authority. The upstream action
      // route deliberately parses no POST body, so forwarding browser input
      // would only enlarge the trust boundary.
      redirect: 'manual',
    });
  } catch {
    return plain(502, 'This appointment action is temporarily unavailable.');
  }

  // The fixed upstream is not expected to redirect. Refusing redirects avoids
  // ever reflecting an upstream Location header through the public branded host.
  if (upstream.status >= 300 && upstream.status < 400) {
    return plain(502, 'This appointment action is temporarily unavailable.');
  }

  const headers = copyActionResponseHeaders(upstream.headers);
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function handleProductionBookingHostRequest(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== HOST) return plain(404, 'Not found.');

  if (isAppointmentActionNamespace(url.pathname)) {
    return proxyAppointmentClientAction(request, { fetchImpl });
  }

  return handleBookingHostRequest(request, { fetchImpl });
}

export default {
  async fetch(request) {
    return handleProductionBookingHostRequest(request);
  },
};

export const __testing = Object.freeze({
  HOST,
  ACTION_UPSTREAM_ORIGIN,
  ACTION_NAMESPACE_PREFIX,
  ACTION_PATH_RE,
  ACTION_METHODS,
  SAFE_RESPONSE_HEADERS,
});
