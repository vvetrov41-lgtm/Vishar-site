import { handleGptActionsRequest } from './lib/gpt-actions.js';

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
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.55;background:#0b0b0b;color:#f4f4f4}
  h1,h2{line-height:1.2}h1{font-size:2rem}h2{margin-top:2rem;font-size:1.2rem}p,li{color:#d4d4d4}a{color:#fff}
</style>
</head>
<body>
<h1>Vishar CRM Private GPT Actions Privacy Notice</h1>
<p><strong>Staging notice.</strong> This private integration is being tested with synthetic retained-staging data only. It is not a public booking service and it is not connected to production CRM data.</p>

<h2>What the private GPT can access</h2>
<p>After an authorised CRM staff member signs in through Supabase OAuth, the action service can access only appointment functions for the single artist permanently bound to that GPT OAuth client. The action API does not accept an artist identifier from ChatGPT.</p>
<ul>
<li>Search existing client names in that artist scope, returning only client ID and name.</li>
<li>List and read that artist's appointments.</li>
<li>Check appointment conflicts.</li>
<li>Create, reschedule or cancel appointments when the signed-in CRM user also has the required permission.</li>
</ul>

<h2>Data deliberately excluded</h2>
<p>The GPT action surface does not expose client email addresses, phone numbers, Instagram handles, addresses, finance, payments, arbitrary database queries or service-role credentials. It does not provide an action for sending client messages.</p>

<h2>Authentication and artist separation</h2>
<p>Authentication uses the retained-staging Supabase OAuth server. The OAuth access token keeps the signed-in human identity. A separate OAuth client is registered for each private GPT, and its client ID is bound in the CRM database to exactly one artist. Database membership and appointment permissions are checked again for every action.</p>

<h2>Changes made through the GPT</h2>
<p>Appointment writes use idempotency request IDs. Reschedule and cancellation require the current calendar version to reduce accidental overwrites. AI-assisted mutations are written to the CRM activity log with the authenticated staff identity and fixed artist scope. Calendar synchronisation then follows the same CRM outbox used by human CRM actions.</p>

<h2>Providers</h2>
<p>OpenAI provides ChatGPT and the private GPT interface. Cloudflare hosts the staging action endpoint. Supabase provides retained-staging authentication and the CRM database. Google Calendar may receive synthetic appointment data through the separately authorised staging calendar integration during testing.</p>

<h2>Retention and production boundary</h2>
<p>Only synthetic staging records may be used during this validation stage. The retained staging environment is not reset as part of normal testing. Production data, production credentials and production endpoints are outside this integration stage.</p>

<h2>Contact</h2>
<p>Questions about this private integration can be sent to <a href="mailto:info@vishartattoo.com">info@vishartattoo.com</a>.</p>
</body>
</html>`;

function publicRoute(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.pathname !== '/privacy' && url.pathname !== '/privacy/') return null;
  return new Response(request.method === 'HEAD' ? null : PRIVACY_HTML, {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

export function omitNullFields(value) {
  if (Array.isArray(value)) return value.map(omitNullFields);
  if (!value || typeof value !== 'object') return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== null) clean[key] = omitNullFields(child);
  }
  return clean;
}

export default {
  async fetch(request, env) {
    const publicResponse = publicRoute(request);
    if (publicResponse) return publicResponse;

    const response = await handleGptActionsRequest(request, env);
    const contentType = response.headers.get('content-type') || '';
    if (response.status < 200 || response.status >= 300 || !contentType.includes('application/json')) {
      return response;
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_gateway_response' }), {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return new Response(JSON.stringify(omitNullFields(parsed)), {
      status: response.status,
      headers: response.headers,
    });
  },
};

export const __testing = Object.freeze({ publicRoute });
