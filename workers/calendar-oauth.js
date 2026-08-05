const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';
const STATE_TTL_SECONDS = 600;

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function decodeKey(value) {
  if (!value) throw new Error('CALENDAR_TOKEN_ENCRYPTION_KEY is missing');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('CALENDAR_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return bytes;
}

async function encryptionKey(env) {
  return crypto.subtle.importKey('raw', decodeKey(env.CALENDAR_TOKEN_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptJson(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({ v: 1, iv: base64Url(iv), data: base64Url(new Uint8Array(encrypted)) });
}

function artistConfig(alias, env) {
  const configs = {
    vladimir: {
      artistId: env.VLADIMIR_ARTIST_ID,
      expectedEmail: env.VLADIMIR_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_vladimir',
    },
    kristina: {
      artistId: env.KRISTINA_ARTIST_ID,
      expectedEmail: env.KRISTINA_GOOGLE_EMAIL,
      integrationKey: 'google_calendar_kristina',
    },
  };
  const config = configs[alias];
  if (!config?.artistId || !config?.expectedEmail) return null;
  return config;
}

function accessEmail(request) {
  return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
}

function requireOwnerAccess(request, env) {
  const email = accessEmail(request);
  const allowed = (env.CALENDAR_OWNER_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(email && allowed.includes(email));
}

async function updateIntegrationMetadata(config, accountEmail, enabled, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase backend configuration is missing');
  }
  const url = `${env.SUPABASE_URL}/rest/v1/artist_integrations?on_conflict=artist_id,integration_type,integration_key`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      artist_id: config.artistId,
      integration_type: 'calendar',
      provider: 'google',
      integration_key: config.integrationKey,
      external_account_label: accountEmail,
      configuration: {
        calendar_id: 'primary',
        oauth_scope: 'calendar.events',
        connection_mode: 'worker_oauth',
      },
      is_enabled: enabled,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Supabase metadata update failed: ${response.status}`);
}

async function startOAuth(request, alias, env) {
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);

  const state = randomToken();
  const verifier = randomToken(64);
  const challenge = await sha256Base64Url(verifier);
  await env.CALENDAR_OAUTH_STATE.put(`state:${state}`, JSON.stringify({ alias, verifier }), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

async function callback(request, env) {
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return json({ ok: false, code: 'google_authorisation_denied' }, 400);
  if (!state || !code) return json({ ok: false, code: 'oauth_callback_invalid' }, 400);

  const stateKey = `state:${state}`;
  const stored = await env.CALENDAR_OAUTH_STATE.get(stateKey, 'json');
  await env.CALENDAR_OAUTH_STATE.delete(stateKey);
  if (!stored?.alias || !stored?.verifier) return json({ ok: false, code: 'oauth_state_invalid_or_expired' }, 400);

  const config = artistConfig(stored.alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 400);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      code_verifier: stored.verifier,
      grant_type: 'authorization_code',
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }),
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) {
    return json({ ok: false, code: 'google_token_exchange_failed' }, 502);
  }

  const userResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userResponse.json();
  const accountEmail = String(user.email || '').toLowerCase();
  if (!userResponse.ok || !user.email_verified || accountEmail !== config.expectedEmail.toLowerCase()) {
    return json({ ok: false, code: 'google_account_mismatch' }, 403);
  }

  await env.CALENDAR_OAUTH_TOKENS.put(
    `artist:${config.artistId}`,
    await encryptJson({
      refreshToken: tokens.refresh_token,
      scope: tokens.scope || OAUTH_SCOPE,
      accountEmail,
      connectedAt: new Date().toISOString(),
    }, env),
  );
  await updateIntegrationMetadata(config, accountEmail, true, env);

  const destination = new URL(env.CRM_RETURN_URL || 'https://vishar-crm-staging.pages.dev/appointments');
  destination.searchParams.set('calendar', 'connected');
  destination.searchParams.set('artist', stored.alias);
  return Response.redirect(destination.toString(), 302);
}

async function disconnect(request, alias, env) {
  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
  if (!requireOwnerAccess(request, env)) return json({ ok: false, code: 'owner_access_required' }, 403);
  const config = artistConfig(alias, env);
  if (!config) return json({ ok: false, code: 'artist_route_unconfigured' }, 404);
  await env.CALENDAR_OAUTH_TOKENS.delete(`artist:${config.artistId}`);
  await updateIntegrationMetadata(config, config.expectedEmail, false, env);
  return json({ ok: true, artist: alias, connected: false });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'vishar-calendar-oauth', environment: env.VISHAR_ENVIRONMENT || 'unknown' });
      }
      const startMatch = url.pathname.match(/^\/oauth\/google\/start\/(vladimir|kristina)$/);
      if (request.method === 'GET' && startMatch) return startOAuth(request, startMatch[1], env);
      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') return callback(request, env);
      const disconnectMatch = url.pathname.match(/^\/oauth\/google\/disconnect\/(vladimir|kristina)$/);
      if (disconnectMatch) return disconnect(request, disconnectMatch[1], env);
      return json({ ok: false, code: 'not_found' }, 404);
    } catch (error) {
      console.error('calendar oauth worker failure', error);
      return json({ ok: false, code: 'calendar_connector_error' }, 500);
    }
  },
};
