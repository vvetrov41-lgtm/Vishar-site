const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const ARTIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIST_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const BEARER_PATTERN = /^Bearer\s+([^\s]+)$/i;

export class CalendarCrmSessionError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = 'CalendarCrmSessionError';
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function backendApiKey(env) {
  const secretKey = String(env?.SUPABASE_SECRET_KEY || '').trim();
  const legacyKey = String(env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (
    !env?.SUPABASE_URL
    || secretKey === legacyKey
    || Boolean(secretKey) === Boolean(legacyKey)
  ) {
    throw new CalendarCrmSessionError('calendar_not_configured', 503);
  }
  return secretKey || legacyKey;
}

export function bearerToken(request) {
  const authorization = request?.headers?.get('Authorization') || '';
  const match = authorization.match(BEARER_PATTERN);
  return match?.[1] || '';
}

// The browser never sends an actor email. It sends the Supabase access token it
// already uses for the CRM, and the connector asks Supabase Auth to identify
// that token server-side. The returned email is then only an identity input to
// the backend-only artist capability resolver.
export async function verifiedCrmActorEmail(request, env, fetchImpl = fetch) {
  const token = bearerToken(request);
  if (!token) throw new CalendarCrmSessionError('crm_session_required', 401);

  const response = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: backendApiKey(env),
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    redirect: 'manual',
  });
  const user = await response.json().catch(() => null);
  const email = normalizeEmail(user?.email);
  if (!response.ok || !email || !EMAIL_PATTERN.test(email)) {
    throw new CalendarCrmSessionError('crm_session_required', 401);
  }
  return email;
}

// The Google callback cannot carry the CRM bearer token. Its authority is the
// one-time high-entropy state minted only after a verified CRM session and an
// exact artist capability check. Consume the state before doing anything else,
// then re-run authorization from the actor email stored in that record.
export async function consumeCrmOAuthState(namespace, state) {
  if (!namespace || typeof state !== 'string' || !state) {
    throw new CalendarCrmSessionError('oauth_state_invalid_or_expired', 400);
  }
  const key = `state:${state}`;
  const stored = await namespace.get(key, 'json');
  await namespace.delete(key);
  const actorEmail = normalizeEmail(stored?.ownerEmail);
  const artistId = typeof stored?.artistId === 'string' ? stored.artistId.toLowerCase() : '';
  const alias = typeof stored?.alias === 'string' ? stored.alias : '';
  if (
    !stored
    || !ARTIST_ID_PATTERN.test(artistId)
    || !ARTIST_SLUG_PATTERN.test(alias)
    || typeof stored.verifier !== 'string'
    || stored.verifier.length < 43
    || !actorEmail
    || !EMAIL_PATTERN.test(actorEmail)
  ) {
    throw new CalendarCrmSessionError('oauth_state_invalid_or_expired', 400);
  }
  return { ...stored, artistId, alias, actorEmail };
}

export const __testing = { backendApiKey, normalizeEmail, EMAIL_PATTERN, BEARER_PATTERN };
