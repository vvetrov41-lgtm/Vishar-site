import assert from 'node:assert/strict';
import { handleTeamAdminRequest } from '../workers/team-admin.js';

const CRM_ORIGIN = 'https://crm-staging.vishartattoo.com';
const SUPABASE_ORIGIN = 'https://synthetic-project.supabase.co';
const OWNER_BEARER = 'Bearer synthetic.owner.access.token';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '77777777-7777-4777-8777-777777777777';
const IDEMPOTENCY_KEY = '88888888-8888-4888-8888-888888888888';
const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';

const env = {
  CRM_ALLOWED_ORIGIN: CRM_ORIGIN,
  CRM_INVITE_REDIRECT_URL: `${CRM_ORIGIN}/?staff_invite=1`,
  SUPABASE_URL: SUPABASE_ORIGIN,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only',
};

const payload = {
  idempotency_key: IDEMPOTENCY_KEY,
  email: '  TEAM.MEMBER@EXAMPLE.TEST ',
  display_name: 'Synthetic Manager',
  role: 'booking_manager',
  memberships: [{
    artist_id: ARTIST_ID,
    access_level: 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
  }],
};

function request(body = payload, overrides = {}) {
  return new Request(`${CRM_ORIGIN}/v1/staff/invite`, {
    method: overrides.method || 'POST',
    headers: {
      origin: overrides.origin || CRM_ORIGIN,
      authorization: overrides.authorization || OWNER_BEARER,
      'content-type': 'application/json',
    },
    body: (overrides.method || 'POST') === 'OPTIONS' ? undefined : JSON.stringify(body),
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

{
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/rest/v1/rpc/begin_staff_invite')) {
      return jsonResponse({
        invite_request_id: INVITE_ID,
        email_normalized: 'team.member@example.test',
        status: 'pending',
        profile_id: null,
        role: 'booking_manager',
        is_active: false,
        idempotent_replay: false,
      });
    }
    if (url.includes('/auth/v1/invite')) {
      return jsonResponse({ id: PROFILE_ID, access_token: 'must-never-reach-browser' });
    }
    return jsonResponse({
      invite_request_id: INVITE_ID,
      status: 'provisioned',
      profile_id: PROFILE_ID,
      role: 'booking_manager',
      is_active: true,
      idempotent_replay: false,
    });
  };

  const response = await handleTeamAdminRequest(request(), env, { fetcher });
  const text = await response.text();
  const result = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(result.profile_id, PROFILE_ID);
  assert.equal(result.delivery, 'sent');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.authorization, OWNER_BEARER);
  assert.equal(calls[2].init.headers.authorization, OWNER_BEARER);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${env.SUPABASE_SECRET_KEY}`);
  assert.equal(
    new URL(calls[1].url).searchParams.get('redirect_to'),
    `${CRM_ORIGIN}/?staff_invite=1`,
    'Auth invite is pinned to the exact same-origin password-setup marker'
  );
  assert.doesNotMatch(text, /token|secret|password|team\.member@example\.test/i);
}

{
  let calls = 0;
  const response = await handleTeamAdminRequest(request(), env, {
    fetcher: async () => {
      calls += 1;
      return jsonResponse({ error: 'permission denied' }, 403);
    },
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 1, 'owner denial stops before Auth Admin');
}

{
  let calls = 0;
  const response = await handleTeamAdminRequest(request(), env, {
    fetcher: async () => {
      calls += 1;
      return jsonResponse({
        invite_request_id: INVITE_ID,
        status: 'provisioned',
        profile_id: PROFILE_ID,
        role: 'booking_manager',
        is_active: true,
        idempotent_replay: true,
      });
    },
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.delivery, 'not_repeated');
  assert.equal(result.idempotent_replay, true);
  assert.equal(calls, 1, 'a provisioned replay sends no second Auth invitation');
}

{
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    if (url.endsWith('/rest/v1/rpc/begin_staff_invite')) {
      return jsonResponse({
        invite_request_id: INVITE_ID,
        email_normalized: 'existing@example.test',
        status: 'pending',
        profile_id: null,
        role: 'booking_manager',
        is_active: false,
        idempotent_replay: true,
      });
    }
    if (url.includes('/auth/v1/invite')) return jsonResponse({ error: 'already registered' }, 422);
    return jsonResponse({
      invite_request_id: INVITE_ID,
      status: 'provisioned',
      profile_id: PROFILE_ID,
      role: 'booking_manager',
      is_active: true,
      idempotent_replay: false,
    });
  };
  const response = await handleTeamAdminRequest(request(), env, { fetcher });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery, 'existing_account');
  assert.equal(calls, 3);
}

{
  let called = false;
  const response = await handleTeamAdminRequest(request(payload, {
    origin: 'https://attacker.example.test',
  }), env, { fetcher: async () => { called = true; } });
  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

{
  let called = false;
  const response = await handleTeamAdminRequest(request({ ...payload, role: 'owner' }), env, {
    fetcher: async () => { called = true; },
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
}

{
  let calls = 0;
  const response = await handleTeamAdminRequest(request(payload, {
    authorization: 'Bearer too-short',
  }), env, { fetcher: async () => { calls += 1; } });
  assert.equal(response.status, 401);
  assert.equal(calls, 0, 'missing or malformed bearer stops before every backend call');
}

{
  let calls = 0;
  const response = await handleTeamAdminRequest(request({
    ...payload,
    arbitrary_admin_operation: 'create_owner',
  }), env, { fetcher: async () => { calls += 1; } });
  assert.equal(response.status, 400);
  assert.equal(calls, 0, 'unknown fields cannot turn the endpoint into an admin proxy');
}

{
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/rest/v1/rpc/begin_staff_invite')) {
      return jsonResponse({
        invite_request_id: INVITE_ID,
        email_normalized: 'team.member@example.test',
        status: 'pending',
        profile_id: null,
        role: 'booking_manager',
        is_active: false,
        idempotent_replay: false,
      });
    }
    if (url.includes('/auth/v1/invite')) {
      return jsonResponse({ access_token: 'discarded-provider-value' });
    }
    return jsonResponse({ error: 'transaction refused' }, 409);
  };
  const response = await handleTeamAdminRequest(request(), env, { fetcher });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(text), { error: 'provisioning_pending' });
  assert.doesNotMatch(text, /token|secret|password|team\.member@example\.test/i);
  assert.equal(calls.length, 3, 'successful delivery still requires atomic database finalisation');
}

{
  let calls = 0;
  const response = await handleTeamAdminRequest(request(), {
    ...env,
    SUPABASE_SECRET_KEY: '',
  }, { fetcher: async () => { calls += 1; } });
  assert.equal(response.status, 503);
  assert.equal(calls, 0, 'missing server secret fails closed before any request');
}

for (const badRedirect of [
  `${CRM_ORIGIN}/`,
  `${CRM_ORIGIN}/?staff_invite=2`,
  `${CRM_ORIGIN}/?staff_invite=1&next=/users`,
  `${CRM_ORIGIN}/#/setup-password`,
  'https://other.vishartattoo.com/?staff_invite=1',
]) {
  let calls = 0;
  const response = await handleTeamAdminRequest(request(), {
    ...env,
    CRM_INVITE_REDIRECT_URL: badRedirect,
  }, { fetcher: async () => { calls += 1; } });
  assert.equal(response.status, 503, `invalid invite redirect fails closed: ${badRedirect}`);
  assert.equal(calls, 0);
}

