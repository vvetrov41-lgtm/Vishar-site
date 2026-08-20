from pathlib import Path

ROOT = Path('.')


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


# 1. Narrow Supabase adapter: server verifies the CRM session, then the service
# credential may call only a backend authorization RPC that receives the
# verified profile id. Browser input never supplies that profile id.
supabase_client = r'''// Narrow Supabase client for the Instagram connector.
//
// The connector has one privileged RPC allow-list. Operator identity is not
// accepted from the browser body: the Worker verifies the supplied CRM session
// with Supabase Auth and only then passes the verified user id to the backend
// authorization RPC.
//
// The allow-list is the point. A Worker that could call any RPC with the
// service secret would be a general-purpose database credential wherever it
// runs, and a bug in request routing would become privilege escalation.

const BACKEND_RPCS = new Set([
  'service_authorize_instagram_connection',
  'service_resolve_instagram_route',
  'service_set_instagram_integration',
  'service_disable_instagram_integration',
  'service_update_communication_participant',
  'service_list_unenriched_participants',
  'record_communication_inbound_message',
  'record_communication_outbound_echo',
  'record_communication_read_receipt',
  'claim_communication_outbox',
  'record_communication_outbox_result',
  'resolve_outbox_route',
]);

// Retained as an explicit empty surface so tests can prove no browser-scoped RPC
// remains callable through the privileged Worker adapter.
const USER_RPCS = new Set();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_TOKEN = /^[A-Za-z0-9._~-]{16,8192}$/;

class InstagramSupabaseError extends Error {
  constructor(code, { status = null, pgcode = null } = {}) {
    super(code);
    this.name = 'InstagramSupabaseError';
    this.code = code;
    this.status = status;
    this.pgcode = pgcode;
  }
}

function projectOrigin(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InstagramSupabaseError('instagram_supabase_url_invalid');
  }
  if (
    url.protocol !== 'https:'
    || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new InstagramSupabaseError('instagram_supabase_url_invalid');
  }
  return url.origin;
}

function safeJsonResponse(response) {
  return response.json().catch(() => null);
}

async function callRpc(origin, name, args, headers, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args || {}),
      redirect: 'error',
    });
  } catch {
    throw new InstagramSupabaseError('instagram_rpc_unavailable');
  }

  const json = await safeJsonResponse(response);
  if (!response.ok) {
    const pgcode = typeof json?.code === 'string' ? json.code : null;
    throw new InstagramSupabaseError(
      pgcode === '42501' ? 'instagram_permission_denied' : 'instagram_rpc_failed',
      { status: response.status, pgcode },
    );
  }
  return json;
}

async function verifySession(origin, secret, bearer, fetchImpl) {
  if (typeof bearer !== 'string' || !SESSION_TOKEN.test(bearer)) {
    throw new InstagramSupabaseError('instagram_session_invalid', { status: 401 });
  }

  let response;
  try {
    response = await fetchImpl(`${origin}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: secret,
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
      },
      redirect: 'error',
    });
  } catch {
    throw new InstagramSupabaseError('instagram_session_verification_unavailable');
  }

  const json = await safeJsonResponse(response);
  if (response.status === 401 || response.status === 403) {
    throw new InstagramSupabaseError('instagram_session_invalid', { status: 401 });
  }
  if (!response.ok || !UUID.test(json?.id || '')) {
    throw new InstagramSupabaseError('instagram_session_verification_unavailable', {
      status: response.status,
    });
  }
  return { id: json.id };
}

export function createInstagramSupabase(env, fetchImpl = fetch) {
  const origin = projectOrigin(env);
  const secret = String(env?.SUPABASE_SECRET_KEY || '').trim();
  if (!secret.startsWith('sb_secret_')) {
    throw new InstagramSupabaseError('instagram_supabase_secret_unavailable');
  }

  return {
    async verifyUser(bearer) {
      return verifySession(origin, secret, bearer, fetchImpl);
    },
    async rpc(name, args) {
      if (!BACKEND_RPCS.has(name)) {
        throw new InstagramSupabaseError('instagram_backend_rpc_not_allowed');
      }
      return callRpc(origin, name, args, { apikey: secret }, fetchImpl);
    },
  };
}

export const __testing = Object.freeze({
  BACKEND_RPCS,
  USER_RPCS,
  projectOrigin,
  verifySession,
  InstagramSupabaseError,
});
'''
(ROOT / 'workers/lib/instagram-supabase.js').write_text(supabase_client)

