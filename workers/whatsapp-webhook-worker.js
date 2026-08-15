import { createSupabaseClient } from './lib/supabase.js';
import { handleWhatsappWebhook, WHATSAPP_WEBHOOK_PATH } from './lib/whatsapp-webhook.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET verification does not need a database credential. Unknown paths also
    // stay independent of privileged configuration.
    if (request.method === 'GET' || url.pathname !== WHATSAPP_WEBHOOK_PATH) {
      return handleWhatsappWebhook(request, env, null);
    }

    let supabase;
    try {
      supabase = createSupabaseClient(env);
    } catch {
      return new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return handleWhatsappWebhook(request, env, supabase);
  },
};
