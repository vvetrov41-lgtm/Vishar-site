// Dedicated public frontend for booking.vishartattoo.com.
//
// This Worker carries no CRM, Supabase, Telegram or provider credentials. It
// serves only the booking form, privacy notice and the small set of static
// assets those pages require. While production tattooai still runs the legacy
// Telegram-backed JSON intake, this Worker also provides one narrow same-origin
// relay for tattoo enquiries. That keeps the dedicated hostname functional
// without changing the CRM rollout or exposing provider credentials here.

const HOST = 'booking.vishartattoo.com';
const ORIGIN = `https://${HOST}`;
const UPSTREAM_ORIGIN = 'https://vishartattoo.com';
const BOOKING_ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';
const RELAY_PATH = '/api/enquiry';

const MAX_MULTIPART_REQUEST_BYTES = 13 * 1024 * 1024;
const MAX_JSON_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_LEGACY_BASE64_LENGTH = 5_600_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
      // Current production booking HTML uses the legacy endpoint directly.
      // The stacked CRM booking HTML instead carries an empty endpoint meta.
      // Support both shapes so a later public-site deploy does not silently
      // bypass this relay while the CRM intake remains intentionally separate.
      .replaceAll(BOOKING_ENDPOINT, relayEndpoint)
      .replace('<meta name="vishar-booking-endpoint" content="">', `<meta name="vishar-booking-endpoint" content="${relayEndpoint}">`)
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

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

function isFileLike(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.arrayBuffer === 'function'
    && Number.isFinite(Number(value.size))
    && typeof value.type === 'string'
  );
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function validateLegacyImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_FILES) return false;
  return images.every((image) => (
    image
    && typeof image === 'object'
    && ALLOWED_IMAGE_TYPES.has(image.type)
    && typeof image.data === 'string'
    && image.data.length > 0
    && image.data.length <= MAX_LEGACY_BASE64_LENGTH
  ));
}

function legacyTextPayload(source) {
  return {
    name: cleanText(source.name, 120),
    email: cleanText(source.email, 320),
    phone: cleanText(source.phone, 80),
    instagram: cleanText(source.instagram, 80),
    preferredReply: cleanText(source.preferredReply, 40),
    travellingFrom: cleanText(source.travellingFrom, 120),
    projectType: cleanText(source.projectType, 100),
    placement: cleanText(source.placement, 160),
    size: cleanText(source.size, 120),
    coverUp: cleanText(source.coverUp, 40),
    timing: cleanText(source.timing, 160),
    idea: cleanText(source.idea, 3500),
    website: cleanText(source.website, 200),
  };
}

function validateContactShape(payload) {
  if (
    !payload.name
    || !payload.email
    || !payload.preferredReply
    || !payload.projectType
    || !payload.placement
    || !payload.size
    || !payload.coverUp
    || !payload.idea
  ) return 'Please complete all required fields.';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return 'A valid email is required.';
  if (!new Set(['Email', 'WhatsApp', 'Instagram']).has(payload.preferredReply)) {
    return 'Please choose Email, WhatsApp or Instagram as the preferred reply.';
  }
  if (payload.preferredReply === 'WhatsApp' && !payload.phone) return 'A WhatsApp number is required when WhatsApp is selected.';
  if (payload.preferredReply === 'Instagram' && !payload.instagram) return 'An Instagram username is required when Instagram is selected.';
  return null;
}

async function payloadFromJson(request) {
  const length = requestLength(request);
  if (length !== null && length > MAX_JSON_REQUEST_BYTES) {
    return { error: relayJson({ ok: false, error: 'The enquiry is too large.' }, 413) };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { error: relayJson({ ok: false, error: 'A valid booking request is required.' }, 400) };
  }

  if (!body || typeof body !== 'object' || body.type !== 'tattoo-enquiry') {
    return { error: relayJson({ ok: false, error: 'Only tattoo enquiries are accepted here.' }, 400) };
  }

  const payload = legacyTextPayload(body);
  if (payload.website) return { honeypot: true };

  const contactError = validateContactShape(payload);
  if (contactError) return { error: relayJson({ ok: false, error: contactError }, 400) };
  if (!validateLegacyImages(body.images)) {
    return { error: relayJson({ ok: false, error: 'Please attach 1–3 valid JPG, PNG or WebP reference images.' }, 400) };
  }

  const startedAt = Number(body.startedAt);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < 1500) {
    return { error: relayJson({ ok: false, error: 'Please review the form and try again.' }, 400) };
  }

  return {
    payload: {
      type: 'tattoo-enquiry',
      ...payload,
      startedAt,
      images: body.images.map((image) => ({ type: image.type, data: image.data })),
      source: HOST,
    },
  };
}

