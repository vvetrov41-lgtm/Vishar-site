-- 232_unified_gpt_authorization.sql
--
-- Migration 0084: one Vishar GPT may serve any authenticated CRM profile, and
-- the OAuth client it presents is an application identity, never an Artist
-- grant. The Artist a request operates on is derived from auth.uid() -> CRM
-- profile -> current artist memberships, re-derived on every call.
--
-- The two production Artist-bound GPT clients keep their existing semantics,
-- their existing RPC signatures and their existing consent contract. A
-- profile-bound client has no artist_id at all, so it cannot fall back to
-- somebody else's Artist when a membership disappears.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Closed boundary: the selector table and the resolvers are not an API surface
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege('authenticated', 'public.gpt_artist_context(uuid)', 'EXECUTE'),
  'the GPT context contract is callable by an authenticated OAuth session'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_artist_context(uuid)', 'EXECUTE'),
  'anonymous callers cannot read or select a GPT Artist context'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_artist_context(uuid)', 'EXECUTE'),
  'the trusted backend is not a GPT context caller'
);

select ok(
  (select bool_and(
     not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE'))
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'crm_private'
     and p.proname in (
       'require_gpt_registered_client',
       'require_gpt_client_context',
       'require_gpt_action_context',
       'require_gpt_enquiry_context',
       'require_gpt_operational_context')),
  'no API role can call a GPT authorization resolver directly'
);

select ok(
  (select bool_and(
     not has_table_privilege(r, 'crm_private.gpt_profile_artist_contexts', 'SELECT')
     and not has_table_privilege(r, 'crm_private.gpt_profile_artist_contexts', 'INSERT')
     and not has_table_privilege(r, 'crm_private.gpt_profile_artist_contexts', 'UPDATE')
     and not has_table_privilege(r, 'crm_private.gpt_profile_artist_contexts', 'DELETE'))
   from unnest(array['anon', 'authenticated', 'service_role']) r),
  'the persisted Artist selector is unreachable from every API role'
);

select is(
  (select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%'
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gpt_artist_context'),
  true,
  'the context contract is SECURITY DEFINER with a pinned search_path'
);

-- The binding shape is a constraint, not a convention: a profile-bound client
-- physically cannot carry an Artist id to fall back to.
select throws_ok(
  $$insert into crm_private.gpt_action_clients
      (id, artist_id, binding_mode, integration_key, display_name, is_active)
    values ('c9111111-1111-4111-8111-111111111111',
            'a1111111-1111-4111-8111-111111111111', 'profile',
            'unified-with-artist', 'Broken unified', false)$$,
  '23514',
  null,
  'a profile-bound GPT client may not carry a fixed Artist id'
);
select throws_ok(
  $$insert into crm_private.gpt_action_clients
      (id, artist_id, binding_mode, integration_key, display_name, is_active)
    values ('c9222222-2222-4222-8222-222222222222',
            null, 'artist', 'legacy-without-artist', 'Broken legacy', false)$$,
  '23514',
  null,
  'a legacy Artist-bound GPT client still requires its Artist id'
);
select throws_ok(
  $$insert into crm_private.gpt_action_clients
      (id, artist_id, binding_mode, integration_key, display_name, is_active)
    values ('c9333333-3333-4333-8333-333333333333',
            null, 'workspace', 'unknown-binding', 'Unknown binding', false)$$,
  '23514',
  null,
  'only the two reviewed binding modes exist'
);

-- The unified client ships dormant. Migration 0084 cannot enable a GPT.
select is(
  (select is_active from crm_private.gpt_action_clients
   where integration_key = 'vishar-unified-gpt'),
  false,
  'the canonical unified GPT client is inactive as shipped'
);
select is(
  (select oauth_client_id from crm_private.gpt_action_clients
   where integration_key = 'vishar-unified-gpt'),
  null,
  'the canonical unified GPT client is bound to no OAuth client id'
);
select is(
  (select binding_mode from crm_private.gpt_action_clients
   where integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions')
   group by binding_mode),
  'artist',
  'both production GPT clients keep the legacy Artist binding'
);

-- ---------------------------------------------------------------------------
-- Fixtures
--
-- Every profile is a booking_manager, so Artist reach comes from explicit
-- membership rows rather than from the owner role's automatic sync.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e5011111-1111-4111-8111-111111111111', 'unified-both@example.test'),
  ('e5022222-2222-4222-8222-222222222222', 'unified-kristina@example.test'),
  ('e5033333-3333-4333-8333-333333333333', 'unified-readonly@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('e5011111-1111-4111-8111-111111111111', 'unified-both@example.test',
   'Unified Both Artists', 'booking_manager', true),
  ('e5022222-2222-4222-8222-222222222222', 'unified-kristina@example.test',
   'Unified Kristina Only', 'booking_manager', true),
  ('e5033333-3333-4333-8333-333333333333', 'unified-readonly@example.test',
   'Unified Read Only', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e5011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'manager',
   false, false, true, false, true),
  ('e5011111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222', 'manager',
   false, false, true, false, true),
  ('e5022222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'manager',
   false, false, true, false, true),
  ('e5033333-3333-4333-8333-333333333333',
   'a2222222-2222-4222-8222-222222222222', 'read_only',
   false, false, false, false, true);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-unified-legacy-vladimir',
    can_read_appointments = true,
    can_manage_appointments = true,
    can_read_enquiries = true,
    can_manage_crm = true,
    can_manage_finance = true,
    can_manage_communications = true,
    is_active = true
where integration_key = 'vladimir-gpt-actions';

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-unified-shared',
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;

-- The resolvers are deliberately unreachable from an API role, so the tests
-- reach them the way a GPT RPC does: through a definer boundary owned by the
-- database, with the caller's own JWT still in force.
create function pg_temp.action_artist(p_write boolean) returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select c.artist_id from crm_private.require_gpt_action_context(p_write) c;
$$;
create function pg_temp.enquiry_artist() returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select c.artist_id from crm_private.require_gpt_enquiry_context() c;
$$;
create function pg_temp.operational_artist(p_capability text) returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select c.artist_id from crm_private.require_gpt_operational_context(p_capability) c;
$$;

-- The selector table is closed to every API role, so the assertions about what
-- it stores also have to cross a definer boundary.
create function pg_temp.selector_rows(p_profile_id uuid) returns integer
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select count(*)::int from crm_private.gpt_profile_artist_contexts
  where profile_id = p_profile_id;
$$;
create function pg_temp.selector_artist(p_profile_id uuid) returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select artist_id from crm_private.gpt_profile_artist_contexts
  where profile_id = p_profile_id;
$$;

grant execute on function pg_temp.claims(text) to authenticated;
grant execute on function pg_temp.action_artist(boolean) to authenticated;
grant execute on function pg_temp.enquiry_artist() to authenticated;
grant execute on function pg_temp.operational_artist(text) to authenticated;
grant execute on function pg_temp.selector_rows(uuid) to authenticated;
grant execute on function pg_temp.selector_artist(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. The legacy Artist-bound client is untouched
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-legacy-vladimir"}'
);

select is(
  pg_temp.action_artist(false),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'a legacy client still resolves to the Artist its OAuth binding names'
);
select is(
  pg_temp.action_artist(true),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'a legacy client still authorizes writes against its fixed Artist'
);
select is(
  (select count(*)::int from public.gpt_list_appointments(now(), now() + interval '1 day', 5)),
  0,
  'the existing appointment read RPC still resolves through the central context'
);

select is(
  public.gpt_artist_context(null) ->> 'binding_mode',
  'artist',
  'a legacy client reports the Artist binding mode'
);
select is(
  public.gpt_artist_context(null) ->> 'active_artist_id',
  'a1111111-1111-4111-8111-111111111111',
  'a legacy client has its fixed Artist active with no selection step'
);
select is(
  (public.gpt_artist_context(null) ->> 'requires_selection')::boolean,
  false,
  'a legacy client never asks the model to choose an Artist'
);
select is(
  jsonb_array_length(public.gpt_artist_context(null) -> 'artists'),
  1,
  'a legacy client exposes exactly its own Artist'
);

-- A legacy client is fixed even for a human who can reach the other Artist.
select throws_ok(
  $$select public.gpt_artist_context('a2222222-2222-4222-8222-222222222222')$$,
  '42501',
  null,
  'a legacy GPT cannot be redirected to another Artist the human happens to hold'
);

-- ...and a human without that Artist cannot use the legacy client at all.
select pg_temp.claims(
  '{"sub":"e5022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-legacy-vladimir"}'
);
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '42501',
  null,
  'a legacy client grants nothing to a profile without that Artist membership'
);

