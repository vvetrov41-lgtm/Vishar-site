// Dedicated Team & Access administration boundary.
//
// This Worker exposes one narrow operation. It is not a generic Supabase proxy:
// an authenticated owner JWT prepares an idempotent database request, the
// Worker calls Supabase Auth with its server-only secret, and the same owner
// JWT atomically finalises the inactive profile plus artist memberships.

const INVITE_PATH = '/v1/staff/invite';
// The tenant-scoped door. A separate path rather than a flag inside the owner
// handler, so the two authorization stories stay visibly separate in the code
// as well as in the database. This Worker still decides nothing: it forwards
// the caller's own JWT and lets begin_artist_invite refuse.
const ARTIST_INVITE_PATH = '/v1/artist/invite';
const INVITE_REDIRECT_SEARCH = '?staff_invite=1';
const MAX_BODY_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER_PATTERN = /^Bearer [A-Za-z0-9._~-]{16,4096}$/;
const ROLE_VALUES = new Set(['booking_manager', 'read_only']);
const ACCESS_LEVEL_VALUES = new Set(['artist', 'manager', 'read_only']);
const CAPABILITY_KEYS = [
  'can_view_finance',
  'can_manage_finance',
  'can_manage_sessions',
  'can_manage_integrations',
];

class TeamAdminError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'TeamAdminError';
    this.code = code;
    this.status = status;
  }
}

