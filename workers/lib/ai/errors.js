// Provider failure taxonomy.
//
// Adapters translate every transport, protocol and validation problem into one
// of these bounded codes. Business logic and telemetry see the code, never a
// provider status line, response body or exception message, so a provider can
// never push free text into a log, a Sentry event or a browser response.

export const PROVIDER_ERROR_CODES = Object.freeze([
  'provider_not_configured',
  'provider_request_invalid',
  'provider_timeout',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_http_error',
  'provider_malformed_response',
  'provider_empty_response',
  'output_invalid',
]);

const CODES = new Set(PROVIDER_ERROR_CODES);

export class ProviderError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'provider_unavailable';
    super(safe);
    this.name = 'ProviderError';
    this.code = safe;
  }
}

/** Anything an adapter throws becomes a bounded code, including a raw TypeError. */
export function toProviderErrorCode(error) {
  if (error instanceof ProviderError) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'provider_timeout';
  return 'provider_unavailable';
}

/** HTTP status to failure class. Retryability is decided from this, not from a body. */
export function providerErrorCodeForStatus(status) {
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status === 429) return 'provider_rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_http_error';
}