// ---------------------------------------------------------------------------
// The tenant-scoped door: /v1/artist/invite
//
// Same Worker, same rule - it decides nothing. Every assertion below is about
// what it forwards and what it refuses to reveal.
// ---------------------------------------------------------------------------

const ARTIST_INVITE_URL = `${CRM_ORIGIN}/v1/artist/invite`;
const TENANT_BEARER = 'Bearer synthetic.artist.access.token';

const artistPayload = {
  idempotency_key: IDEMPOTENCY_KEY,
  email: '  New.Teammate@EXAMPLE.TEST ',
  display_name: 'Synthetic Teammate',
  artist_id: ARTIST_ID,
  grant: { access_level: 'manager', can_manage_sessions: true },
};

function artistRequest(body = artistPayload, overrides = {}) {
  return new Request(ARTIST_INVITE_URL, {
    method: overrides.method || 'POST',
    headers: {
      origin: overrides.origin || CRM_ORIGIN,
      authorization: overrides.authorization || TENANT_BEARER,
      'content-type': 'application/json',
    },
    body: ['OPTIONS', 'GET', 'HEAD'].includes(overrides.method || 'POST') ? undefined : JSON.stringify(body),
  });
}

{
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/rest/v1/rpc/begin_artist_invite')) {
      return jsonResponse({
        invite_request_id: INVITE_ID,
        email_normalized: 'new.teammate@example.test',
        status: 'pending',
        idempotent_replay: false,
      });
    }
    if (url.startsWith(`${SUPABASE_ORIGIN}/auth/v1/invite`)) return jsonResponse({});
    if (url.endsWith('/rest/v1/rpc/finalize_artist_invite')) {
      return jsonResponse({ invite_request_id: INVITE_ID, status: 'provisioned', idempotent_replay: false });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const response = await handleTeamAdminRequest(artistRequest(), env, { fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delivery: 'sent', idempotent_replay: false });

  const begin = calls.find((call) => call.url.endsWith('begin_artist_invite'));
  // The caller's own JWT reaches the database. The Worker's secret key is used
  // for the Auth call and nothing else, which is what keeps authorization in
  // one place.
  assert.equal(begin.init.headers.authorization, TENANT_BEARER);
  const beginBody = JSON.parse(begin.init.body);
  assert.equal(beginBody.p_artist_id, ARTIST_ID);
  assert.equal(beginBody.p_email, 'new.teammate@example.test');
  assert.deepEqual(beginBody.p_grant, {
    access_level: 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
  });
  // No role and no membership list are forwarded, because neither exists on
  // this path.
  assert.equal('p_role' in beginBody, false);
  assert.equal('p_memberships' in beginBody, false);
}

