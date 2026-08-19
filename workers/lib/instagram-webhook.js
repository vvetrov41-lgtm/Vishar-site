// Public Meta Instagram webhook boundary.
//
// The request body is authenticated before JSON is parsed. After signature
// verification the Instagram professional account id carried on the entry is
// resolved to exactly one artist through a backend-owned mapping. No request
// field can choose artist_id, integration_key, credential binding or
// destination.
//
// This differs from the WhatsApp webhook in one important way. WhatsApp routes
// carry their own app secret per artist binding, so a signature match narrows
// the route. Instagram Login uses one Meta app for every connected account, so
// the signature proves only that Meta sent the payload. Artist resolution is
// therefore a separate database lookup that fails closed, and it is the only
// thing standing between Vladimir's account and a Kristina conversation.
//
// Contract implemented, from Meta's Instagram Platform webhooks reference:
//
//   object   "instagram"
//   entry[]  { id: <IGID>, time, messaging: [ ... ] }
//   messaging[]
//     { sender: { id }, recipient: { id }, timestamp,
//       message: { mid, text, attachments, is_echo, is_deleted,
//                  is_unsupported, referral } }
//     { sender, recipient, timestamp, read: { mid } }
//     { sender, recipient, timestamp, reaction: { mid, action, ... } }
//
// Fields subscribed: messages, message_reactions, messaging_seen.

export const INSTAGRAM_WEBHOOK_PATH = '/webhook';
export const MAX_WEBHOOK_BYTES = 256 * 1024;

const PROVIDER_ID = /^[0-9]{5,40}$/;
const MESSAGE_ID = /^[A-Za-z0-9_=./-]{8,255}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const MESSAGE_TYPE = /^[a-z][a-z0-9_]{1,31}$/;
const REF = /^[A-Za-z0-9_.:|-]{1,120}$/;
const MAX_EVENTS_PER_REQUEST = 100;

export class InstagramWebhookError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'InstagramWebhookError';
    this.code = code;
    this.status = status;
  }
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