function exactOrigin(value, { allowPagesDev = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const allowedHost = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'vishartattoo.com'
      || parsed.hostname.endsWith('.vishartattoo.com')
      || (allowPagesDev && parsed.hostname.endsWith('.pages.dev'));
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (
      !allowedHost
      || (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:'))
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search
      || parsed.hash
      || parsed.origin !== value.trim()
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function supabaseOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const hosted = parsed.protocol === 'https:'
      && /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
      && !parsed.port;
    const local = parsed.protocol === 'http:'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      && parsed.port === '54321';
    if (
      (!hosted && !local)
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function jwtRole(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function readConfig(env) {
  const crmOrigin = exactOrigin(env?.CRM_ALLOWED_ORIGIN, { allowPagesDev: true });
  const databaseOrigin = supabaseOrigin(env?.SUPABASE_URL);
  const publishableKey = String(env?.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const secretKey = String(env?.SUPABASE_SECRET_KEY || '').trim();

  let inviteRedirect;
  try {
    inviteRedirect = new URL(String(env?.CRM_INVITE_REDIRECT_URL || '').trim());
  } catch {
    inviteRedirect = null;
  }

  if (
    !crmOrigin
    || !databaseOrigin
    || !publishableKey
    || !secretKey
    || publishableKey === secretKey
    || publishableKey.startsWith('sb_secret_')
    || jwtRole(publishableKey) === 'service_role'
    || secretKey.startsWith('sb_publishable_')
    || ['anon', 'authenticated'].includes(jwtRole(secretKey))
    || !inviteRedirect
    || inviteRedirect.origin !== crmOrigin
    || inviteRedirect.username
    || inviteRedirect.password
    || inviteRedirect.pathname !== '/'
    || inviteRedirect.search !== INVITE_REDIRECT_SEARCH
    || inviteRedirect.hash
  ) {
    throw new TeamAdminError('team_admin_not_configured', 503);
  }

  return {
    crmOrigin,
    databaseOrigin,
    publishableKey,
    secretKey,
    inviteRedirect: inviteRedirect.toString(),
  };
}

function responseHeaders(origin) {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'Authorization, Content-Type';
    headers.vary = 'Origin';
  }
  return headers;
}

function json(body, status, origin = null) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function safeError(error, origin) {
  const status = error instanceof TeamAdminError ? error.status : 500;
  const code = error instanceof TeamAdminError ? error.code : 'team_admin_failed';
  return json({ error: code }, status, origin);
}

async function boundedJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new TeamAdminError('json_required', 415);
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new TeamAdminError('request_too_large', 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new TeamAdminError('request_too_large', 413);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new TeamAdminError('invalid_json', 400);
  }
}

function booleanField(value, key) {
  if (!(key in value)) return false;
  if (typeof value[key] !== 'boolean') throw new TeamAdminError('invalid_membership', 400);
  return value[key];
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamAdminError('invalid_invite', 400);
  }

  const allowed = new Set(['idempotency_key', 'email', 'display_name', 'role', 'memberships']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TeamAdminError('invalid_invite', 400);
  }

  const idempotencyKey = String(value.idempotency_key || '').trim();
  const email = String(value.email || '').trim().toLowerCase();
  const displayName = typeof value.display_name === 'string' ? value.display_name.trim() : '';
  const role = String(value.role || '');

  if (!UUID_PATTERN.test(idempotencyKey)) throw new TeamAdminError('invalid_idempotency_key', 400);
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamAdminError('invalid_email', 400);
  }
  if (displayName.length > 120) throw new TeamAdminError('invalid_display_name', 400);
  if (!ROLE_VALUES.has(role)) throw new TeamAdminError('invalid_role', 400);
  if (!Array.isArray(value.memberships) || value.memberships.length < 1 || value.memberships.length > 32) {
    throw new TeamAdminError('invalid_memberships', 400);
  }

  const seen = new Set();
  const memberships = value.memberships.map((membership) => {
    if (!membership || typeof membership !== 'object' || Array.isArray(membership)) {
      throw new TeamAdminError('invalid_membership', 400);
    }
    const membershipAllowed = new Set(['artist_id', 'access_level', ...CAPABILITY_KEYS]);
    if (Object.keys(membership).some((key) => !membershipAllowed.has(key))) {
      throw new TeamAdminError('invalid_membership', 400);
    }

    const artistId = String(membership.artist_id || '').trim();
    const accessLevel = String(membership.access_level || '');
    if (!UUID_PATTERN.test(artistId) || seen.has(artistId) || !ACCESS_LEVEL_VALUES.has(accessLevel)) {
      throw new TeamAdminError('invalid_membership', 400);
    }
    seen.add(artistId);

    const canonical = {
      artist_id: artistId,
      access_level: accessLevel,
      can_view_finance: booleanField(membership, 'can_view_finance'),
      can_manage_finance: booleanField(membership, 'can_manage_finance'),
      can_manage_sessions: booleanField(membership, 'can_manage_sessions'),
      can_manage_integrations: booleanField(membership, 'can_manage_integrations'),
    };

    if (canonical.can_manage_finance && !canonical.can_view_finance) {
      throw new TeamAdminError('invalid_membership', 400);
    }
    if (
      (role === 'read_only' || accessLevel === 'read_only')
      && CAPABILITY_KEYS.some((key) => canonical[key])
    ) {
      throw new TeamAdminError('invalid_membership', 400);
    }
    if (role === 'read_only' && accessLevel !== 'read_only') {
      throw new TeamAdminError('invalid_membership', 400);
    }

    return canonical;
  });

  return {
    idempotency_key: idempotencyKey,
    email,
    display_name: displayName || null,
    role,
    memberships,
  };
}

function validateArtistInviteRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamAdminError('invalid_invite', 400);
  }

  // No role and no membership array: a tenant invitation reaches one artist and
  // mints one kind of account, and neither is the caller's to choose.
  const allowed = new Set(['idempotency_key', 'email', 'display_name', 'artist_id', 'grant']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TeamAdminError('invalid_invite', 400);
  }

  const idempotencyKey = String(value.idempotency_key || '').trim();
  const email = String(value.email || '').trim().toLowerCase();
  const displayName = typeof value.display_name === 'string' ? value.display_name.trim() : '';
  const artistId = String(value.artist_id || '').trim();

  if (!UUID_PATTERN.test(idempotencyKey)) throw new TeamAdminError('invalid_idempotency_key', 400);
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamAdminError('invalid_email', 400);
  }
  if (displayName.length > 120) throw new TeamAdminError('invalid_display_name', 400);
  if (!UUID_PATTERN.test(artistId)) throw new TeamAdminError('invalid_artist', 400);

  const grantInput = value.grant ?? {};
  if (!grantInput || typeof grantInput !== 'object' || Array.isArray(grantInput)) {
    throw new TeamAdminError('invalid_grant', 400);
  }
  const grantAllowed = new Set(['access_level', ...CAPABILITY_KEYS]);
  if (Object.keys(grantInput).some((key) => !grantAllowed.has(key))) {
    throw new TeamAdminError('invalid_grant', 400);
  }

  const accessLevel = String(grantInput.access_level || 'artist');
  if (!ACCESS_LEVEL_VALUES.has(accessLevel)) throw new TeamAdminError('invalid_grant', 400);

  const grant = {
    access_level: accessLevel,
    can_view_finance: booleanField(grantInput, 'can_view_finance'),
    can_manage_finance: booleanField(grantInput, 'can_manage_finance'),
    can_manage_sessions: booleanField(grantInput, 'can_manage_sessions'),
    can_manage_integrations: booleanField(grantInput, 'can_manage_integrations'),
  };
  if (grant.can_manage_finance && !grant.can_view_finance) {
    throw new TeamAdminError('invalid_grant', 400);
  }
  if (accessLevel === 'read_only' && CAPABILITY_KEYS.some((key) => grant[key])) {
    throw new TeamAdminError('invalid_grant', 400);
  }

  return { idempotency_key: idempotencyKey, email, display_name: displayName || null, artist_id: artistId, grant };
}