-- ---------------------------------------------------------------------------
-- 2. Registration is required before any profile logic runs
-- ---------------------------------------------------------------------------

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '42501',
  null,
  'a normal CRM token without an OAuth client_id cannot use the GPT surface'
);
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-not-registered"}'
);
select throws_ok(
  $$select public.gpt_artist_context(null)$$,
  '42501',
  null,
  'an unregistered OAuth client cannot read the context contract'
);
select pg_temp.claims(
  '{"role":"authenticated","client_id":"oauth-unified-shared"}'
);
select throws_ok(
  $$select public.gpt_artist_context(null)$$,
  '42501',
  null,
  'the unified client requires an authenticated CRM profile, not just the app'
);

-- ---------------------------------------------------------------------------
-- 3. The unified client sees exactly the caller's memberships
-- ---------------------------------------------------------------------------

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);

select is(
  public.gpt_artist_context(null) ->> 'binding_mode',
  'profile',
  'the unified client reports the profile binding mode'
);
select is(
  (select array_agg(a ->> 'display_name' order by a ->> 'display_name')
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a),
  array['Kristina', 'Vladimir'],
  'a profile holding both memberships sees both Artists'
);
select is(
  (public.gpt_artist_context(null) ->> 'requires_selection')::boolean,
  true,
  'a multi-Artist profile must choose before the GPT may act'
);