# 2. Worker authorization chain: verify the CRM session, then authorize the
# verified profile against the selected artist with a backend-only RPC.
old_authorize = r'''/**
 * Proves the caller may manage this artist's integrations, using their own
 * Supabase session rather than anything they asserted in the request body.
 *
 * The selector comes back from the database, derived from the artist slug. The
 * browser names an artist; it never names a binding.
 */
async function authorizeConnection(db, token, artistId) {
  const row = firstRow(await db.userRpc('authorize_instagram_connection', {
    p_artist_id: artistId,
  }, token));
  if (
    !row
    || row.artist_id !== artistId
    || typeof row.integration_key !== 'string'
    || !INTEGRATION_KEY.test(row.integration_key)
  ) {
    throw new Error('instagram_connection_scope_invalid');
  }
  return row;
}
'''
new_authorize = r'''/**
 * Proves the caller may manage this artist's integrations without trusting a
 * profile id from the browser.
 *
 * First Supabase Auth verifies the CRM bearer and returns the authoritative
 * user/profile id. Only then does the backend-only RPC evaluate that profile's
 * active role and artist membership. The selector still comes back from the
 * database, derived from the artist slug.
 */
async function authorizeConnection(db, token, artistId) {
  const actor = await db.verifyUser(token);
  const row = firstRow(await db.rpc('service_authorize_instagram_connection', {
    p_profile_id: actor.id,
    p_artist_id: artistId,
  }));
  if (
    !row
    || row.artist_id !== artistId
    || typeof row.integration_key !== 'string'
    || !INTEGRATION_KEY.test(row.integration_key)
  ) {
    const error = new Error('instagram_connection_scope_invalid');
    error.code = 'instagram_authorization_unavailable';
    throw error;
  }
  return row;
}

function authorizationFailure(error) {
  if (error?.code === 'instagram_session_invalid') {
    return json(401, { error: 'session_required' });
  }
  if (error?.code === 'instagram_permission_denied' || error?.pgcode === '42501') {
    return json(403, { error: 'not_permitted' });
  }
  return json(503, { error: 'authorization_unavailable' });
}
'''
replace_once('workers/instagram-production.js', old_authorize, new_authorize)

worker_path = ROOT / 'workers/instagram-production.js'
worker_text = worker_path.read_text()
old_catch = "  } catch {\n    return json(403, { error: 'not_permitted' });\n  }\n"
new_catch = "  } catch (error) {\n    return authorizationFailure(error);\n  }\n"
if worker_text.count(old_catch) != 3:
    raise SystemExit(f'workers/instagram-production.js: expected 3 authorization catches, found {worker_text.count(old_catch)}')
worker_path.write_text(worker_text.replace(old_catch, new_catch))

# 3. Forward-only service authorization migration. The old authenticated RPC is
# deliberately retained during rollout so applying 0073 cannot break the
# currently deployed Worker before its replacement is approved.
migration = r'''-- 0073_instagram_operator_authorization.sql
--
-- Verify an already-authenticated CRM profile for Instagram onboarding from a
-- trusted backend Worker. The browser never supplies p_profile_id; the Worker
-- obtains it from Supabase Auth /auth/v1/user after validating the bearer.

create or replace function public.service_authorize_instagram_connection(
  p_profile_id uuid,
  p_artist_id uuid
)
returns table (
  artist_id uuid,
  artist_slug text,
  integration_key text,
  instagram_user_id text,
  is_enabled boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
  v_slug text;
  v_integration_key text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'service backend role required' using errcode = '42501';
  end if;

  if p_profile_id is null then
    raise exception 'profile scope is required' using errcode = '22023';
  end if;
  perform crm_private.require_active_artist(p_artist_id);

  select p.role
    into v_role
  from crm_private.profile_access p
  where p.profile_id = p_profile_id
    and p.is_active;

  if v_role is null or v_role not in ('owner', 'booking_manager') then
    raise exception 'profile is not permitted to manage integrations' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from crm_private.artist_access a
    where a.profile_id = p_profile_id
      and a.artist_id = p_artist_id
      and a.is_active
      and (
        v_role = 'owner'
        or (v_role = 'booking_manager' and a.can_manage_integrations)
      )
  ) then
    raise exception 'profile cannot manage integrations for this artist' using errcode = '42501';
  end if;

  select a.slug
    into v_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_slug is null then
    raise exception 'artist does not exist or is inactive' using errcode = '23503';
  end if;

  v_integration_key := v_slug || '-instagram';

  return query
  select
    p_artist_id,
    v_slug,
    v_integration_key,
    i.configuration ->> 'instagram_user_id',
    coalesce(i.is_enabled, false)
  from (values (1)) as seed(n)
  left join public.artist_integrations i
    on i.artist_id = p_artist_id
   and i.integration_type = 'instagram'
   and i.integration_key = v_integration_key;
end;
$$;

revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from public;
revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from anon;
revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from authenticated;
grant execute on function public.service_authorize_instagram_connection(uuid, uuid) to service_role;
'''
migration_path = ROOT / 'supabase/migrations/0073_instagram_operator_authorization.sql'
if migration_path.exists():
    raise SystemExit('0073 migration already exists')