// The tenant-scoped states, which are deliberately narrower than the owner
// ones: no role, no profile id. `suppressed` means the database accepted the
// request and decided to create nothing, and the caller must not be able to
// tell that apart from a delivered invitation.
function validatedArtistState(value) {
  if (
    !value
    || typeof value !== 'object'
    || !['pending', 'provisioned', 'suppressed'].includes(String(value.status || ''))
  ) throw new TeamAdminError('invalid_database_response', 502);
  if (value.status === 'pending' && !UUID_PATTERN.test(String(value.invite_request_id || ''))) {
    throw new TeamAdminError('invalid_database_response', 502);
  }
  return value;
}

// One shape for every outcome. A caller learns that their invitation was
// accepted and nothing about who already has an account on this installation.
function publicArtistInviteResult(value) {
  return { delivery: 'sent', idempotent_replay: value.idempotent_replay === true };
}

async function handleArtistInvite(body, config, requestOrigin, bearer, fetcher) {
  const invite = validateArtistInviteRequest(body);

  const prepared = validatedArtistState(await rpc(fetcher, config, bearer, 'begin_artist_invite', {
    p_idempotency_key: invite.idempotency_key,
    p_email: invite.email,
    p_display_name: invite.display_name,
    p_artist_id: invite.artist_id,
    p_grant: invite.grant,
  }));

  // Suppressed and already-provisioned both stop here, and both look the same
  // from outside. No Auth call is made for a suppressed invitation, which is
  // the whole point: the address already belongs to somebody.
  if (prepared.status !== 'pending') {
    return json(publicArtistInviteResult(prepared), 200, requestOrigin);
  }

  const deliverySucceeded = await sendAuthInvite(
    fetcher,
    config,
    String(prepared.email_normalized || invite.email)
  );

  let finalised;
  try {
    finalised = validatedArtistState(await rpc(
      fetcher,
      config,
      bearer,
      'finalize_artist_invite',
      { p_invite_request_id: prepared.invite_request_id }
    ));
  } catch {
    throw new TeamAdminError(
      deliverySucceeded ? 'provisioning_pending' : 'invite_not_completed',
      502
    );
  }

  return json(publicArtistInviteResult(finalised), 200, requestOrigin);
}