-- Fail closed, not "pick the first Artist".
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '22023',
  null,
  'a multi-Artist profile with no selection cannot read through the unified GPT'
);
select throws_ok(
  $$select pg_temp.action_artist(true)$$,
  '22023',
  null,
  'a multi-Artist profile with no selection cannot write through the unified GPT'
);

select pg_temp.claims(
  '{"sub":"e5022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  (select array_agg(a ->> 'display_name')
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a),
  array['Kristina'],
  'a profile holding one membership never sees the other Artist'
);
select is(
  public.gpt_artist_context(null) ->> 'active_artist_id',
  'a2222222-2222-4222-8222-222222222222',
  'a single-Artist profile needs no selection step'
);
select is(
  pg_temp.action_artist(false),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a single-Artist profile resolves its only Artist without a persisted row'
);
select is(
  pg_temp.selector_rows('e5022222-2222-4222-8222-222222222222'),
  0,
  'the single-Artist shortcut persists no selector and therefore no stale grant'
);

-- ---------------------------------------------------------------------------
-- 4. Selecting an Artist is a selector, and only a real membership passes
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111')$$,
  '42501',
  null,
  'the unified GPT cannot select an Artist the signed-in profile does not hold'
);
select is(
  pg_temp.selector_rows('e5022222-2222-4222-8222-222222222222'),
  0,
  'a refused selection writes nothing'
);

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  public.gpt_artist_context('a2222222-2222-4222-8222-222222222222') ->> 'active_artist_id',
  'a2222222-2222-4222-8222-222222222222',
  'a held Artist may be selected'
);
select is(
  pg_temp.action_artist(false),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'subsequent GPT actions run against the selected Artist'
);
select is(
  public.gpt_artist_context('a1111111-1111-4111-8111-111111111111') ->> 'active_artist_id',
  'a1111111-1111-4111-8111-111111111111',
  'the active Artist may be switched to the other held Artist'
);
select is(
  pg_temp.action_artist(false),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the switch takes effect for later actions'
);
select is(
  pg_temp.selector_rows('e5011111-1111-4111-8111-111111111111'),
  1,
  'switching updates the single selector row rather than accumulating grants'
);

-- One human's selection is not another human's context.
select pg_temp.claims(
  '{"sub":"e5033333-3333-4333-8333-333333333333","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  pg_temp.action_artist(false),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a different human on the same GPT client resolves their own Artist'
);

-- ---------------------------------------------------------------------------
-- 5. Membership authorizes selection; capability still authorizes the action
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select pg_temp.action_artist(true)$$,
  '42501',
  null,
  'a read-only membership cannot write appointments even after selection'
);
select throws_ok(
  $$select pg_temp.operational_artist('crm')$$,
  '42501',
  null,
  'a read-only membership cannot manage CRM records through the unified GPT'
);
select throws_ok(
  $$select pg_temp.operational_artist('finance')$$,
  '42501',
  null,
  'a read-only membership cannot manage finance through the unified GPT'
);
select throws_ok(
  $$select pg_temp.operational_artist('communications')$$,
  '42501',
  null,
  'a read-only membership cannot manage communications through the unified GPT'
);
select is(
  pg_temp.enquiry_artist(),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a read-only membership still reads enquiries for its own Artist'
);

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  pg_temp.operational_artist('crm'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'a manager membership may manage CRM records for the selected Artist'
);
select throws_ok(
  $$select pg_temp.operational_artist('finance')$$,
  '42501',
  null,
  'a manager without finance rights is refused finance regardless of selection'
);
select throws_ok(
  $$select pg_temp.operational_artist('bookkeeping')$$,
  '22023',
  null,
  'an unknown operational capability is refused rather than defaulted'
);