migration_path.write_text(migration)

# 4. Worker tests model the actual two-step trust boundary and distinguish
# invalid sessions, denied artist access, and backend transport failures.
test_path = ROOT / 'scripts/test-instagram-connector.mjs'
test_text = test_path.read_text()
replace = lambda old, new: None

old_const = "const SESSION = 'synthetic.session.token-abcdefghijklmnop';\n"
new_const = old_const + "const TEST_PROFILE = 'c1111111-1111-4111-8111-111111111111';\n"
if test_text.count(old_const) != 1:
    raise SystemExit('test SESSION anchor mismatch')
test_text = test_text.replace(old_const, new_const, 1)

old_double = r'''function dbDouble({ authorize = null, throwOn = null, calls = [] } = {}) {
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (throwOn === name) throw new Error('synthetic_rpc_failure');
      return { ok: true };
    },
    async userRpc(name, args, bearer) {
      calls.push({ name, args, bearer });
      if (throwOn === name) throw new Error('synthetic_rpc_failure');
      if (name === 'authorize_instagram_connection') {
        if (authorize === 'deny') throw new Error('instagram_rpc_forbidden');
        return [authorize ?? {
          artist_id: args.p_artist_id,
          artist_slug: args.p_artist_id === K_ARTIST ? 'kristina' : 'vladimir',
          integration_key: args.p_artist_id === K_ARTIST ? 'kristina-instagram' : 'vladimir-instagram',
          instagram_user_id: null,
          is_enabled: false,
        }];
      }
      return null;
    },
  };
}
'''
new_double = r'''function dbDouble({ authorize = null, session = 'allow', throwOn = null, calls = [] } = {}) {
  return {
    calls,
    async verifyUser(bearer) {
      calls.push({ name: 'verifyUser', bearer });
      if (throwOn === 'verifyUser') {
        const error = new Error('instagram_session_verification_unavailable');
        error.code = 'instagram_session_verification_unavailable';
        throw error;
      }
      if (session === 'deny') {
        const error = new Error('instagram_session_invalid');
        error.code = 'instagram_session_invalid';
        error.status = 401;
        throw error;
      }
      return { id: TEST_PROFILE };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (throwOn === name) {
        const error = new Error('synthetic_rpc_failure');
        error.code = 'instagram_rpc_unavailable';
        throw error;
      }
      if (name === 'service_authorize_instagram_connection') {
        if (authorize === 'deny') {
          const error = new Error('instagram_permission_denied');
          error.code = 'instagram_permission_denied';
          error.pgcode = '42501';
          error.status = 403;
          throw error;
        }
        return [authorize ?? {
          artist_id: args.p_artist_id,
          artist_slug: args.p_artist_id === K_ARTIST ? 'kristina' : 'vladimir',
          integration_key: args.p_artist_id === K_ARTIST ? 'kristina-instagram' : 'vladimir-instagram',
          instagram_user_id: null,
          is_enabled: false,
        }];
      }
      return { ok: true };
    },
  };
}
'''
if test_text.count(old_double) != 1:
    raise SystemExit('test dbDouble anchor mismatch')
test_text = test_text.replace(old_double, new_double, 1)

