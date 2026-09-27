// WhatsApp Business Platform (Meta Cloud API) delivery.
//
// Like the Telegram adapter, this module only ever reads artist-owned
// encrypted bindings. There is no global token and no shared phone number: the
// binding name is derived from the artist's own non-secret integration key, so
// a Vladimir job can only ever reach Vladimir's WhatsApp account.
//
// Nothing here throws. Every failure is reported as a short machine code that
// is safe to log and safe to store in `integration_outbox.last_error_code`.
// The provider response body is never read on failure, because a Meta error
// payload can echo the recipient's phone number back at us.
//
// Graph API version is pinned deliberately. Meta's WhatsApp send/webhook
// reference documents v25.0, which is supported until July 2028; tracking the
// newest version automatically would change a production contract without
// review.

import { statusClass } from './logging.js';
import { ProviderRouteError, resolveProviderBinding } from './provider-routing.js';

export const GRAPH_API_VERSION = 'v25.0';
const GRAPH_ORIGIN = 'https://graph.facebook.com';

const PHONE_NUMBER_ID = /^[0-9]{5,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const MAX_BODY_LENGTH = 4096;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2}(?:_[A-Z]{2})?$/;
const BOOKING_ACTION_PAYLOAD = /^booking_action:[0-9a-f]{64}$/;

/**
 * Reads the artist's WhatsApp binding and validates its shape.
 *
 * The envelope is a JSON object in an encrypted Worker secret:
 *
 *   { "phoneNumberId": "...", "accessToken": "...",
 *     "wabaId": "...", "appSecret": "..." }
 *
 * `wabaId` and `appSecret` are used by the inbound webhook rather than the
 * send path, so they are optional here and never returned.
 */
export function selectWhatsappBinding(env, route) {
  let selected;
  try {
    selected = resolveProviderBinding(env, route);
  } catch (error) {
    return {
      ok: false,
      errorCode: error instanceof ProviderRouteError ? error.code : 'provider_route_invalid',
    };
  }

  if (selected.integrationType !== 'whatsapp' || selected.provider !== 'meta_cloud_api') {
    return { ok: false, errorCode: 'whatsapp_provider_unsupported' };
  }

  const phoneNumberId = typeof selected.credentials.phoneNumberId === 'string'
    ? selected.credentials.phoneNumberId.trim()
    : '';
  const accessToken = typeof selected.credentials.accessToken === 'string'
    ? selected.credentials.accessToken
    : '';

  if (!PHONE_NUMBER_ID.test(phoneNumberId) || !accessToken) {
    return { ok: false, errorCode: 'provider_binding_invalid' };
  }

  return { ok: true, bindingName: selected.bindingName, phoneNumberId, accessToken };
}

/**
 * Maps a Meta HTTP status to a safe code. Meta returns 4xx for both permanent
 * rejections and an expired token, so the distinction that matters to the
 * drain is only whether another attempt could plausibly succeed; the database
 * decides retry-versus-dead-letter by attempt count either way.
 */
function deliveryError(status) {
  const statusGroup = statusClass(status);
  if (status === 401 || status === 403) {
    return { delivered: false, errorCode: 'whatsapp_credentials_rejected', statusClass: statusGroup };
  }
  if (status === 429) {
    return { delivered: false, errorCode: 'whatsapp_rate_limited', statusClass: statusGroup };
  }
  if (status >= 500) {
    return { delivered: false, errorCode: 'whatsapp_provider_unavailable', statusClass: statusGroup };
  }
  return { delivered: false, errorCode: 'whatsapp_rejected', statusClass: statusGroup };
}

/**
 * Sends one free-form text message.
 *
 * Free-form is correct for the customer-service window Meta opens for 24 hours
 * after an inbound message. Sending outside that window requires an approved
 * template and is deliberately not implemented here: it would be a different
 * request shape with a different billing and consent story.
 */