-- The client flags remain a ceiling above the membership, never a floor.
reset role;
update crm_private.gpt_action_clients
set can_manage_appointments = false
where integration_key = 'vishar-unified-gpt';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select throws_ok(
  $$select pg_temp.action_artist(true)$$,
  '42501',
  null,
  'a GPT client flag can only narrow what a membership already allows'
);
reset role;
update crm_private.gpt_action_clients
set can_manage_appointments = true
where integration_key = 'vishar-unified-gpt';
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 6. A selector is revalidated, so revocation takes effect immediately
-- ---------------------------------------------------------------------------

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  pg_temp.action_artist(false),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the selected Artist resolves while the membership stands'
);

reset role;
update public.artist_memberships
set is_active = false
where profile_id = 'e5011111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);

select is(
  pg_temp.selector_artist('e5011111-1111-4111-8111-111111111111'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the stale selector row still exists after the membership is revoked'
);
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '42501',
  null,
  'a revoked membership invalidates the persisted selector instead of granting it'
);
select is(
  (public.gpt_artist_context(null) ->> 'requires_selection')::boolean,
  true,
  'the context contract reports that a new selection is required'
);
select is(
  public.gpt_artist_context(null) ->> 'active_artist_id',
  null,
  'a revoked selection never silently falls back to the remaining Artist'
);
select is(
  (select array_agg(a ->> 'display_name')
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a),
  array['Kristina'],
  'only the still-held Artist remains offered'
);

reset role;
update public.artist_memberships
set is_active = true
where profile_id = 'e5011111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  pg_temp.action_artist(false),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'restoring the membership restores the previously selected context'
);

-- A deactivated Artist invalidates the context for the same reason.
reset role;
update public.artists set is_active = false
where id = 'a1111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '42501',
  null,
  'a deactivated Artist invalidates the selected GPT context'
);
reset role;
update public.artists set is_active = true
where id = 'a1111111-1111-4111-8111-111111111111';

-- A deactivated profile loses the surface entirely.
update public.profiles set is_active = false
where id = 'e5011111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select throws_ok(
  $$select pg_temp.action_artist(false)$$,
  '42501',
  null,
  'a deactivated CRM profile cannot act through the unified GPT'
);
select throws_ok(
  $$select public.gpt_artist_context(null)$$,
  '42501',
  null,
  'a deactivated CRM profile cannot even read the context contract'
);
reset role;
update public.profiles set is_active = true
where id = 'e5011111-1111-4111-8111-111111111111';
set local role authenticated;

-- A disabled GPT client stops working without touching any membership.
reset role;
update crm_private.gpt_action_clients set is_active = false
where integration_key = 'vishar-unified-gpt';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select throws_ok(
  $$select public.gpt_artist_context(null)$$,
  '42501',
  null,
  'disabling the unified GPT client closes the surface immediately'
);
reset role;
update crm_private.gpt_action_clients set is_active = true
where integration_key = 'vishar-unified-gpt';
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 7. The OAuth consent contract keeps its legacy shape and gains an honest
--    membership-based description for the unified client
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(u.name order by u.ord)
   from pg_proc p,
        lateral unnest(p.proargnames, p.proargmodes)
          with ordinality as u(name, mode, ord)
   where p.oid = 'public.get_gpt_action_consent_summary(text)'::regprocedure
     and u.mode = 't'),
  array['integration_key', 'client_display_name', 'artist_id',
        'artist_display_name', 'can_read_appointments', 'can_manage_appointments'],
  'the consent summary keeps its existing column contract'
);

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select is(
  (select artist_display_name
   from public.get_gpt_action_consent_summary('oauth-unified-legacy-vladimir')),
  'Vladimir',
  'legacy consent still names the one Artist the client is fixed to'
);
select is(
  (select artist_id
   from public.get_gpt_action_consent_summary('oauth-unified-legacy-vladimir')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'legacy consent still returns that Artist id'
);

select is(
  (select artist_display_name
   from public.get_gpt_action_consent_summary('oauth-unified-shared')),
  'Artists available to your CRM profile',
  'unified consent describes the membership boundary rather than a fixed Artist'
);
select is(
  (select can_manage_appointments
   from public.get_gpt_action_consent_summary('oauth-unified-shared')),
  true,
  'unified consent reports the appointment rights the memberships actually carry'
);

select pg_temp.claims(
  '{"sub":"e5033333-3333-4333-8333-333333333333","role":"authenticated"}'
);
select is(
  (select can_manage_appointments
   from public.get_gpt_action_consent_summary('oauth-unified-shared')),
  false,
  'a read-only human consents to a read-only unified GPT'
);
select throws_ok(
  $$select * from public.get_gpt_action_consent_summary('oauth-unified-legacy-vladimir')$$,
  '42501',
  null,
  'legacy consent is still refused to a human without that Artist'
);

-- A human with no Artist at all cannot consent to the unified GPT either.
reset role;
update public.artist_memberships set is_active = false
where profile_id = 'e5033333-3333-4333-8333-333333333333';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5033333-3333-4333-8333-333333333333","role":"authenticated"}'
);
select throws_ok(
  $$select * from public.get_gpt_action_consent_summary('oauth-unified-shared')$$,
  '42501',
  null,
  'a profile with no Artist membership cannot consent to the unified GPT'
);
reset role;
update public.artist_memberships set is_active = true
where profile_id = 'e5033333-3333-4333-8333-333333333333';
set local role authenticated;

