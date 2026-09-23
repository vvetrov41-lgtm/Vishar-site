-- 1004_mfa_assurance_enforcement.sql
--
-- Audit H-3: an account with a verified second factor gets nothing from a
-- password-only (aal1) session; aal2 sessions, delegated OAuth tokens, the
-- trusted backend and accounts without a factor are unaffected.

begin;
select no_plan();

insert into auth.users (id, email) values
  ('e2011111-1111-4111-8111-111111111111', 'mfa-owner@example.test'),
  ('e2021111-1111-4111-8111-111111111111', 'mfa-manager@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e2011111-1111-4111-8111-111111111111', 'mfa-owner@example.test', 'MFA Owner', 'owner', true),
  ('e2021111-1111-4111-8111-111111111111', 'mfa-manager@example.test', 'MFA Manager', 'booking_manager', true);

select ok(
  not has_function_privilege('authenticated', 'crm_private.caller_mfa_satisfied()', 'EXECUTE')
  and not has_function_privilege('anon', 'crm_private.caller_mfa_satisfied()', 'EXECUTE'),
  'the assurance helper is not directly callable by API roles'
);

create function pg_temp.as_user(p_uid uuid, p_aal text, p_client text default null)
returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'client_id', p_client))::text, true);
$$;

-- No factor: aal1 behaves exactly as before.
select pg_temp.as_user('e2011111-1111-4111-8111-111111111111', 'aal1');
select ok(public.is_active_user() and public.is_owner(), 'an owner without a factor keeps aal1 access');

-- Verified factor for the owner only.
reset role;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('e2031111-1111-4111-8111-111111111111', 'e2011111-1111-4111-8111-111111111111',
        'Phone', 'totp', 'verified', now(), now());

select pg_temp.as_user('e2011111-1111-4111-8111-111111111111', 'aal1');
select ok(not public.is_active_user(), 'an enrolled owner with an aal1 session is not an active user');
select ok(not public.is_owner(), 'an enrolled owner with an aal1 session is not treated as owner');
select ok(not public.can_manage_crm(), 'an enrolled aal1 session cannot manage the CRM');
select is(public.current_crm_role(), null, 'an enrolled aal1 session has no CRM role');
select throws_ok(
  $$select crm_private.require_role('owner'::public.crm_role)$$,
  '42501', 'second factor required',
  'role-gated RPCs refuse an enrolled aal1 session with a specific error'
);
select ok(
  not crm_private.has_artist_capability('a1111111-1111-4111-8111-111111111111', 'view_clients'),
  'artist capabilities are withheld from an enrolled aal1 session'
);
set local role authenticated;
select is((select count(*)::int from public.profiles where id = 'e2011111-1111-4111-8111-111111111111'), 0,
  'RLS hides even the account''s own profile from an enrolled aal1 session');
reset role;

select pg_temp.as_user('e2011111-1111-4111-8111-111111111111', 'aal2');
select ok(public.is_active_user() and public.is_owner(), 'the same owner at aal2 has full access');
select is(crm_private.require_role('owner'::public.crm_role), 'owner'::public.crm_role, 'role-gated RPCs accept aal2');
set local role authenticated;
select is((select count(*)::int from public.profiles where id = 'e2011111-1111-4111-8111-111111111111'), 1,
  'the same RLS read returns the profile at aal2');
reset role;

select pg_temp.as_user('e2011111-1111-4111-8111-111111111111', 'aal1', 'gpt-client-id');
select ok(public.is_active_user(), 'a delegated OAuth token (GPT Actions) keeps working');

-- A factor that was never verified does not lock anybody out.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('e2041111-1111-4111-8111-111111111111', 'e2021111-1111-4111-8111-111111111111',
        'Abandoned', 'totp', 'unverified', now(), now());
select pg_temp.as_user('e2021111-1111-4111-8111-111111111111', 'aal1');
select ok(public.is_active_user(), 'an unverified, abandoned enrollment does not require a second factor');

-- The trusted backend has no subject and is unaffected.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(crm_private.caller_mfa_satisfied(), 'the trusted backend is never asked for a second factor');

select * from finish(true);
rollback;
