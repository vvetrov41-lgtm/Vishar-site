-- 070_bootstrap_retention.sql
--
-- Owner bootstrap idempotency, and retention shipping disabled with no
-- invented duration.

begin;
select no_plan();

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap never invents an identity
-- ---------------------------------------------------------------------------

select is((select count(*)::int from public.profiles), 0, 'the CRM starts with no profiles');
select ok(crm_private.no_active_owner(), 'no active owner exists before bootstrap');
select ok(not has_function_privilege('anon', 'public.bootstrap_owner(uuid,text)', 'EXECUTE'),
          'anonymous callers cannot execute owner bootstrap');
select ok(not has_function_privilege('authenticated', 'public.bootstrap_owner(uuid,text)', 'EXECUTE'),
          'authenticated callers cannot execute owner bootstrap as an RPC');
select ok(not has_function_privilege('service_role', 'public.bootstrap_owner(uuid,text)', 'EXECUTE'),
          'the Worker backend cannot execute owner bootstrap');
select ok(not has_function_privilege('service_role', 'public.bootstrap_owner_by_email(text,text)', 'EXECUTE'),
          'the email bootstrap wrapper is also absent from the Worker surface');

select throws_ok(
  $$select public.bootstrap_owner('00000000-0000-4000-8000-0000000000ff')$$,
  '23503', null,
  'promoting a uuid with no auth user fails instead of creating one'
);
select throws_ok(
  $$select public.bootstrap_owner_by_email('nobody@example.test')$$,
  '23503', null,
  'promoting an unknown email fails instead of creating an account'
);
select throws_ok(
  $$select public.bootstrap_owner(null)$$,
  '22023', null,
  'bootstrap requires an explicit identity'
);
select throws_ok(
  $$select public.bootstrap_owner_by_email('   ')$$,
  '22023', null,
  'bootstrap refuses a blank email'
);
select is((select count(*)::int from public.profiles), 0,
          'a failed bootstrap created no profile');

-- ---------------------------------------------------------------------------
-- First promotion
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'Owner@Example.TEST');

create temporary table first_run as
select public.bootstrap_owner('11111111-1111-4111-8111-111111111111', 'Vladimir') as r;

select ok((select (r ->> 'changed')::boolean from first_run), 'the first promotion changes something');
select is((select r ->> 'role' from first_run), 'owner', 'the promoted role is owner');

select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.profiles where role = 'owner' and is_active), 1,
          'exactly one active owner now exists');
select ok(not crm_private.no_active_owner(),
          'the first-owner path closes itself once an owner exists');
select is((select count(*)::int from public.activity_log where event_type = 'owner.bootstrapped'), 1,
          'the promotion is recorded in the audit trail');

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

-- Model a manual SQL Editor repeat: it has no end-user JWT. The exact
-- already-satisfied promotion must be a harmless no-op.
select pg_temp.claims('{}');
create temporary table second_run as
select public.bootstrap_owner('11111111-1111-4111-8111-111111111111', 'Vladimir') as r;

select ok(not (select (r ->> 'changed')::boolean from second_run),
          'a repeat promotion changes nothing');
select is((select f.r ->> 'profile_id' from first_run f), (select r ->> 'profile_id' from second_run),
          'a repeat promotion returns the same profile id');
select is((select count(*)::int from public.profiles), 1, 'a repeat promotion creates no second profile');
select is((select count(*)::int from public.activity_log where event_type = 'owner.bootstrapped'), 1,
          'a repeat promotion writes no second audit event');

-- The email wrapper resolves to the same account, case-insensitively.
create temporary table third_run as
select public.bootstrap_owner_by_email('owner@example.test') as r;

select is((select r ->> 'profile_id' from third_run), '11111111-1111-4111-8111-111111111111',
          'the email wrapper resolves to the same account regardless of case');
select ok(not (select (r ->> 'changed')::boolean from third_run),
          'the email wrapper is idempotent too');

-- The wrapper's "more than one match" branch is defensive: `auth.users.email`
-- carries a unique index, so two matching rows cannot be created here to
-- exercise it. It is kept because the uniqueness of that index is Supabase's
-- guarantee, not this schema's.

