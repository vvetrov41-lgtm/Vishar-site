// CORS, origin enforcement, request-size limits and structured responses.
//
// CORS headers tell a *browser* what it may read. They are not a request
// control: a script or a curl command ignores them entirely. So the durable
// intake route rejects a disallowed origin outright rather than relying on the
// response header, while the pre-existing AI, lead and waitlist routes keep
// their original permissive behaviour.

export const PRODUCTION_ORIGINS = ['https://vishartattoo.com', 'https://www.vishartattoo.com'];

const PREVIEW_ORIGIN_SUFFIX = '.vishar-site.pages.dev';

/** 3 files x 4 MB, plus room for the text fields and multipart framing. */
export const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.includes(origin)) return true;
  if (origin.endsWith(PREVIEW_ORIGIN_SUFFIX) && origin.startsWith('https://')) return true;
  return false;
}

/**
 * Extra origins for a preview or staging deployment, supplied as a Worker
 * variable so a non-production environment never needs a code change.
 */
export function allowedOriginsFromEnv(env) {
  const raw = typeof env?.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

export function isAllowedOriginFor(origin, env) {
  if (isAllowedOrigin(origin)) return true;
  return allowedOriginsFromEnv(env).includes(origin);
}

export function getCorsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : PRODUCTION_ORIGINS[0];
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
 * Rejects an over-large request before any parsing happens, using the declared
 * Content-Length. A body with no declared length is still bounded by the
 * per-file and per-field checks after parsing.
 */
export function assertRequestSize(request, maxBytes = MAX_REQUEST_BYTES) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestError('request_too_large', 'That request is too large. Please attach smaller images.', 413);
  }
}

export function isMultipartRequest(request) {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.toLowerCase().includes('multipart/form-data');
}
