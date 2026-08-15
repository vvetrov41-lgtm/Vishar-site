// Public Meta WhatsApp webhook endpoint.
//
// Meta must be able to reach this Worker, so Cloudflare Access cannot sit in
// front of it. The surface is therefore kept to exactly two operations on one
// path, and every other request terminates in a 404 without touching Supabase.
//
// It is inert by default: unless WHATSAPP_WEBHOOK_ENABLED is exactly "true"
// the Worker answers 503 and never reads a binding, never parses a body and
// never contacts the database.

import { createSupabaseClient } from './lib/supabase.js';
import {
  WebhookError,
  applyOperations,
  handleVerification,
  planOperations,
  readRawBody,
  readWhatsappBindings,
  verifySignature,
} from './lib/whatsapp-webhook.js';

const WEBHOOK_PATH = '/webhooks/whatsapp';

// Server-to-server callback: no browser ever calls this, so no CORS surface is
// offered and nothing here is cacheable.
const securityHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: securityHeaders });
}

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(code)
    ? code
    : 'whatsapp_webhook_error';
}

export async function handleWhatsappWebhook(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);

  if (url.pathname !== WEBHOOK_PATH) return json({ ok: false, code: 'not_found' }, 404);
  if (env?.WHATSAPP_WEBHOOK_ENABLED !== 'true') {
    return json({ ok: false, code: 'whatsapp_webhook_disabled' }, 503);
  }

  if (request.method === 'GET') {
    const response = handleVerification(env, url);
    for (const [name, value] of Object.entries(securityHeaders)) {
      response.headers.set(name, value);
    }
    return response;
  }

  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);

  const bindings = readWhatsappBindings(env);
  const rawBody = await readRawBody(request);

  // Authenticity is established before the body is parsed, so an unverified
  // caller can never influence artist routing.
  const verified = await verifySignature(bindings, rawBody, request.headers.get('X-Hub-Signature-256'));

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new WebhookError('json_invalid', 400);
  }

  // Only bindings whose app secret actually signed this delivery may be used
  // to resolve an artist.
  const operations = planOperations(payload, verified);
  if (!operations.length) {
    // Unrecognised or unroutable deliveries are acknowledged. Returning an
    // error would make Meta retry a payload this CRM will never accept.
    return json({ ok: true, ignored: true }, 202);
  }

  const supabase = createSupabaseClient(env, fetchImpl);
  const applied = await applyOperations(supabase, operations);

  // Counts only. No contact number, message body or provider id is logged.
  console.log('whatsapp webhook', JSON.stringify(applied));
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleWhatsappWebhook(request, env);
    } catch (error) {
      if (error instanceof WebhookError) {
        return json({ ok: false, code: error.code }, error.status);
      }
      console.error('whatsapp webhook failure', JSON.stringify({ code: safeCode(error) }));
      return json({ ok: false, code: 'whatsapp_webhook_error' }, 500);
    }
  },
};

export const __testing = { WEBHOOK_PATH, safeCode, securityHeaders };
