// Public Meta WhatsApp webhook boundary.
//
// The request body is authenticated before JSON is parsed. After signature
// verification the signed WABA id + phone-number id must match exactly one
// artist-scoped encrypted binding. No request field can choose artist_id,
// integration_key, credential binding or destination.

import { bindingNameFor } from './provider-routing.js';

export const WHATSAPP_WEBHOOK_PATH = '/webhook';
export const MAX_WEBHOOK_BYTES = 256 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[0-9]{5,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const MESSAGE_ID = /^[A-Za-z0-9_=./-]{8,255}$/;
const MESSAGE_TYPE = /^[a-z][a-z0-9_]{1,31}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const ARTIST_BINDING_PREFIX = 'ARTIST_WHATSAPP_';
const PRODUCTION_ROUTE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-production$/;

export class WhatsappWebhookError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'WhatsappWebhookError';
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

export function integrationKeyFromWhatsappBinding(bindingName) {
  if (typeof bindingName !== 'string' || !bindingName.startsWith(ARTIST_BINDING_PREFIX)) return null;
  const encoded = bindingName.slice(ARTIST_BINDING_PREFIX.length);
  if (!encoded) return null;

  let key = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const value = encoded[index];
    if (value === '_') {
      const escaped = encoded[index + 1];
      if (escaped === '_') key += '_';
      else if (escaped === 'H') key += '-';
      else return null;
      index += 1;
      continue;
    }
    if (!/[A-Z0-9]/.test(value)) return null;
    key += value.toLowerCase();
  }

  if (!INTEGRATION_KEY.test(key)) return null;
  try {
    return bindingNameFor('whatsapp', key) === bindingName ? key : null;
  } catch {
    return null;
  }
}

function legacyArtistIdEnv(integrationKey) {
  const match = PRODUCTION_ROUTE.exec(integrationKey);
  if (!match) return null;
  return `WHATSAPP_${match[1].toUpperCase().replace(/-/g, '_')}_ARTIST_ID`;
}

function parseBinding(raw, bindingName, env) {
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new WhatsappWebhookError('whatsapp_webhook_binding_invalid', 503);
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new WhatsappWebhookError('whatsapp_webhook_binding_invalid', 503);
  }

  const phoneNumberId = typeof credentials.phoneNumberId === 'string'
    ? credentials.phoneNumberId.trim()
    : '';
  const wabaId = typeof credentials.wabaId === 'string' ? credentials.wabaId.trim() : '';
  const appSecret = typeof credentials.appSecret === 'string' ? credentials.appSecret : '';
  const envelopeArtistId = typeof credentials.artistId === 'string'
    ? credentials.artistId.trim()
    : '';
  const envelopeIntegrationKey = typeof credentials.integrationKey === 'string'
    ? credentials.integrationKey.trim()
    : '';

  if (!PROVIDER_ID.test(phoneNumberId) || !PROVIDER_ID.test(wabaId)) {
    throw new WhatsappWebhookError('whatsapp_webhook_binding_invalid', 503);
  }
  if (appSecret.length < 16 || appSecret.length > 512) {
    throw new WhatsappWebhookError('whatsapp_webhook_binding_invalid', 503);
  }

  let artistId = envelopeArtistId;
  let integrationKey = envelopeIntegrationKey;
  if (!artistId && !integrationKey) {
    integrationKey = integrationKeyFromWhatsappBinding(bindingName) || '';
    const artistIdEnv = legacyArtistIdEnv(integrationKey);
    artistId = artistIdEnv && typeof env?.[artistIdEnv] === 'string'
      ? env[artistIdEnv].trim()
      : '';
  }

  if (
    !UUID.test(artistId)
    || !INTEGRATION_KEY.test(integrationKey)
    || bindingNameFor('whatsapp', integrationKey) !== bindingName
  ) {
    throw new WhatsappWebhookError('whatsapp_webhook_route_invalid', 503);
  }

  return {
    label: integrationKey,
    artistId,
    integrationKey,
    bindingName,
    phoneNumberId,
    wabaId,
    appSecret,
  };
}

export function readWebhookRoutes(env) {
  const routes = [];

  const bindings = Object.entries(env || {})
    .filter(([name, raw]) => name.startsWith(ARTIST_BINDING_PREFIX) && typeof raw === 'string' && raw)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [bindingName, raw] of bindings) {
    if (!integrationKeyFromWhatsappBinding(bindingName)) {
      throw new WhatsappWebhookError('whatsapp_webhook_route_invalid', 503);
    }
    routes.push(parseBinding(raw, bindingName, env));
  }

  if (routes.length === 0) {
    throw new WhatsappWebhookError('whatsapp_webhook_not_configured', 503);
  }

  for (let left = 0; left < routes.length; left += 1) {
    for (let right = left + 1; right < routes.length; right += 1) {
      if (
        routes[left].bindingName === routes[right].bindingName
        || routes[left].artistId === routes[right].artistId
        || routes[left].integrationKey === routes[right].integrationKey
        || routes[left].phoneNumberId === routes[right].phoneNumberId
      ) {
        throw new WhatsappWebhookError('whatsapp_webhook_route_collision', 503);
      }
    }
  }

  return routes;
}