-- The consent screen reads a detail contract so it can render the real binding
-- mode instead of guessing one from a display string.
select ok(
  has_function_privilege('authenticated', 'public.get_gpt_consent_details(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_gpt_consent_details(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.get_gpt_consent_details(text)', 'EXECUTE'),
  'only an authenticated CRM session may read GPT consent detail'
);

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select is(
  public.get_gpt_consent_details('oauth-unified-legacy-vladimir') ->> 'binding_mode',
  'artist',
  'consent detail reports the legacy Artist binding'
);
select is(
  public.get_gpt_consent_details('oauth-unified-legacy-vladimir') ->> 'artist_display_name',
  'Vladimir',
  'legacy consent detail names the one Artist the client is fixed to'
);
select is(
  (public.get_gpt_consent_details('oauth-unified-legacy-vladimir') ->> 'artist_count')::int,
  1,
  'a legacy client covers exactly one Artist'
);

select is(
  public.get_gpt_consent_details('oauth-unified-shared') ->> 'binding_mode',
  'profile',
  'consent detail reports the profile binding for the unified GPT'
);
select is(
  public.get_gpt_consent_details('oauth-unified-shared') ->> 'artist_display_name',
  null,
  'unified consent detail names no Artist, because the GPT is fixed to none'
);
select is(
  (public.get_gpt_consent_details('oauth-unified-shared') ->> 'artist_count')::int,
  2,
  'unified consent detail counts the Artists this human actually holds'
);

select pg_temp.claims(
  '{"sub":"e5022222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  (public.get_gpt_consent_details('oauth-unified-shared') ->> 'artist_count')::int,
  1,
  'a single-Artist human sees a single-Artist consent boundary'
);

select is(
  (select array_agg(k order by k)
   from jsonb_object_keys(public.get_gpt_consent_details('oauth-unified-shared')) k),
  array['artist_count', 'artist_display_name', 'artist_id', 'binding_mode',
        'can_manage_appointments', 'can_read_appointments',
        'client_display_name', 'integration_key'],
  'consent detail exposes exactly the reviewed keys and no OAuth client id'
);

-- ---------------------------------------------------------------------------
-- 8. No new leak: the context contract carries identity, never provider state
-- ---------------------------------------------------------------------------

select pg_temp.claims(
  '{"sub":"e5011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-shared"}'
);
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys(public.gpt_artist_context(null)) k),
  array['active_artist_id', 'artists', 'binding_mode', 'integration_key',
        'requires_selection'],
  'the context contract returns exactly the five reviewed keys'
);
select is(
  (select array_agg(distinct k order by k)
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a,
        lateral jsonb_object_keys(a) k),
  array['default_currency', 'display_name', 'id', 'slug', 'timezone'],
  'an offered Artist carries identity only, never integration or finance state'
);
select is(
  public.gpt_artist_context(null) ->> 'integration_key',
  'vishar-unified-gpt',
  'the context names the GPT integration key, which is not a credential'
);

select * from finish(true);
rollback;
