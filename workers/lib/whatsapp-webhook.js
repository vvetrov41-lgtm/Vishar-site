// Meta WhatsApp webhook handling.
//
// This is the only public surface the WhatsApp integration has, and it exists
// because Meta must be able to reach it: Cloudflare Access cannot sit in front
// of it. Everything else about it is therefore deliberately narrow.
//
// Authenticity comes first. Meta signs every delivery with HMAC-SHA256 over
// the exact raw body using the Meta app secret, and sends it as
// `X-Hub-Signature-256: sha256=<hex>`. The body is verified against the
// configured artist app secrets before it is parsed, and the artist is then
// resolved from the payload's `phone_number_id` by matching it against those
// same encrypted bindings. A payload naming a phone number this Worker does
// not hold a binding for is refused outright, so nothing in the webhook body
// can select an artist, an integration or a destination.
//
// The verify-then-parse order matters. Parsing an unverified body would let an
// unauthenticated caller steer routing, so the signature is checked against
// every configured binding first and the artist is only resolved afterwards —
// and the binding that verified the signature must be the same one the phone
// number resolves to.

import { bindingNameFor } from './provider-routing.js';

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const PHONE_NUMBER_ID = /^[0-9]{5,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const PROVIDER_MESSAGE_ID = /^[A-Za-z0-9_=./-]{8,255}$/;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;

// Meta status values this CRM understands. Anything else is acknowledged and
// ignored rather than guessed at.
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

export class WebhookError extends Error {
  constructor(code, status) {
    super('whatsapp webhook request rejected');
    this.name = 'WebhookError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads the artist WhatsApp bindings this Worker holds.
 *
 * The integration keys are configuration, not payload: they come from
 * `WHATSAPP_INTEGRATION_KEYS`, and each names an encrypted binding. There is
 * no wildcard and no global binding, so an artist without a configured key
 * simply has no inbound route.
 */
export function readWhatsappBindings(env) {
  const raw = typeof env?.WHATSAPP_INTEGRATION_KEYS === 'string'
    ? env.WHATSAPP_INTEGRATION_KEYS
    : '';
  const keys = raw.split(',').map((key) => key.trim()).filter(Boolean);
  if (!keys.length) throw new WebhookError('whatsapp_not_configured', 503);

  const bindings = [];
  for (const integrationKey of keys) {
    if (!INTEGRATION_KEY.test(integrationKey)) {
      throw new WebhookError('whatsapp_not_configured', 503);
    }
    const raw2 = env?.[bindingNameFor('whatsapp', integrationKey)];
    if (typeof raw2 !== 'string' || !raw2) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw2);
    } catch {
      continue;
    }
    const phoneNumberId = typeof parsed?.phoneNumberId === 'string' ? parsed.phoneNumberId.trim() : '';
    const appSecret = typeof parsed?.appSecret === 'string' ? parsed.appSecret : '';
    if (!PHONE_NUMBER_ID.test(phoneNumberId) || !appSecret) continue;
    bindings.push({ integrationKey, phoneNumberId, appSecret });
  }

  if (!bindings.length) throw new WebhookError('whatsapp_not_configured', 503);
  return bindings;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time comparison; both inputs are fixed-length SHA-256 digests. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function signatureMatches(appSecret, rawBody, expected) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  );
  return timingSafeEqual(digest, expected);
}

/**
 * Verifies the delivery against every configured binding and returns the ones
 * whose app secret produced the signature. Two artists onboarded through the
 * same Meta app share an app secret, so this can legitimately match more than
 * one binding; the phone number decides which artist the payload is for.
 */
export async function verifySignature(bindings, rawBody, header) {
  const match = SIGNATURE.exec(typeof header === 'string' ? header.trim() : '');
  if (!match) throw new WebhookError('signature_missing', 401);
  const expected = hexToBytes(match[1]);

  const verified = [];
  for (const binding of bindings) {
    if (await signatureMatches(binding.appSecret, rawBody, expected)) verified.push(binding);
  }
  if (!verified.length) throw new WebhookError('signature_invalid', 401);
  return verified;
}

/** Meta's subscription handshake. */
export function handleVerification(env, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = typeof env?.WHATSAPP_VERIFY_TOKEN === 'string' ? env.WHATSAPP_VERIFY_TOKEN : '';

  if (!expected) throw new WebhookError('whatsapp_not_configured', 503);
  if (mode !== 'subscribe' || !challenge) throw new WebhookError('verification_invalid', 400);

  // Fixed-length compare on the configured token.
  const provided = typeof token === 'string' ? token : '';
  if (provided.length !== expected.length) throw new WebhookError('verification_invalid', 403);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) throw new WebhookError('verification_invalid', 403);

  // Meta expects the raw challenge value echoed back as the body.
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function metaTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  // Control characters have no place in a message body and can forge line
  // breaks in anything that later renders the timeline as text.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4096);
}

/**
 * Flattens one verified delivery into the operations the database understands.
 *
 * Anything unrecognised is dropped rather than guessed at, which is what lets
 * the Worker acknowledge unknown Meta fields with 200 instead of failing and
 * causing Meta to retry forever.
 */