async function payloadFromMultipart(request) {
  const length = requestLength(request);
  if (length !== null && length > MAX_MULTIPART_REQUEST_BYTES) {
    return { error: relayJson({ ok: false, error: 'The enquiry is too large.' }, 413) };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: relayJson({ ok: false, error: 'That submission could not be read. Please try again.' }, 400) };
  }

  const get = (name) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const payload = legacyTextPayload({
    name: get('name'),
    email: get('email'),
    phone: get('phone'),
    instagram: get('instagram'),
    preferredReply: get('preferredReply'),
    travellingFrom: get('travellingFrom'),
    projectType: get('projectType'),
    placement: get('placement'),
    size: get('size'),
    coverUp: get('coverUp'),
    timing: get('timing'),
    idea: get('idea'),
    website: get('website'),
  });

  if (payload.website) return { honeypot: true };
  if (get('privacyAcknowledged') !== 'true') {
    return { error: relayJson({ ok: false, error: 'Please acknowledge the privacy notice.' }, 400) };
  }

  const contactError = validateContactShape(payload);
  if (contactError) return { error: relayJson({ ok: false, error: contactError }, 400) };

  const files = form.getAll('references').filter(isFileLike);
  if (
    files.length < 1
    || files.length > MAX_FILES
    || files.some((file) => Number(file.size) < 1 || Number(file.size) > MAX_FILE_BYTES || !ALLOWED_IMAGE_TYPES.has(file.type))
  ) {
    return { error: relayJson({ ok: false, error: 'Please attach 1–3 valid JPG, PNG or WebP reference images, up to 4 MB each.' }, 400) };
  }

  const elapsedMs = Number(get('elapsedMs'));
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1500 || elapsedMs > 24 * 60 * 60 * 1000) {
    return { error: relayJson({ ok: false, error: 'Please review the form and try again.' }, 400) };
  }

  const images = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = bytesToBase64(bytes);
    if (!data || data.length > MAX_LEGACY_BASE64_LENGTH) {
      return { error: relayJson({ ok: false, error: 'One of the reference images is too large.' }, 400) };
    }
    images.push({ type: file.type, data });
  }

  return {
    payload: {
      type: 'tattoo-enquiry',
      ...payload,
      startedAt: Date.now() - elapsedMs,
      images,
      source: HOST,
    },
  };
}

async function relayEnquiry(request, fetchImpl) {
  const observedOrigin = request.headers.get('Origin') || '';
  if (observedOrigin !== ORIGIN) {
    return relayJson({ ok: false, error: 'This request could not be accepted.' }, 403);
  }

  const contentType = request.headers.get('content-type') || '';
  const parsed = contentType.startsWith('multipart/form-data')
    ? await payloadFromMultipart(request)
    : contentType.startsWith('application/json')
      ? await payloadFromJson(request)
      : { error: relayJson({ ok: false, error: 'Unsupported booking request.' }, 415) };

  if (parsed.error) return parsed.error;
  if (parsed.honeypot) return relayJson({ ok: true }, 200);

  let upstream;
  try {
    upstream = await fetchImpl(BOOKING_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: ORIGIN,
        'User-Agent': 'VisharBookingHost/1.0',
      },
      body: JSON.stringify(parsed.payload),
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
    return relayJson({ ok: false, error: message }, status);
  }

  return relayJson({
    ok: true,
    imageWarning: Boolean(result.imageWarning),
    failedImageCount: Number.isInteger(Number(result.failedImageCount)) ? Number(result.failedImageCount) : 0,
  });
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
  RELAY_PATH,
  MAX_MULTIPART_REQUEST_BYTES,
  MAX_JSON_REQUEST_BYTES,
  MAX_FILE_BYTES,
});