old_test = r'''await test('starting a connection asks the database which artist the operator may connect', async () => {
  const { response, db, environment } = await startConnection({ artist_id: V_ARTIST });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authorize_url.startsWith('https://www.instagram.com/oauth/authorize'));

  const authorised = db.calls.find((call) => call.name === 'authorize_instagram_connection');
  assert.equal(authorised.bearer, SESSION);
  assert.equal(authorised.args.p_artist_id, V_ARTIST);

  // The state is bound to the artist the database returned, not to anything
  // the browser said beyond naming the artist.
  const [stateValue] = [...environment.INSTAGRAM_OAUTH_STATE.store.values()];
  const state = JSON.parse(stateValue);
  assert.equal(state.artist_id, V_ARTIST);
  assert.equal(state.integration_key, 'vladimir-instagram');
});
'''
new_test = r'''await test('starting a connection verifies the CRM session before authorizing its artist', async () => {
  const { response, db, environment } = await startConnection({ artist_id: V_ARTIST });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authorize_url.startsWith('https://www.instagram.com/oauth/authorize'));

  const verified = db.calls.find((call) => call.name === 'verifyUser');
  assert.equal(verified.bearer, SESSION);
  const authorised = db.calls.find((call) => call.name === 'service_authorize_instagram_connection');
  assert.equal(authorised.args.p_profile_id, TEST_PROFILE);
  assert.equal(authorised.args.p_artist_id, V_ARTIST);
  assert.ok(db.calls.indexOf(verified) < db.calls.indexOf(authorised));

  // The state is bound to the artist the database returned, not to anything
  // the browser said beyond naming the artist.
  const [stateValue] = [...environment.INSTAGRAM_OAUTH_STATE.store.values()];
  const state = JSON.parse(stateValue);
  assert.equal(state.artist_id, V_ARTIST);
  assert.equal(state.integration_key, 'vladimir-instagram');
});
'''
if test_text.count(old_test) != 1:
    raise SystemExit('primary authorization test anchor mismatch')
test_text = test_text.replace(old_test, new_test, 1)

old_deny = r'''await test('an operator without integration rights is refused', async () => {
  const { response } = await startConnection(
    { artist_id: K_ARTIST },
    { db: dbDouble({ authorize: 'deny' }) },
  );
  assert.equal(response.status, 403);
});
'''
new_deny = old_deny + r'''
await test('an expired or invalid CRM session is a 401, not an artist permission error', async () => {
  const { response } = await startConnection(
    { artist_id: V_ARTIST },
    { db: dbDouble({ session: 'deny' }) },
  );
  assert.equal(response.status, 401);
});

await test('an authorization backend failure is unavailable, not a false 403', async () => {
  const { response } = await startConnection(
    { artist_id: V_ARTIST },
    { db: dbDouble({ throwOn: 'service_authorize_instagram_connection' }) },
  );
  assert.equal(response.status, 503);
});
'''
if test_text.count(old_deny) != 1:
    raise SystemExit('authorization deny test anchor mismatch')
test_text = test_text.replace(old_deny, new_deny, 1)

old_smuggle = r'''  const { response, environment } = await startConnection({
    artist_id: V_ARTIST,
    integration_key: 'kristina-instagram',
    instagram_user_id: K_ACCOUNT,
  });
'''
new_smuggle = r'''  const { response, environment, db } = await startConnection({
    artist_id: V_ARTIST,
    profile_id: 'c2222222-2222-4222-8222-222222222222',
    integration_key: 'kristina-instagram',
    instagram_user_id: K_ACCOUNT,
  });
'''
if test_text.count(old_smuggle) != 1:
    raise SystemExit('smuggle test anchor mismatch')
test_text = test_text.replace(old_smuggle, new_smuggle, 1)
old_smuggle_assert = "  assert.equal(JSON.parse(stateValue).integration_key, 'vladimir-instagram');\n});\n"
new_smuggle_assert = "  assert.equal(JSON.parse(stateValue).integration_key, 'vladimir-instagram');\n  const authorised = db.calls.find((call) => call.name === 'service_authorize_instagram_connection');\n  assert.equal(authorised.args.p_profile_id, TEST_PROFILE);\n});\n"
# Replace only the occurrence inside the browser-smuggling test by searching from its title.
marker = "await test('a browser cannot smuggle its own integration selector'"
idx = test_text.index(marker)
end_idx = test_text.index(old_smuggle_assert, idx)
test_text = test_text[:end_idx] + new_smuggle_assert + test_text[end_idx + len(old_smuggle_assert):]