export function planOperations(payload, bindings) {
  if (payload?.object !== 'whatsapp_business_account') return [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const byPhoneNumberId = new Map(bindings.map((binding) => [binding.phoneNumberId, binding]));
  const operations = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (value?.messaging_product !== 'whatsapp') continue;

      const phoneNumberId = typeof value?.metadata?.phone_number_id === 'string'
        ? value.metadata.phone_number_id.trim()
        : '';
      // The decisive routing step: an unknown business phone number resolves to
      // no artist and is dropped, never defaulted.
      const binding = byPhoneNumberId.get(phoneNumberId);
      if (!binding) continue;

      const contactsByWaId = new Map();
      for (const contact of Array.isArray(value?.contacts) ? value.contacts : []) {
        const waId = typeof contact?.wa_id === 'string' ? contact.wa_id.trim() : '';
        const name = typeof contact?.profile?.name === 'string' ? contact.profile.name : '';
        if (WA_ID.test(waId) && name) contactsByWaId.set(waId, safeText(name).slice(0, 160));
      }

      if (change?.field === 'messages') {
        for (const message of Array.isArray(value?.messages) ? value.messages : []) {
          const from = typeof message?.from === 'string' ? message.from.trim() : '';
          const id = typeof message?.id === 'string' ? message.id : '';
          if (!WA_ID.test(from) || !PROVIDER_MESSAGE_ID.test(id)) continue;
          const type = typeof message?.type === 'string' ? message.type : 'text';
          operations.push({
            kind: 'inbound',
            integrationKey: binding.integrationKey,
            contactWaId: from,
            providerMessageId: id,
            messageType: /^[a-z][a-z0-9_]{1,31}$/.test(type) ? type : 'text',
            body: safeText(message?.text?.body),
            providerTimestamp: metaTimestamp(message?.timestamp),
            contactLabel: contactsByWaId.get(from) ?? null,
          });
        }

        for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
          const id = typeof status?.id === 'string' ? status.id : '';
          const state = typeof status?.status === 'string' ? status.status : '';
          if (!PROVIDER_MESSAGE_ID.test(id) || !STATUSES.has(state)) continue;
          operations.push({
            kind: 'status',
            integrationKey: binding.integrationKey,
            providerMessageId: id,
            status: state,
            providerTimestamp: metaTimestamp(status?.timestamp),
            // Meta's error object shape is not fully documented, so only a
            // stable machine code is derived and the rest is discarded.
            errorCode: state === 'failed' ? 'whatsapp_provider_reported_failure' : null,
          });
        }
        continue;
      }

      if (change?.field === 'smb_message_echoes') {
        // Coexistence: the artist sent this from the WhatsApp Business App.
        for (const echo of Array.isArray(value?.message_echoes) ? value.message_echoes : []) {
          const to = typeof echo?.to === 'string' ? echo.to.trim() : '';
          const id = typeof echo?.id === 'string' ? echo.id : '';
          if (!WA_ID.test(to) || !PROVIDER_MESSAGE_ID.test(id)) continue;
          const type = typeof echo?.type === 'string' ? echo.type : 'text';
          // Revocations and edits are acknowledged but not yet applied; they
          // would need their own timeline semantics rather than a silent
          // rewrite of an existing message.
          if (type === 'revoke' || type === 'edit') continue;
          operations.push({
            kind: 'echo',
            integrationKey: binding.integrationKey,
            contactWaId: to,
            providerMessageId: id,
            messageType: /^[a-z][a-z0-9_]{1,31}$/.test(type) ? type : 'text',
            body: safeText(echo?.text?.body),
            providerTimestamp: metaTimestamp(echo?.timestamp),
          });
        }
      }

      // `history` and `smb_app_state_sync` are acknowledged and intentionally
      // not ingested here. History import needs its own chunked, resumable
      // handling and a separate consent decision.
    }
  }

  return operations;
}

export async function applyOperations(supabase, operations) {
  const applied = { inbound: 0, echo: 0, status: 0, ignored: 0 };
  for (const operation of operations) {
    if (operation.kind === 'inbound') {
      await supabase.rpc('record_whatsapp_inbound_message', {
        p_integration_key: operation.integrationKey,
        p_contact_wa_id: operation.contactWaId,
        p_provider_message_id: operation.providerMessageId,
        p_message_type: operation.messageType,
        p_body: operation.body,
        p_provider_timestamp: operation.providerTimestamp,
        p_contact_label: operation.contactLabel,
      });
      applied.inbound += 1;
    } else if (operation.kind === 'echo') {
      await supabase.rpc('record_whatsapp_echo_message', {
        p_integration_key: operation.integrationKey,
        p_contact_wa_id: operation.contactWaId,
        p_provider_message_id: operation.providerMessageId,
        p_message_type: operation.messageType,
        p_body: operation.body,
        p_provider_timestamp: operation.providerTimestamp,
      });
      applied.echo += 1;
    } else if (operation.kind === 'status') {
      await supabase.rpc('record_whatsapp_status_update', {
        p_integration_key: operation.integrationKey,
        p_provider_message_id: operation.providerMessageId,
        p_status: operation.status,
        p_provider_timestamp: operation.providerTimestamp,
        p_error_code: operation.errorCode,
      });
      applied.status += 1;
    } else {
      applied.ignored += 1;
    }
  }
  return applied;
}

export async function readRawBody(request) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    throw new WebhookError('request_too_large', 413);
  }
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new WebhookError('json_required', 415);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_WEBHOOK_BYTES) {
    throw new WebhookError('request_too_large', 413);
  }
  return text;
}

export const __testing = { timingSafeEqual, safeText, metaTimestamp, STATUSES };