async function hmacHex(secret, bytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    textBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyWebhookSignature(rawBytes, headerValue, routes) {
  const match = typeof headerValue === 'string' ? SIGNATURE.exec(headerValue.trim()) : null;
  if (!match) return new Set();

  const expected = match[1].toLowerCase();
  const matchedBindings = new Set();
  const digestBySecret = new Map();

  for (const route of routes) {
    let digest = digestBySecret.get(route.appSecret);
    if (!digest) {
      digest = await hmacHex(route.appSecret, rawBytes);
      digestBySecret.set(route.appSecret, digest);
    }
    if (constantTimeEqual(digest, expected)) matchedBindings.add(route.bindingName);
  }

  return matchedBindings;
}

function parseProviderTimestamp(value) {
  if (typeof value !== 'string' || !/^[0-9]{9,11}$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function normaliseMessageType(value) {
  if (typeof value !== 'string') return 'unsupported';
  const lowered = value.toLowerCase();
  return MESSAGE_TYPE.test(lowered) ? lowered : 'unsupported';
}

function resolveSignedRoute(routes, matchedBindings, wabaId, phoneNumberId) {
  const matches = routes.filter((route) => (
    route.wabaId === wabaId
    && route.phoneNumberId === phoneNumberId
    && matchedBindings.has(route.bindingName)
  ));
  return matches.length === 1 ? matches[0] : null;
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
    throw new WhatsappWebhookError('whatsapp_webhook_content_type_invalid', 415);
  }
}

async function readBoundedBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > MAX_WEBHOOK_BYTES) {
    throw new WhatsappWebhookError('whatsapp_webhook_too_large', 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new WhatsappWebhookError('whatsapp_webhook_empty', 400);
  if (bytes.byteLength > MAX_WEBHOOK_BYTES) {
    throw new WhatsappWebhookError('whatsapp_webhook_too_large', 413);
  }
  return bytes;
}

async function ingestMessages(value, route, supabase) {
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  for (const message of messages) {
    const contactWaId = typeof message?.from === 'string' ? message.from.trim() : '';
    const providerMessageId = typeof message?.id === 'string' ? message.id.trim() : '';
    const providerTimestamp = parseProviderTimestamp(message?.timestamp);
    if (!WA_ID.test(contactWaId) || !MESSAGE_ID.test(providerMessageId) || !providerTimestamp) continue;

    const messageType = normaliseMessageType(message?.type);
    let body = null;
    if (messageType === 'text') {
      body = typeof message?.text?.body === 'string' ? message.text.body : '';
      if (!body.trim() || body.length > 4096) continue;
    }

    await supabase.rpc('record_whatsapp_inbound_message', {
      p_artist_id: route.artistId,
      p_integration_key: route.integrationKey,
      p_contact_wa_id: contactWaId,
      p_provider_message_id: providerMessageId,
      p_provider_timestamp: providerTimestamp,
      p_message_type: messageType,
      p_body: body,
    });
  }
}

async function ingestStatuses(value, route, supabase) {
  const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
  for (const status of statuses) {
    const providerMessageId = typeof status?.id === 'string' ? status.id.trim() : '';
    const providerTimestamp = parseProviderTimestamp(status?.timestamp);
    const providerStatus = typeof status?.status === 'string' ? status.status.toLowerCase() : '';
    if (!MESSAGE_ID.test(providerMessageId) || !providerTimestamp) continue;
    if (!['sent', 'delivered', 'read', 'failed'].includes(providerStatus)) continue;

    await supabase.rpc('record_whatsapp_message_status', {
      p_artist_id: route.artistId,
      p_integration_key: route.integrationKey,
      p_provider_message_id: providerMessageId,
      p_status: providerStatus,
      p_provider_timestamp: providerTimestamp,
    });
  }
}

async function processPayload(payload, routes, matchedBindings, supabase) {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload?.entry)) return;

  for (const entry of payload.entry) {
    const wabaId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!PROVIDER_ID.test(wabaId) || !Array.isArray(entry?.changes)) continue;

    for (const change of entry.changes) {
      if (change?.field !== 'messages') continue;
      const value = change?.value;
      const phoneNumberId = typeof value?.metadata?.phone_number_id === 'string'
        ? value.metadata.phone_number_id.trim()
        : '';
      if (!PROVIDER_ID.test(phoneNumberId)) continue;

      const route = resolveSignedRoute(routes, matchedBindings, wabaId, phoneNumberId);
      if (!route) continue;

      await ingestMessages(value, route, supabase);
      await ingestStatuses(value, route, supabase);
      // No smb_message_echoes or other undocumented coexistence event is
      // interpreted here. Unknown change content is ignored without persistence.
    }
  }
}

export async function handleWhatsappWebhook(request, env, supabase = null) {
  const url = new URL(request.url);
  if (url.pathname !== WHATSAPP_WEBHOOK_PATH) return new Response('Not found', { status: 404 });

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode') || '';
    const suppliedToken = url.searchParams.get('hub.verify_token') || '';
    const challenge = url.searchParams.get('hub.challenge') || '';
    const expectedToken = typeof env?.WHATSAPP_WEBHOOK_VERIFY_TOKEN === 'string'
      ? env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
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
      throw new WhatsappWebhookError('whatsapp_webhook_database_unavailable', 503);
    }

    const routes = readWebhookRoutes(env);
    const rawBytes = await readBoundedBody(request);
    const matchedBindings = await verifyWebhookSignature(
      rawBytes,
      request.headers.get('X-Hub-Signature-256'),
      routes
    );
    if (matchedBindings.size === 0) {
      throw new WhatsappWebhookError('whatsapp_webhook_signature_invalid', 401);
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBytes));
    } catch {
      throw new WhatsappWebhookError('whatsapp_webhook_json_invalid', 400);
    }

    await processPayload(payload, routes, matchedBindings, supabase);
    return new Response('EVENT_RECEIVED', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  } catch (error) {
    if (error instanceof WhatsappWebhookError) return jsonError(error.status);
    return jsonError(503);
  }
}

export const __testing = {
  parseProviderTimestamp,
  normaliseMessageType,
  resolveSignedRoute,
  processPayload,
};