old_order = "  assert.ok(order.indexOf('authorize_instagram_connection') < order.indexOf('service_disable_instagram_integration'));\n"
new_order = "  assert.ok(order.indexOf('service_authorize_instagram_connection') < order.indexOf('service_disable_instagram_integration'));\n"
if test_text.count(old_order) != 1:
    raise SystemExit('disconnect order anchor mismatch')
test_text = test_text.replace(old_order, new_order, 1)

old_surface = r'''    'resolve_outbox_route',
    'service_disable_instagram_integration',
'''
new_surface = r'''    'resolve_outbox_route',
    'service_authorize_instagram_connection',
    'service_disable_instagram_integration',
'''
if test_text.count(old_surface) != 1:
    raise SystemExit('backend surface anchor mismatch')
test_text = test_text.replace(old_surface, new_surface, 1)
old_user_surface = "  assert.deepEqual([...supabaseTesting.USER_RPCS], ['authorize_instagram_connection']);\n"
new_user_surface = "  assert.deepEqual([...supabaseTesting.USER_RPCS], []);\n"
if test_text.count(old_user_surface) != 1:
    raise SystemExit('user surface anchor mismatch')
test_text = test_text.replace(old_user_surface, new_user_surface, 1)

test_path.write_text(test_text)

# 5. pgTAP coverage for service-only authorization and fixed search_path.
pg_path = ROOT / 'supabase/tests/220_instagram_channel.sql'
pg = pg_path.read_text()
old_has = r'''select has_function('public', 'service_set_instagram_integration',
                    array['uuid', 'text', 'text', 'text', 'text[]'],
                    'the backend Instagram connection binder exists');
'''
new_has = old_has + r'''select has_function('public', 'service_authorize_instagram_connection',
                    array['uuid', 'uuid'],
                    'the backend Instagram operator authorizer exists');
'''
if pg.count(old_has) != 1:
    raise SystemExit('pgTAP has_function anchor mismatch')
pg = pg.replace(old_has, new_has, 1)

acl_anchor = r'''select ok(
  has_function_privilege('service_role', 'public.service_resolve_instagram_route(text)', 'EXECUTE'),
  'only the trusted connector resolves an Instagram route'
);
'''
acl_new = acl_anchor + r'''select ok(
  not has_function_privilege('anon', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'anon cannot authorize an Instagram operator'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'a browser session cannot call the backend Instagram operator authorizer'
);
select ok(
  has_function_privilege('service_role', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'only the trusted connector can call the backend Instagram operator authorizer'
);
'''
if pg.count(acl_anchor) != 1:
    raise SystemExit('pgTAP ACL anchor mismatch')
pg = pg.replace(acl_anchor, acl_new, 1)

path_anchor = "       'service_set_instagram_integration',\n"
if pg.count(path_anchor) != 1:
    raise SystemExit('pgTAP search_path list anchor mismatch')
pg = pg.replace(path_anchor, "       'service_authorize_instagram_connection',\n" + path_anchor, 1)

service_role_anchor = "select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);\n"
service_role_tests = service_role_anchor + r'''

select is(
  (select integration_key
   from public.service_authorize_instagram_connection(
     (select profile_id from crm_private.profile_access where role = 'owner' and is_active limit 1),
     'a1111111-1111-4111-8111-111111111111'
   )),
  'vladimir-instagram',
  'the trusted connector can authorize an active owner membership without a browser-supplied profile id'
);

select throws_ok(
  $$select * from public.service_authorize_instagram_connection(
      'c9999999-9999-4999-8999-999999999999',
      'a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'an unknown profile fails closed even when the backend calls the RPC'
);
'''
if pg.count(service_role_anchor) != 1:
    raise SystemExit('pgTAP service role anchor mismatch')
pg = pg.replace(service_role_anchor, service_role_tests, 1)
pg_path.write_text(pg)

# Refuse accidental scope creep.
allowed = {
    'workers/lib/instagram-supabase.js',
    'workers/instagram-production.js',
    'scripts/test-instagram-connector.mjs',
    'supabase/migrations/0073_instagram_operator_authorization.sql',
    'supabase/tests/220_instagram_channel.sql',
}
print('Patch prepared for:')
for path in sorted(allowed):
    print(path)