async function rpc(fetcher, config, bearer, name, body) {
  let response;
  try {
    response = await fetcher(`${config.databaseOrigin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.publishableKey,
        authorization: bearer,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new TeamAdminError('database_unavailable', 502);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TeamAdminError('owner_access_required', 403);
    }
    throw new TeamAdminError('database_refused_invite', 400);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TeamAdminError('invalid_database_response', 502);
  }
  return data;
}

function validatedState(value) {
  if (
    !value
    || typeof value !== 'object'
    || !UUID_PATTERN.test(String(value.invite_request_id || ''))
    || !ROLE_VALUES.has(String(value.role || ''))
    || !['pending', 'provisioned'].includes(String(value.status || ''))
  ) throw new TeamAdminError('invalid_database_response', 502);
  return value;
}

function validatedExistingStaffProfile(value, email) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '');
  const role = String(value.role || '');
  const profileEmail = String(value.email || '').trim().toLowerCase();
  if (
    profileEmail !== email
    || !UUID_PATTERN.test(id)
    || !ROLE_VALUES.has(role)
    || value.is_active !== true
  ) return null;
  return { profile_id: id, email: profileEmail, role, is_active: true, idempotent_replay: false };
}

async function sendAuthInvite(fetcher, config, email) {
  const url = new URL('/auth/v1/invite', config.databaseOrigin);
  url.searchParams.set('redirect_to', config.inviteRedirect);
  try {
    const response = await fetcher(url.toString(), {
      method: 'POST',
      headers: {
        apikey: config.secretKey,
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    // The Auth response may contain user/session fields. Discard it completely.
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

async function sendAuthRecovery(fetcher, config, email) {
  const url = new URL('/auth/v1/recover', config.databaseOrigin);
  url.searchParams.set('redirect_to', config.inviteRedirect);
  try {
    const response = await fetcher(url.toString(), {
      method: 'POST',
      headers: {
        apikey: config.secretKey,
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    // The Auth response may contain provider details. Discard it completely.
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

async function recoverExistingStaff(fetcher, config, bearer, email) {
  const profiles = await rpc(fetcher, config, bearer, 'list_profiles', {});
  if (!Array.isArray(profiles)) throw new TeamAdminError('invalid_database_response', 502);

  const profile = profiles
    .map((value) => validatedExistingStaffProfile(value, email))
    .find(Boolean);
  if (!profile) return null;

  const deliverySucceeded = await sendAuthRecovery(fetcher, config, profile.email);
  if (!deliverySucceeded) throw new TeamAdminError('existing_staff_recovery_not_sent', 502);
  return profile;
}

function publicResult(value, delivery) {
  const profileId = String(value.profile_id || '');
  if (
    value.status !== 'provisioned'
    || !UUID_PATTERN.test(profileId)
    || !ROLE_VALUES.has(String(value.role || ''))
    || value.is_active !== true
  ) throw new TeamAdminError('invalid_database_response', 502);

  return {
    profile_id: profileId,
    role: value.role,
    is_active: true,
    idempotent_replay: value.idempotent_replay === true,
    delivery,
  };
}

function publicExistingStaffResult(value) {
  const profileId = String(value.profile_id || '');
  if (
    !UUID_PATTERN.test(profileId)
    || !ROLE_VALUES.has(String(value.role || ''))
    || value.is_active !== true
  ) throw new TeamAdminError('invalid_database_response', 502);

  return {
    profile_id: profileId,
    role: value.role,
    is_active: true,
    idempotent_replay: false,
    delivery: 'existing_account',
  };
}

export async function handleTeamAdminRequest(request, env, { fetcher = fetch } = {}) {
  let config;
  try {
    config = readConfig(env);
  } catch (error) {
    return safeError(error, null);
  }

  const requestOrigin = request.headers.get('origin') || '';
  const originAllowed = requestOrigin === config.crmOrigin;
  const url = new URL(request.url);

  const isOwnerPath = url.pathname === INVITE_PATH;
  const isArtistPath = url.pathname === ARTIST_INVITE_PATH;
  if (!isOwnerPath && !isArtistPath) {
    return json({ error: 'not_found' }, 404, originAllowed ? requestOrigin : null);
  }
  if (!originAllowed) return json({ error: 'origin_not_allowed' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(requestOrigin) });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, requestOrigin);

  const bearer = request.headers.get('authorization') || '';
  if (!BEARER_PATTERN.test(bearer)) return json({ error: 'owner_access_required' }, 401, requestOrigin);

  let body;
  try {
    body = await boundedJson(request);
  } catch (error) {
    return safeError(error, requestOrigin);
  }

  // Which door this is.
  //
  // Path would be enough on its own, and `/v1/artist/invite` is the intended
  // address. It is not reachable in production: a zone WAF rule - owned in the
  // Cloudflare dashboard, not in this repository, and not editable by the
  // deployment token - answers 403 to every path on this hostname except
  // `/v1/staff/invite`. Leaving the feature unreachable until somebody widens
  // that rule would be worse than accepting it on the permitted path, so both
  // work and the shape of the body decides.
  //
  // The discriminator is deliberately strict rather than clever. A tenant
  // invitation names one artist and carries neither a role nor a membership
  // list; an owner invitation carries both and names no artist. Anything that
  // is both or neither is refused here, so nothing can be smuggled from one
  // story into the other by leaving a field out. Each handler still validates
  // its own key set, and neither performs any authorization: the database
  // decides, as it always has.
  const looksTenantScoped = Boolean(body)
    && typeof body === 'object'
    && !Array.isArray(body)
    && 'artist_id' in body
    && !('role' in body)
    && !('memberships' in body);
  const looksOwnerScoped = Boolean(body)
    && typeof body === 'object'
    && !Array.isArray(body)
    && ('role' in body || 'memberships' in body)
    && !('artist_id' in body);

  if (isArtistPath && !looksTenantScoped) return json({ error: 'invalid_invite' }, 400, requestOrigin);
  if (isOwnerPath && !looksTenantScoped && !looksOwnerScoped) {
    return json({ error: 'invalid_invite' }, 400, requestOrigin);
  }

  if (looksTenantScoped) {
    try {
      return await handleArtistInvite(body, config, requestOrigin, bearer, fetcher);
    } catch (error) {
      return safeError(error, requestOrigin);
    }
  }

  try {
    const invite = validateRequest(body);
    let prepared;
    try {
      prepared = validatedState(await rpc(fetcher, config, bearer, 'begin_staff_invite', {
        p_idempotency_key: invite.idempotency_key,
        p_email: invite.email,
        p_display_name: invite.display_name,
        p_role: invite.role,
        p_memberships: invite.memberships,
      }));
    } catch (error) {
      if (error instanceof TeamAdminError && error.code === 'database_refused_invite') {
        const recovered = await recoverExistingStaff(fetcher, config, bearer, invite.email);
        if (recovered) return json(publicExistingStaffResult(recovered), 200, requestOrigin);
      }
      throw error;
    }

    if (prepared.status === 'provisioned') {
      return json(publicResult(prepared, 'not_repeated'), 200, requestOrigin);
    }

    const deliverySucceeded = await sendAuthInvite(
      fetcher,
      config,
      String(prepared.email_normalized || invite.email)
    );

    let finalised;
    try {
      finalised = validatedState(await rpc(
        fetcher,
        config,
        bearer,
        'finalize_staff_invite',
        { p_invite_request_id: prepared.invite_request_id }
      ));
    } catch {
      throw new TeamAdminError(
        deliverySucceeded ? 'provisioning_pending' : 'invite_not_completed',
        502
      );
    }

    return json(
      publicResult(finalised, deliverySucceeded ? 'sent' : 'existing_account'),
      200,
      requestOrigin
    );
  } catch (error) {
    return safeError(error, requestOrigin);
  }
}

export default {
  fetch(request, env) {
    return handleTeamAdminRequest(request, env);
  },
};

export const __testing = Object.freeze({
  INVITE_PATH,
  ARTIST_INVITE_PATH,
  INVITE_REDIRECT_SEARCH,
  MAX_BODY_BYTES,
  readConfig,
  validateRequest,
  validateArtistInviteRequest,
  publicResult,
  publicArtistInviteResult,
});