export function constantTimeEqual(left, right) {
  const a = textBytes(typeof left === 'string' ? left : '');
  const b = textBytes(typeof right === 'string' ? right : '');
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

async function hmacHex(secret, bytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    textBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyWebhookSignature(rawBytes, headerValue, appSecret) {
  const match = typeof headerValue === 'string' ? SIGNATURE.exec(headerValue.trim()) : null;
  if (!match) return false;
  if (typeof appSecret !== 'string' || appSecret.length < 16) return false;
  const digest = await hmacHex(appSecret, rawBytes);
  return constantTimeEqual(digest, match[1].toLowerCase());
}

/** Meta reports event times in milliseconds. */
export function parseProviderTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value > 1e12 ? value : value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  // A timestamp far in the future is not something to persist.
  if (date.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return date.toISOString();
}

/**
 * Reduces a Meta message object to the shape the CRM stores.
 *
 * Attachment URLs are deliberately dropped. Meta serves Instagram media from
 * short-lived signed CDN links, so persisting one would store an expiring
 * value that the CRM cannot re-fetch later anyway. The ordered attachment
 * types are kept so the timeline can say what arrived.
 */
export function normaliseMessage(message) {
  if (!message || typeof message !== 'object') return null;

  const mid = typeof message.mid === 'string' ? message.mid.trim() : '';
  if (!MESSAGE_ID.test(mid)) return null;

  // A deletion is not a message. Recording one would create a timeline entry
  // for content that no longer exists on either side.
  if (message.is_deleted === true) return null;

  const attachments = Array.isArray(message.attachments)
    ? message.attachments
      .map((attachment) => {
        const type = typeof attachment?.type === 'string'
          ? attachment.type.toLowerCase().replace(/[^a-z0-9_]/g, '_')
          : '';
        return MESSAGE_TYPE.test(type) ? { type } : { type: 'unsupported' };
      })
      .slice(0, 16)
    : [];

  const text = typeof message.text === 'string' ? message.text : '';

  let messageType;
  if (message.is_unsupported === true) {
    messageType = 'unsupported';
  } else if (text.trim()) {
    messageType = 'text';
  } else if (attachments.length > 0) {
    messageType = attachments[0].type;
  } else {
    messageType = 'unsupported';
  }

  // Only a text message carries text into the CRM. A caption invented for an
  // image would be indistinguishable from something the client actually wrote.
  const body = messageType === 'text' ? text.slice(0, 4096) : null;
  if (messageType === 'text' && !body.trim()) return null;

  return { mid, messageType, body, attachments, isEcho: message.is_echo === true };
}

/**
 * Extracts provider referral/ad attribution.
 *
 * This is the only trustworthy source of "this conversation came from an ad",
 * because it arrives inside a signed Meta payload. The CRM never accepts the
 * same claim from a browser.
 */
export function normaliseReferral(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const safe = {};
  const source = typeof referral.source === 'string' ? referral.source.slice(0, 60) : '';
  const type = typeof referral.type === 'string' ? referral.type.slice(0, 60) : '';
  const ref = typeof referral.ref === 'string' ? referral.ref : '';
  const adId = referral.ad_id === undefined ? '' : String(referral.ad_id);

  if (source && REF.test(source)) safe.source = source;
  if (type && REF.test(type)) safe.type = type;
  if (ref && REF.test(ref)) safe.ref = ref;
  if (adId && /^[0-9]{1,32}$/.test(adId)) safe.ad_id = adId;

  return Object.keys(safe).length > 0 ? safe : null;
}

function jsonError(status) {
  return new Response(JSON.stringify({ ok: false }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function assertJsonContentType(request) {
  const raw = request.headers.get('Content-Type') || '';
  const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new InstagramWebhookError('instagram_webhook_content_type_invalid', 415);
  }
}

async function readBoundedBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > MAX_WEBHOOK_BYTES) {
    throw new InstagramWebhookError('instagram_webhook_too_large', 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new InstagramWebhookError('instagram_webhook_empty', 400);
  if (bytes.byteLength > MAX_WEBHOOK_BYTES) {
    throw new InstagramWebhookError('instagram_webhook_too_large', 413);
  }
  return bytes;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolves the artist that owns an Instagram professional account.
 *
 * Results are memoised per request only. A cache that outlived the request
 * would let a disconnect take effect late, which is exactly the window in
 * which a route must fail closed.
 */
async function resolveRoute(supabase, cache, instagramUserId) {
  if (cache.has(instagramUserId)) return cache.get(instagramUserId);

  let route = null;
  try {
    const resolved = firstRow(await supabase.rpc('service_resolve_instagram_route', {
      p_instagram_user_id: instagramUserId,
    }));
    if (
      resolved
      && typeof resolved.artist_id === 'string'
      && typeof resolved.integration_key === 'string'
      && resolved.instagram_user_id === instagramUserId
    ) {
      route = resolved;
    }
  } catch {
    // An unknown or disabled account raises. That is the fail-closed path, and
    // it must not become an error response Meta would keep retrying.
    route = null;
  }

  cache.set(instagramUserId, route);
  return route;
}

async function ingestEvent(event, entryAccountId, route, supabase, counters) {
  const senderId = typeof event?.sender?.id === 'string' ? event.sender.id.trim() : '';
  const recipientId = typeof event?.recipient?.id === 'string' ? event.recipient.id.trim() : '';
  const providerTimestamp = parseProviderTimestamp(event?.timestamp);
  if (!PROVIDER_ID.test(senderId) || !PROVIDER_ID.test(recipientId) || !providerTimestamp) {
    counters.skipped += 1;
    return;
  }

  // Read receipt: the participant reports the newest message they have seen.
  if (event?.read && typeof event.read === 'object') {
    const mid = typeof event.read.mid === 'string' ? event.read.mid.trim() : '';
    if (!MESSAGE_ID.test(mid) || senderId === entryAccountId) {
      counters.skipped += 1;
      return;
    }
    await supabase.rpc('record_communication_read_receipt', {
      p_artist_id: route.artist_id,
      p_channel: 'instagram',
      p_integration_key: route.integration_key,
      p_external_contact_id: senderId,
      p_provider_message_id: mid,
      p_provider_timestamp: providerTimestamp,
    });
    counters.read += 1;
    return;
  }

  if (!event?.message) {
    // Reactions, postbacks and any event type this release does not interpret
    // are ignored without persistence. An unknown event must never corrupt
    // domain state, and it must never fail the delivery either.
    counters.ignored += 1;
    return;
  }

  const normalised = normaliseMessage(event.message);
  if (!normalised) {
    counters.skipped += 1;
    return;
  }

  if (normalised.isEcho) {
    // On an echo the business account is the sender and the participant is the
    // recipient. An echo that does not come from the account this entry names
    // is not this artist's message.
    if (senderId !== entryAccountId) {
      counters.skipped += 1;
      return;
    }
    await supabase.rpc('record_communication_outbound_echo', {
      p_artist_id: route.artist_id,
      p_channel: 'instagram',
      p_integration_key: route.integration_key,
      p_external_contact_id: recipientId,
      p_provider_message_id: normalised.mid,
      p_provider_timestamp: providerTimestamp,
      p_message_type: normalised.messageType,
      p_body: normalised.body,
      p_attachments: normalised.attachments,
    });
    counters.echoes += 1;
    return;
  }

  // An inbound message is addressed to the account this entry names.
  if (recipientId !== entryAccountId) {
    counters.skipped += 1;
    return;
  }

  await supabase.rpc('record_communication_inbound_message', {
    p_artist_id: route.artist_id,
    p_channel: 'instagram',
    p_integration_key: route.integration_key,
    p_external_contact_id: senderId,
    p_provider_message_id: normalised.mid,
    p_provider_timestamp: providerTimestamp,
    p_message_type: normalised.messageType,
    p_body: normalised.body,
    p_attachments: normalised.attachments,
    p_provider_referral: normaliseReferral(event.message.referral ?? event.referral),
  });
  counters.inbound += 1;
}

export async function processPayload(payload, supabase) {
  const counters = { inbound: 0, echoes: 0, read: 0, skipped: 0, ignored: 0, unrouted: 0 };
  if (payload?.object !== 'instagram' || !Array.isArray(payload?.entry)) return counters;

  const routeCache = new Map();
  let processed = 0;

  for (const entry of payload.entry) {
    const accountId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!PROVIDER_ID.test(accountId) || !Array.isArray(entry?.messaging)) continue;

    const route = await resolveRoute(supabase, routeCache, accountId);
    if (!route) {
      // Fail closed: an account this CRM does not own produces nothing.
      counters.unrouted += 1;
      continue;
    }

    for (const event of entry.messaging) {
      if (processed >= MAX_EVENTS_PER_REQUEST) return counters;
      processed += 1;
      await ingestEvent(event, accountId, route, supabase, counters);
    }
  }

  return counters;
}

export async function handleInstagramWebhook(request, env, supabase = null) {
  const url = new URL(request.url);
  if (url.pathname !== INSTAGRAM_WEBHOOK_PATH) return new Response('Not found', { status: 404 });

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode') || '';
    const suppliedToken = url.searchParams.get('hub.verify_token') || '';
    const challenge = url.searchParams.get('hub.challenge') || '';
    const expectedToken = typeof env?.INSTAGRAM_WEBHOOK_VERIFY_TOKEN === 'string'
      ? env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
      : '';

    if (
      mode !== 'subscribe'
      || !expectedToken
      || !challenge
      || !constantTimeEqual(suppliedToken, expectedToken)
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  try {
    assertJsonContentType(request);
    if (!supabase || typeof supabase.rpc !== 'function') {
      throw new InstagramWebhookError('instagram_webhook_database_unavailable', 503);
    }

    const appSecret = typeof env?.INSTAGRAM_APP_SECRET === 'string' ? env.INSTAGRAM_APP_SECRET : '';
    if (appSecret.length < 16) {
      throw new InstagramWebhookError('instagram_webhook_not_configured', 503);
    }

    const rawBytes = await readBoundedBody(request);
    const signed = await verifyWebhookSignature(
      rawBytes,
      request.headers.get('X-Hub-Signature-256'),
      appSecret,
    );
    if (!signed) throw new InstagramWebhookError('instagram_webhook_signature_invalid', 401);

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBytes));
    } catch {
      throw new InstagramWebhookError('instagram_webhook_json_invalid', 400);
    }

    await processPayload(payload, supabase);
    return new Response('EVENT_RECEIVED', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  } catch (error) {
    if (error instanceof InstagramWebhookError) return jsonError(error.status);
    return jsonError(503);
  }
}

export const __testing = Object.freeze({
  ingestEvent,
  resolveRoute,
  MAX_EVENTS_PER_REQUEST,
});