export async function sendWhatsappMessage(env, route, message, fetchImpl = fetch) {
  const binding = selectWhatsappBinding(env, route);
  if (!binding.ok) return { delivered: false, errorCode: binding.errorCode };

  const to = typeof message?.to === 'string' ? message.to.trim() : '';
  const body = typeof message?.body === 'string' ? message.body : '';

  if (!WA_ID.test(to)) return { delivered: false, errorCode: 'whatsapp_destination_invalid' };
  if (!body.trim() || body.length > MAX_BODY_LENGTH) {
    return { delivered: false, errorCode: 'whatsapp_message_invalid' };
  }

  let response;
  try {
    response = await fetchImpl(
      `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/${binding.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${binding.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          // Link previews are suppressed: the CRM composes plain replies and a
          // preview would fetch third-party content on the client's device.
          text: { preview_url: false, body },
        }),
        // `manual`, never the `error` redirect mode: the Workers runtime rejects
        // that mode and throws before the subrequest is dispatched. A redirect
        // arrives here as a 3xx response and is refused as a non-ok status below.
        redirect: 'manual',
      }
    );
  } catch {
    return { delivered: false, errorCode: 'whatsapp_unreachable' };
  }

  if (!response.ok) return deliveryError(response.status);

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { delivered: false, errorCode: 'whatsapp_response_invalid' };
  }

  const providerMessageId = parsed?.messages?.[0]?.id;
  if (typeof providerMessageId !== 'string' || !providerMessageId) {
    return { delivered: false, errorCode: 'whatsapp_response_invalid' };
  }

  // Only the message id crosses back. The rest of Meta's response echoes the
  // recipient's phone number, which must not reach the acknowledgement path.
  return { delivered: true, providerMessageId };
}


/**
 * Sends one approved WhatsApp template. The caller cannot supply an arbitrary
 * component tree: this adapter accepts only the exact booking-card shape we
 * support (location header, bounded text body parameters and two quick replies).
 */
export async function sendWhatsappTemplate(env, route, message, fetchImpl = fetch) {
  const binding = selectWhatsappBinding(env, route);
  if (!binding.ok) return { delivered: false, errorCode: binding.errorCode };

  const to = typeof message?.to === 'string' ? message.to.trim() : '';
  const templateName = typeof message?.templateName === 'string' ? message.templateName.trim() : '';
  const language = typeof message?.language === 'string' ? message.language.trim() : '';
  const bodyParameters = Array.isArray(message?.bodyParameters) ? message.bodyParameters : null;
  const location = message?.location;
  const quickReplies = Array.isArray(message?.quickReplies) ? message.quickReplies : null;

  if (!WA_ID.test(to)) return { delivered: false, errorCode: 'whatsapp_destination_invalid' };
  if (!TEMPLATE_NAME.test(templateName) || !TEMPLATE_LANGUAGE.test(language)) {
    return { delivered: false, errorCode: 'whatsapp_template_invalid' };
  }
  if (
    !bodyParameters
    || bodyParameters.length < 1
    || bodyParameters.length > 10
    || bodyParameters.some((value) => (
      typeof value !== 'string'
      || !value.trim()
      || value.length > 1024
    ))
  ) {
    return { delivered: false, errorCode: 'whatsapp_template_invalid' };
  }

  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  const locationName = typeof location?.name === 'string' ? location.name.trim() : '';
  const locationAddress = typeof location?.address === 'string' ? location.address.trim() : '';
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !locationName || locationName.length > 256
    || !locationAddress || locationAddress.length > 512
  ) {
    return { delivered: false, errorCode: 'whatsapp_template_invalid' };
  }

  if (
    !quickReplies
    || quickReplies.length !== 2
    || quickReplies.some((value) => typeof value !== 'string' || !BOOKING_ACTION_PAYLOAD.test(value))
    || quickReplies[0] === quickReplies[1]
  ) {
    return { delivered: false, errorCode: 'whatsapp_template_invalid' };
  }

  let response;
  try {
    response = await fetchImpl(
      `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/${binding.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${binding.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: language },
            components: [
              {
                type: 'header',
                parameters: [{
                  type: 'location',
                  location: {
                    latitude,
                    longitude,
                    name: locationName,
                    address: locationAddress,
                  },
                }],
              },
              {
                type: 'body',
                parameters: bodyParameters.map((value) => ({ type: 'text', text: value })),
              },
              {
                type: 'button',
                sub_type: 'quick_reply',
                index: '0',
                parameters: [{ type: 'payload', payload: quickReplies[0] }],
              },
              {
                type: 'button',
                sub_type: 'quick_reply',
                index: '1',
                parameters: [{ type: 'payload', payload: quickReplies[1] }],
              },
            ],
          },
        }),
        redirect: 'manual',
      }
    );
  } catch {
    return { delivered: false, errorCode: 'whatsapp_unreachable' };
  }

  if (!response.ok) return deliveryError(response.status);

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { delivered: false, errorCode: 'whatsapp_response_invalid' };
  }

  const providerMessageId = parsed?.messages?.[0]?.id;
  if (typeof providerMessageId !== 'string' || !providerMessageId) {
    return { delivered: false, errorCode: 'whatsapp_response_invalid' };
  }

  return { delivered: true, providerMessageId };
}

export const __testing = {
  deliveryError,
  MAX_BODY_LENGTH,
  TEMPLATE_NAME,
  TEMPLATE_LANGUAGE,
  BOOKING_ACTION_PAYLOAD,
};

