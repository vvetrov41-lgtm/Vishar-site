import productionWorker from './gpt-actions-production.js';
import { isGmailHttpActionPath } from './lib/gmail-tool-contract.js';

const OPERATIONS_HOST = 'gpt-operations.vishartattoo.com';
const COMMUNICATIONS_HOST = 'gpt-communications.vishartattoo.com';
const GMAIL_ACTION_HOSTS = new Set([OPERATIONS_HOST, COMMUNICATIONS_HOST]);
const PUBLIC_HEADERS = Object.freeze({
  'cache-control': 'public, max-age=300',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
});

const PRIVACY_HTML = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vishar CRM Private GPT Actions Privacy Notice</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.55;background:#0b0b0b;color:#f4f4f4}h1,h2{line-height:1.2}h1{font-size:2rem}h2{margin-top:2rem;font-size:1.2rem}p,li{color:#d4d4d4}a{color:#fff}</style>
</head>
<body>
<h1>Vishar CRM Private GPT Actions Privacy Notice</h1>
<p>This private production integration connects an authorised Vishar CRM user to artist-scoped operational CRM. It is not a public booking service.</p>
<h2>Artist scope and authentication</h2>
<p>The target Vishar Unified GPT uses one confidential OAuth application for the signed-in CRM profile and a server-owned active Artist context. The action API does not accept an Artist selector on ordinary CRM actions. Existing legacy artist-bound GPT clients remain fixed to their server-side Artist binding during migration and rollback.</p>
<h2>Operational CRM access</h2>
<p>When independently enabled by the CRM owner, the private GPT may read and manage the authorized active Artist's enquiries, clients, projects, appointments, availability, internal notes and follow-ups. A specific linked client or enquiry detail may include canonical contact information such as email, phone, Instagram, preferred contact method and travelling-from information. Bulk lists remain minimised.</p>
<h2>Finance and communications</h2>
<p>Finance and communications are separate owner-controlled capabilities. If enabled, finance actions may read estimates, deposits and payment requests, request a configured deposit or record an explicitly confirmed manual payment. Communications actions may read Artist-scoped email or WhatsApp history, create and approve email drafts, resolve the canonical WhatsApp conversation and queue an explicitly requested outbound message. Existing provider routing, credential custody, idempotency and human CRM permissions remain authoritative.</p>
<h2>Private files</h2>
<p>GPT Actions expose only bounded metadata for private enquiry or project files, such as file name, type, size, category and upload state. Storage paths, checksums, signed URLs and file bytes are not exposed by this GPT API.</p>
<h2>Data and controls deliberately excluded</h2>
<p>The action surface does not expose OAuth client secrets, provider credentials, privileged Supabase credentials, arbitrary SQL, generic table or generic RPC access, team-role administration, OAuth/integration administration, RLS controls or Storage policy controls.</p>
<h2>Changes made through the GPT</h2>
<p>Operational mutations reuse the existing audited CRM workflows wherever they exist. Appointment and availability changes preserve Calendar version/outbox rules. Payment and provider-delivery actions preserve their existing idempotency and routing boundaries. Consequential Actions are marked as consequential in the GPT schema.</p>
<h2>Providers</h2>
<p>OpenAI provides ChatGPT and the private GPT interface. Cloudflare hosts the public OAuth/action edge. Supabase provides authentication and the CRM database. Google Calendar, Gmail, WhatsApp or payment providers are contacted only through separately configured Artist integrations and their existing CRM workflows.</p>
<h2>Contact</h2>
<p>Questions can be sent to <a href="mailto:info@vishartattoo.com">info@vishartattoo.com</a>.</p>
</body>
</html>`;

function isPrivacyRoute(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const pathname = new URL(request.url).pathname;
  return pathname === '/privacy' || pathname === '/privacy/';
}

function isGmailActionRoute(request) {
  const url = new URL(request.url);
  return GMAIL_ACTION_HOSTS.has(url.hostname) && isGmailHttpActionPath(url.pathname);
}

async function privacyResponse(request, env) {
  if (!isPrivacyRoute(request)) return null;

  const limiter = env?.GPT_RATE_LIMIT;
  if (limiter && typeof limiter.limit === 'function') {
    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await limiter.limit({ key: `privacy:${address}` });
    if (!success) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }
  }

  return new Response(request.method === 'HEAD' ? null : PRIVACY_HTML, {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

async function gmailActionResponse(request, env) {
  if (!isGmailActionRoute(request)) return null;
  if (!env?.GMAIL_SERVICE || typeof env.GMAIL_SERVICE.fetch !== 'function') {
    return new Response(JSON.stringify({ error: 'gmail_provider_unavailable' }), {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return env.GMAIL_SERVICE.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    return (await privacyResponse(request, env))
      || (await gmailActionResponse(request, env))
      || productionWorker.fetch(request, env, ctx);
  },
};

export const __testing = Object.freeze({ isPrivacyRoute, isGmailActionRoute, privacyResponse, gmailActionResponse });
