// Consent-gated OpenAI Ads Conversions API support for durable booking leads.
//
// This module intentionally knows nothing about client identity or booking
// ownership. The enquiry route supplies only a durable event id plus bounded,
// request-scoped measurement context after the existing server-owned booking
// source/origin checks have passed.

const OPENAI_ADS_PIXEL_ID = 'XkQY5Xq3FbxJvAx2qDD9my';
const OPENAI_ADS_EVENTS_ENDPOINT = 'https://bzr.openai.com/v1/events';
const INTEGRATION_SOURCE = 'vishar_booking_worker';
const VISHAR_MEASUREMENT_ORIGINS = new Set([
  'https://vishartattoo.com',
  'https://www.vishartattoo.com',
]);
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_OPAQUE_REF_LENGTH = 2048;
const REQUEST_TIMEOUT_MS = 5000;

function stringField(form, name) {
  const value = form?.get?.(name);
  return typeof value === 'string' ? value : '';
}

function boundedOpaque(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OPAQUE_REF_LENGTH) return '';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  return trimmed;
}

function sanitizeSourceUrl(value, observedOrigin) {
  if (typeof value !== 'string' || !value || value.length > MAX_SOURCE_URL_LENGTH) return '';
  if (!VISHAR_MEASUREMENT_ORIGINS.has(observedOrigin)) return '';

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    if (parsed.origin !== observedOrigin) return '';

    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Read the optional browser-to-server measurement handoff.
 *
 * The browser deliberately sends these fields only after the visitor grants
 * the dedicated OpenAI Ads measurement consent. They are never persisted in
 * Supabase. A forged value cannot affect booking ownership or provider routing;
 * it can only request measurement of the request that is already being handled.
 * The observed Origin is additionally pinned to Vladimir's public site so a
 * future tenant or external booking source cannot contaminate Vladimir's Pixel.
 */
export function readOpenAiAdsMeasurementContext(form, observedOrigin) {
  if (stringField(form, 'openaiAdsMeasurementConsent') !== 'granted') return null;

  const sourceUrl = sanitizeSourceUrl(stringField(form, 'openaiAdsSourceUrl'), observedOrigin);
  if (!sourceUrl) return null;

  return {
    sourceUrl,
    oppref: boundedOpaque(stringField(form, 'openaiAdsOppref')),
    obref: boundedOpaque(stringField(form, 'openaiAdsObref')),
  };
}

function buildLeadEvent(eventId, context, timestampMs) {
  const event = {
    id: eventId,
    type: 'lead_created',
    timestamp_ms: timestampMs,
    source_url: context.sourceUrl,
    action_source: 'web',
    opt_out: true,
    data: { type: 'customer_action' },
  };

  if (context.oppref) event.oppref = context.oppref;
  if (context.obref) event.user = { obref: context.obref };
  return event;
}

async function sendLeadConversion({ env, eventId, context, fetchImpl, now }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(
      `${OPENAI_ADS_EVENTS_ENDPOINT}?pid=${encodeURIComponent(OPENAI_ADS_PIXEL_ID)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_ADS_CAPI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          validate_only: false,
          integration_source: INTEGRATION_SOURCE,
          events: [buildLeadEvent(eventId, context, now())],
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const error = new Error('openai_ads_http_error');
      error.status = response.status;
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Schedule best-effort measurement after durable enquiry completion.
 *
 * Nothing in this path is allowed to throw into the booking response. Missing
 * consent, missing secret, scheduling failure, timeout and provider errors all
 * degrade to measurement-only diagnostics.
 */
export function scheduleOpenAiLeadConversion({
  env,
  eventId,
  context,
  schedule,
  fetchImpl = fetch,
  logger,
  now = Date.now,
}) {
  if (!context) return false;
  if (!eventId) return false;

  if (!env?.OPENAI_ADS_CAPI_KEY) {
    logger?.info?.('openai_ads.capi_skipped', {
      route: 'enquiries',
      reason: 'not_configured',
    });
    return false;
  }

  if (typeof schedule !== 'function') {
    logger?.warn?.('openai_ads.capi_skipped', {
      route: 'enquiries',
      reason: 'background_scheduler_unavailable',
    });
    return false;
  }

  const task = Promise.resolve()
    .then(() => sendLeadConversion({ env, eventId, context, fetchImpl, now }))
    .then(() => {
      logger?.info?.('openai_ads.capi_delivered', {
        route: 'enquiries',
        eventType: 'lead_created',
      });
    })
    .catch((error) => {
      logger?.warn?.('openai_ads.capi_failed', {
        route: 'enquiries',
        errorCode: error?.name === 'AbortError' ? 'timeout' : 'provider_error',
        status: Number.isInteger(error?.status) ? error.status : undefined,
      });
    });

  try {
    schedule(task);
    return true;
  } catch {
    // The task already owns its rejection handler. If scheduling itself fails,
    // booking still succeeds and no sensitive provider context is logged.
    logger?.warn?.('openai_ads.capi_failed', {
      route: 'enquiries',
      errorCode: 'background_schedule_failed',
    });
    return false;
  }
}

export const OPENAI_ADS_CONFIG = Object.freeze({
  pixelId: OPENAI_ADS_PIXEL_ID,
  eventType: 'lead_created',
  integrationSource: INTEGRATION_SOURCE,
});
