// Provider failure taxonomy.
//
// Adapters translate every transport, protocol and validation problem into one
// of these bounded codes. Business logic and telemetry see the code, never a
// provider status line, response body or exception message, so a provider can
// never push free text into a log, a Sentry event or a browser response.

export const PROVIDER_ERROR_CODES = Object.freeze([
  'provider_not_configured',
  'provider_request_invalid',
  'provider_input_rejected',
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
  constructor(code, detail = null) {
    const safe = CODES.has(code) ? code : 'provider_unavailable';
    super(safe);
    this.name = 'ProviderError';
    this.code = safe;
    // A bounded diagnostic token (see bindingErrorDetail), never free text.
    this.detail = typeof detail === 'string' && DETAIL_RE.test(detail) ? detail : null;
  }
}

const DETAIL_RE = /^(cf_[0-9]{4}(_[a-z]{1,12})?|[A-Za-z][A-Za-z0-9_]{0,39})$/;

/**
 * What kind of binding failure this was, as a token safe to log: the numeric
 * Workers AI code (`cf_3040`) when the message carries one, otherwise the
 * exception class name (`AiError`, `TypeError`). Never the message text,
 * which can name the account or the model.
 */
// Closed vocabulary for a binding message that carries no numeric code. Only
// the matched label leaves this module, never the text around it.
const BINDING_KEYWORDS = Object.freeze([
  // Request-shape problems first: their messages name parameters such as
  // max_tokens, which must not read as an authentication failure.
  ['input', /invalid|schema|oneof|must be|required property|too large|too long|max_tokens|parameter/i],
  ['auth', /unauthori[sz]ed|authentication|api token|access token|credential|permission denied/i],
  ['quota', /neuron|allocation|quota|usage limit|daily limit/i],
  ['plan', /paid plan|workers paid|upgrade|billing|subscription|payment/i],
  ['disabled', /disabled|suspended|blocked|not enabled|not allowed|forbidden/i],
  ['model', /no such model|unknown model|model not found|invalid model|deprecated|not supported/i],
  ['capacity', /capacity|overloaded|busy|try again|temporarily/i],
  ['network', /network|connection|fetch failed|socket|dns|timed? ?out/i],
]);

export function bindingErrorDetail(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : '';
  const code = workersAiErrorCode(message);
  const hit = BINDING_KEYWORDS.find(([, re]) => re.test(message));
  // The platform code and the kind of message travel together, so a code the
  // documentation does not list (4006 was observed; the docs list 3036 for the
  // daily allocation) is still attributable without the message text.
  if (code) return hit ? `cf_${code}_${hit[0]}` : `cf_${code}`;
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,24}$/.test(error.name)
    ? error.name
    : 'unknown';
  if (hit) return `${name}_${hit[0]}`.slice(0, 40);
  return message ? `${name}_other` : `${name}_empty`;
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

/**
 * Workers AI binding exceptions carry a numeric internal code in the message
 * (https://developers.cloudflare.com/workers-ai/platform/errors/). Only that
 * number is read and only a bounded code comes out: the message itself can
 * name the account or the model and never leaves this function.
 *
 * `provider_input_rejected` is distinct from `provider_request_invalid`: the
 * latter is our own pre-flight refusal, which no other provider would accept
 * either; the former is one model refusing a request shape (for example a JSON
 * schema it does not support) that the next model in the chain may accept.
 */
/**
 * The Workers AI error code, only where Cloudflare puts it: at the start of
 * the message or right after the error class (`AiError: 3040: ...`), or after
 * the word "code". A parameter limit such as `max_tokens <= 4096` is not a code.
 */
function workersAiErrorCode(message) {
  const match = /(?:^|^[A-Za-z]*Error:\s*|\bcode[:\s]+)([1-9][0-9]{3})(?=\s*(?::|$|\s))/i.exec(message);
  return match ? match[1] : null;
}

const BINDING_CODE_CLASSES = Object.freeze({
  3007: 'provider_timeout',
  3008: 'provider_timeout',
  3036: 'provider_rate_limited',
  // The daily free Neuron allocation as the binding actually reports it
  // (observed in production 2026-09-25; the docs table lists 3036).
  4006: 'provider_rate_limited',
  3040: 'provider_rate_limited',
  3003: 'provider_input_rejected',
  3006: 'provider_input_rejected',
  5004: 'provider_input_rejected',
  5006: 'provider_input_rejected',
  5007: 'provider_input_rejected',
  3042: 'provider_input_rejected',
});

export function classifyBindingError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'provider_timeout';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 200) : '';
  const code = workersAiErrorCode(message);
  if (code && BINDING_CODE_CLASSES[code]) return BINDING_CODE_CLASSES[code];
  if (/\b429\b|capacity|rate.?limit|too many requests/i.test(message)) return 'provider_rate_limited';
  return 'provider_unavailable';
}
