import { handleGptActionsRequest } from './lib/gpt-actions-combined.js';

const PUBLIC_HEADERS = Object.freeze({
  'cache-control': 'public, max-age=300',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
});
const PRIVATE_JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});
const JWT_BEARER_PATTERN = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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
<p>After an authorised CRM staff member signs in through Supabase OAuth, the action service can access only the single artist permanently bound to that GPT OAuth client. The action API does not accept an artist identifier from ChatGPT.</p>
<ul>
<li>Read and manage that artist's enquiries, projects, appointments, availability, internal notes and follow-ups when the corresponding capability is enabled.</li>
<li>Read a specific linked client's contact details when operational CRM management is enabled. Bulk client lists remain minimised.</li>
<li>Read and manage finance or communications only when those independent owner-controlled capabilities are enabled and the signed-in CRM user also has the required permission.</li>
<li>Read only safe metadata for private reference files; private Storage paths, checksums and file bytes are not exposed by GPT Actions.</li>
</ul>

<h2>Data deliberately excluded</h2>
<p>The GPT action surface does not expose OAuth client secrets, provider credentials, privileged Supabase credentials, arbitrary SQL, generic table access, team-access administration, RLS or Storage policy controls. Private file bytes remain behind the existing CRM Storage boundary.</p>

<h2>Authentication and artist separation</h2>
<p>Authentication uses Supabase OAuth. The access token keeps the signed-in human identity. A separate OAuth client is registered for each private GPT and bound in the CRM database to exactly one artist. Database membership and operation-specific permissions are checked again for every action.</p>

<h2>Changes made through the GPT</h2>
<p>Operational mutations use the same audited CRM RPCs as the human interface wherever those workflows already exist. Appointment and availability changes preserve the Calendar outbox/version boundary. Payment and provider-delivery actions preserve their existing idempotency, routing and credential-custody controls.</p>

<h2>Providers</h2>
<p>OpenAI provides ChatGPT and the private GPT interface. Cloudflare hosts the action endpoint. Supabase provides authentication and the CRM database. Other providers such as Google Calendar, email or messaging services are contacted only through separately configured artist integrations and their existing CRM workflows.</p>

<h2>Retention and production boundary</h2>
<p>Only synthetic staging records may be used during staging validation. Production activation is a separate gated deployment and configuration step.</p>

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

function malformedOAuthBearer(request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ') || JWT_BEARER_PATTERN.test(authorization)) return null;
  return new Response(JSON.stringify({ error: 'oauth_token_required' }), {
    status: 401,
    headers: PRIVATE_JSON_HEADERS,
  });
}

function normalizedActionEnv(env) {
  if (typeof env?.SUPABASE_PUBLISHABLE_KEY !== 'string') return env;
  const trimmed = env.SUPABASE_PUBLISHABLE_KEY.trim();
  if (trimmed === env.SUPABASE_PUBLISHABLE_KEY) return env;
  return { ...env, SUPABASE_PUBLISHABLE_KEY: trimmed };
}

async function noFollowFetch(input, init = {}) {
  return fetch(input, { ...init, redirect: 'manual' });
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

    const malformedBearerResponse = malformedOAuthBearer(request);
    if (malformedBearerResponse) return malformedBearerResponse;

    const response = await handleGptActionsRequest(
      request,
      normalizedActionEnv(env),
      noFollowFetch,
    );
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
        headers: PRIVATE_JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify(omitNullFields(parsed)), {
      status: response.status,
      headers: response.headers,
    });
  },
};

export const __testing = Object.freeze({
  publicRoute,
  malformedOAuthBearer,
  normalizedActionEnv,
  noFollowFetch,
});
