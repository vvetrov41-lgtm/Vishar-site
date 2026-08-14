// CORS, origin enforcement, request-size limits and structured responses.
//
// CORS headers tell a *browser* what it may read. They are not a request
// control: a script or a curl command ignores them entirely. So the durable
// intake route rejects a disallowed origin outright rather than relying on the
// response header, while the pre-existing AI, lead and waitlist routes keep
// their original permissive behaviour.

export const PRODUCTION_ORIGINS = [
  'https://vishartattoo.com',
  'https://www.vishartattoo.com',
  'https://booking.vishartattoo.com',
];

/** 3 files x 4 MB, plus room for the text fields and multipart framing. */
export const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return PRODUCTION_ORIGINS.includes(origin);
}

/**
 * Exact origins for one deployment, supplied as a Worker variable so staging
 * and production cannot accept each other's traffic. Remote origins must use
 * HTTPS; loopback HTTP is accepted for local `wrangler dev` only when it is
 * named explicitly.
 */
export function allowedOriginsFromEnv(env) {
  const raw = typeof env?.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      try {
        const parsed = new URL(value);
        const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        return (
          (parsed.protocol === 'https:' || (loopback && parsed.protocol === 'http:'))
          && !parsed.username
          && !parsed.password
          && (parsed.pathname === '/' || parsed.pathname === '')
          && !parsed.search
          && !parsed.hash
          && parsed.origin === value
        );
      } catch {
        return false;
      }
    });
}

export function isAllowedOriginFor(origin, env) {
  const configured = typeof env?.ALLOWED_ORIGINS === 'string'
    && env.ALLOWED_ORIGINS.trim() !== '';
  if (configured) return allowedOriginsFromEnv(env).includes(origin);
  // The preview binding is declared in wrangler.toml. A forgotten allow-list
  // must not make that Worker fall back to production origins.
  if (env?.VISHAR_ENVIRONMENT === 'preview') return false;
  return isAllowedOrigin(origin);
}

export function getCorsHeaders(origin, env) {
  const allowOrigin = isAllowedOriginFor(origin, env) ? origin : PRODUCTION_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function jsonResponse(body, status, cors) {
  return Response.json(body, { status, headers: cors });
}

/**
 * A client-facing error carrying a short machine code. The code is safe to log
 * and safe to store in `enquiries.intake_error_code`; the message is safe to
 * show a visitor. Neither ever contains provider detail or personal data.
 */
export class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.status = status;
  }
}

/** Raised when the Worker is missing configuration it cannot run without. */
export class ConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
    this.status = 500;
  }
}

/**
 * Rejects an over-large request before parsing when Content-Length is present.
 * The stream reader below is the authoritative bound when it is absent or
 * untrustworthy.
 */
export function assertRequestSize(request, maxBytes = MAX_REQUEST_BYTES) {
  const header = request.headers.get('Content-Length');
  const declared = header === null ? null : Number(header);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestError('request_too_large', 'That request is too large. Please attach smaller images.', 413);
  }
}

/**
 * Reads at most `maxBytes` from the request stream before multipart parsing.
 * `request.formData()` buffers the body, so per-file checks alone cannot
 * protect a Worker from a chunked request with no Content-Length header.
 */
export async function parseBoundedMultipartFormData(request, maxBytes = MAX_REQUEST_BYTES) {
  assertRequestSize(request, maxBytes);

  if (!request.body) {
    throw new RequestError('malformed_multipart', 'That submission could not be read. Please try again.');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestError(
          'request_too_large',
          'That request is too large. Please attach smaller images.',
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return await new Response(body, {
      headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
    }).formData();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('malformed_multipart', 'That submission could not be read. Please try again.');
  }
}

export function isMultipartRequest(request) {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.toLowerCase().includes('multipart/form-data');
}