{
  // A suppressed invitation must be indistinguishable from a delivered one, and
  // must not cause any mail to be sent.
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url.endsWith('/rest/v1/rpc/begin_artist_invite')) {
      return jsonResponse({
        invite_request_id: null,
        email_normalized: 'already.here@example.test',
        status: 'suppressed',
        idempotent_replay: false,
      });
    }
    throw new Error(`unexpected call ${url}`);
  };

  const response = await handleTeamAdminRequest(artistRequest(), env, { fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delivery: 'sent', idempotent_replay: false });
  assert.equal(seen.some((url) => url.includes('/auth/v1/invite')), false, 'no mail for a suppressed invitation');
  assert.equal(seen.some((url) => url.includes('finalize_artist_invite')), false);
}

{
  // The database refusing is a refusal, not something the Worker recovers from.
  // The owner path has a deliberate existing-staff recovery; this one has none,
  // because recovering would disclose that the address exists.
  const seen = [];
  const response = await handleTeamAdminRequest(artistRequest(), env, {
    fetcher: async (url) => {
      seen.push(url);
      if (url.endsWith('/rest/v1/rpc/begin_artist_invite')) return jsonResponse({ message: 'refused' }, 400);
      throw new Error(`unexpected call ${url}`);
    },
  });
  assert.equal(response.status, 400);
  assert.equal(seen.some((url) => url.includes('list_profiles')), false, 'the tenant door never lists profiles');
  assert.equal(seen.some((url) => url.includes('/auth/v1/')), false);
}

for (const [label, body] of [
  ['a role the caller chose', { ...artistPayload, role: 'booking_manager' }],
  ['a membership array', { ...artistPayload, memberships: [] }],
  ['an owner-level grant', { ...artistPayload, grant: { access_level: 'owner' } }],
  ['managing finance without viewing it', { ...artistPayload, grant: { can_manage_finance: true } }],
  ['a read-only teammate holding a capability', {
    ...artistPayload,
    grant: { access_level: 'read_only', can_manage_sessions: true },
  }],
  ['an artist id that is not one', { ...artistPayload, artist_id: 'not-a-uuid' }],
  ['an unknown grant key', { ...artistPayload, grant: { escalate: true } }],
]) {
  let calls = 0;
  const response = await handleTeamAdminRequest(artistRequest(body), env, {
    fetcher: async () => { calls += 1; },
  });
  assert.equal(response.status, 400, `rejected before any call: ${label}`);
  assert.equal(calls, 0, `nothing reached the database: ${label}`);
}

{
  // The two doors stay separate: neither path answers for the other.
  let calls = 0;
  const wrongOrigin = await handleTeamAdminRequest(
    artistRequest(artistPayload, { origin: 'https://elsewhere.example' }),
    env,
    { fetcher: async () => { calls += 1; } },
  );
  assert.equal(wrongOrigin.status, 403);

  const noBearer = await handleTeamAdminRequest(
    new Request(ARTIST_INVITE_URL, {
      method: 'POST',
      headers: { origin: CRM_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(artistPayload),
    }),
    env,
    { fetcher: async () => { calls += 1; } },
  );
  assert.equal(noBearer.status, 401);

  const wrongMethod = await handleTeamAdminRequest(
    artistRequest(artistPayload, { method: 'GET' }),
    env,
    { fetcher: async () => { calls += 1; } },
  );
  assert.equal(wrongMethod.status, 405);

  const unknownPath = await handleTeamAdminRequest(
    new Request(`${CRM_ORIGIN}/v1/artist/invites`, {
      method: 'POST',
      headers: { origin: CRM_ORIGIN, authorization: TENANT_BEARER, 'content-type': 'application/json' },
      body: '{}',
    }),
    env,
    { fetcher: async () => { calls += 1; } },
  );
  assert.equal(unknownPath.status, 404);

  assert.equal(calls, 0, 'none of the boundary refusals reached the database');
}

console.log('Team admin Worker tests passed');