-- A second owner can only be promoted by an existing owner or the Worker.
insert into auth.users (id, email) values ('33333333-3333-4333-8333-333333333333', 'second@example.test');
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select ok((select (public.bootstrap_owner('33333333-3333-4333-8333-333333333333') ->> 'changed')::boolean),
          'an acting owner can promote a second owner');

-- Demote the first owner; the second one remains.
select public.set_profile_role('11111111-1111-4111-8111-111111111111', 'read_only');

-- A demoted account cannot promote itself back. The refusal is explicit rather
-- than a silent no-op that reports success.
select throws_ok(
  $$select public.bootstrap_owner('11111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'a demoted account cannot bootstrap itself back to owner'
);
select is((select role::text from crm_private.profile_access
           where profile_id = '11111111-1111-4111-8111-111111111111'),
          'read_only', 'the demoted account is still read_only');

-- The remaining owner can restore it.
select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select ok((select (public.bootstrap_owner('11111111-1111-4111-8111-111111111111') ->> 'changed')::boolean),
          'the remaining owner can restore a demoted owner');
select is((select role::text from crm_private.profile_access
           where profile_id = '11111111-1111-4111-8111-111111111111'),
          'owner', 'the restored profile is an owner again');

-- No owner identity is baked into the schema.
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.prosrc ~* '(vishartattoo\.com|vvetrov)'),
  0,
  'no function body contains a real owner email address or domain'
);

-- ---------------------------------------------------------------------------
-- Retention ships disabled, with no invented duration
-- ---------------------------------------------------------------------------

select pg_temp.claims('{"role":"service_role"}');

select is((select count(*)::int from public.system_settings), 1,
          'system_settings is a single row');
select is((select retention_enabled from public.system_settings), false,
          'retention is DISABLED by default');
select is((select retention_dry_run_only from public.system_settings), true,
          'retention starts in dry-run-only mode');
select is((select enquiry_retention_days from public.system_settings), null,
          'no enquiry retention duration is invented');
select is((select client_retention_days from public.system_settings), null,
          'no client retention duration is invented');
select is((select file_retention_days from public.system_settings), null,
          'no file retention duration is invented');
select is((select activity_retention_days from public.system_settings), null,
          'no activity retention duration is invented');
select is((select retention_decided_by from public.system_settings), null,
          'no retention decision has been recorded');
select is((select default_currency from public.system_settings), 'GBP',
          'the default currency is GBP and is stored explicitly');

set local role service_role;
select throws_ok(
  $$select count(*) from public.system_settings$$,
  '42501', null,
  'service_role cannot bypass the Worker RPC allow-list through system settings'
);
select throws_ok(
  $$insert into public.retention_holds (reason_code) values ('forged_hold')$$,
  '42501', null,
  'service_role has no direct retention-hold write privilege'
);
reset role;

-- The schema refuses to be switched on without a policy.
select throws_ok(
  $$update public.system_settings set retention_enabled = true where id$$,
  '23514', null,
  'retention cannot be enabled without a duration and a recorded decision'
);

select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');

select throws_ok(
  $$select public.update_retention_policy(true)$$,
  '22023', null,
  'the RPC refuses to enable retention without at least one duration'
);

select lives_ok(
  $$select public.update_retention_policy(true, 730, 730, 730, 730, true)$$,
  'the owner can record an explicit retention policy'
);
select is((select retention_enabled from public.system_settings), true,
          'the recorded policy is applied');
select ok((select retention_decided_by is not null and retention_decided_at is not null
           from public.system_settings),
          'enabling retention records who decided it and when');
select is((select count(*)::int from public.activity_log where event_type = 'settings.retention_updated'), 1,
          'the retention decision is audited');

-- Holds exist so a future deletion job can be told to skip an entity.
select has_table('public', 'retention_holds', 'a legal/operational hold table exists');
select has_column('public', 'retention_holds', 'released_at', 'a hold can be released');
select has_column('public', 'retention_holds', 'reason_code', 'a hold records why it was placed');

-- Nothing is scheduled to delete anything.
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.proname ~ '(purge|prune|apply_retention|delete_old)'),
  0,
  'no retention deletion job exists yet, so nothing can run against client data'
);

select * from finish(true);
rollback;
