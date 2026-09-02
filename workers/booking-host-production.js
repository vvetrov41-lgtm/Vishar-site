// Production entrypoint for booking.vishartattoo.com.
//
// The base booking host remains credential-free. This wrapper adds only the
// branded public namespaces and proxies each to a fixed first-party upstream
// that already owns the credentials for it:
//
//   /appointments/respond/<token>  -> the shared production action runtime
//   /forms/<public-source-id>      -> the canonical intake Worker's hosted
//                                     booking form (GET renders, POST submits)
//
// Browser cookies, authorization headers and arbitrary URLs are never
// forwarded. The hosted-form namespace is the one place a request body crosses
// the boundary, because the enquiry multipart body is the submission itself.

import { handleBookingHostRequest } from './booking-host.js';

const HOST = 'booking.vishartattoo.com';
const ACTION_UPSTREAM_ORIGIN = 'https://telegram.vishartattoo.com';
const ACTION_NAMESPACE_PREFIX = '/appointments/respond/';
const ACTION_PATH_RE = /^\/appointments\/respond\/[0-9a-f]{64}\/?$/;
const ACTION_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

// Hosted booking forms. The canonical intake Worker renders the form for a GET
// and consumes the multipart submission for a POST; this host only carries the
// branded public origin, so a client never sees an internal workers.dev URL.
const FORMS_UPSTREAM_ORIGIN = 'https://tattooai.vvetrov41.workers.dev';
const FORMS_NAMESPACE_PREFIX = '/forms/';
const FORMS_PATH_RE = /^\/forms\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/i;
const FORMS_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const FORMS_MAX_REQUEST_BYTES = 13 * 1024 * 1024;
const FORMS_RESPONSE_HEADERS = Object.freeze([
  'allow',
  'cache-control',
  'content-security-policy',
  'content-type',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
]);
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

export function isHostedFormNamespace(pathname) {
  return pathname.startsWith(FORMS_NAMESPACE_PREFIX);
}

export function isValidHostedFormPath(pathname) {
  return FORMS_PATH_RE.test(pathname);
}

function hostedFormPage(status, title, message) {
  return new Response(
    `<!doctype html><html lang="en-GB"><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow"><title>${title}</title>`
    + `<body style="margin:0;background:#0a0a0a;color:#f5f5f7;font-family:system-ui;padding:48px">`
    + `<main style="max-width:680px;margin:auto"><h1>${title}</h1><p>${message}</p></main></body></html>`,
    {
      status,
      headers: {
        'cache-control': 'no-store, max-age=0',
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'x-robots-tag': 'noindex, nofollow, noarchive',
      },
    }
  );
}

// A link that is malformed, or an upstream that cannot answer, says the same
// thing to a visitor: this form is not usable. Nothing about the installation,
// the artist or the database is revealed either way.
function hostedFormUnavailable(status = 404) {
  return status >= 500
    ? hostedFormPage(503, 'Booking temporarily unavailable', 'This booking form cannot be loaded right now. Please try again later.')
    : hostedFormPage(404, 'Booking form unavailable', 'This booking form is not active or the link is invalid.');
}

function hostedFormResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const name of FORMS_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return headers;
}

function hostedFormJson(body, status) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });
}

function requestLength(request) {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function submitHostedForm(request, upstreamUrl, fetchImpl) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return hostedFormJson(
      {
        ok: false,
        error: 'Please refresh this booking form and send it again.',
        code: 'multipart_required',
      },
      415
    );
  }

  const length = requestLength(request);
  if (length !== null && length > FORMS_MAX_REQUEST_BYTES) {
    return hostedFormJson({ ok: false, error: 'The enquiry is too large.' }, 413);
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      // Only the multipart body and its own content type cross the boundary.
      // The hosted intake derives the artist from the URL id server-side, so
      // there is nothing for a forwarded Origin, cookie or header to decide.
      headers: {
        'content-type': contentType,
        'User-Agent': 'VisharBookingHost/HostedForms',
      },
      body: request.body,
      redirect: 'manual',
    });
  } catch {
    return hostedFormJson(
      { ok: false, error: 'The booking service could not be reached. Please try again.' },
      502
    );
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
    return hostedFormJson(body, status);
  }

  return hostedFormJson({
    ok: true,
    ...(typeof result.reference === 'string' && result.reference ? { reference: result.reference } : {}),
    ...(result.replayed === true ? { replayed: true } : {}),
  }, 200);
}

export async function proxyHostedBookingForm(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);

  // A malformed id is answered here rather than upstream, so the namespace
  // never falls through to a different 404 surface.
  if (!isValidHostedFormPath(url.pathname)) return hostedFormUnavailable(404);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { Allow: 'GET, HEAD, POST, OPTIONS', 'cache-control': 'no-store' },
    });
  }

  if (!FORMS_METHODS.has(request.method)) {
    return plain(405, 'Method not allowed.', { Allow: 'GET, HEAD, POST, OPTIONS' });
  }

  const upstreamUrl = `${FORMS_UPSTREAM_ORIGIN}${url.pathname}`;

  if (request.method === 'POST') {
    return submitHostedForm(request, upstreamUrl, fetchImpl);
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'VisharBookingHost/HostedForms',
      },
      redirect: 'manual',
    });
  } catch {
    return hostedFormUnavailable(503);
  }

  // The renderer answers a GET with exactly two things: the form, or the same
  // unavailable page. Anything else is skew — a redirect whose Location must
  // never be reflected through the branded host, an outage, or an upstream
  // that is not serving this namespace at all and would otherwise hand a
  // client the intake Worker's own boundary message.
  if (upstream.status !== 200 && upstream.status !== 404) return hostedFormUnavailable(503);

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: hostedFormResponseHeaders(upstream.headers),
  });
}

export async function handleProductionBookingHostRequest(request, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== HOST) return plain(404, 'Not found.');

  if (isAppointmentActionNamespace(url.pathname)) {
    return proxyAppointmentClientAction(request, { fetchImpl });
  }

  if (isHostedFormNamespace(url.pathname)) {
    return proxyHostedBookingForm(request, { fetchImpl });
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
  FORMS_UPSTREAM_ORIGIN,
  FORMS_NAMESPACE_PREFIX,
  FORMS_PATH_RE,
  FORMS_METHODS,
  FORMS_MAX_REQUEST_BYTES,
  FORMS_RESPONSE_HEADERS,
});
