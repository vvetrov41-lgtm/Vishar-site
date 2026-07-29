-- 050_rls_roles.sql
--
-- Role behaviour end to end: owner, booking_manager, read_only, a deactivated
-- profile, the anonymous public, and the trusted Worker. Plus finance-column
-- isolation and the append-only activity log.
--
-- These tests use SET LOCAL ROLE so that table and column privileges are
-- exercised as well as row policies. Hiding a control in the CRM is never a
-- security boundary; the database refuses the operation.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures, seeded through the Worker identity
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'disabled@example.test'),
  ('55555555-5555-4555-8555-555555555555', 'nonstaff@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'Owner', 'owner', true),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test', 'Manager', 'booking_manager', true),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test', 'Reader', 'read_only', true),
  ('44444444-4444-4444-8444-444444444444', 'disabled@example.test', 'Former', 'booking_manager', false);
-- 55555555 deliberately has an auth user but NO profile row.

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;

create temporary table t_enq as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'RLS Client', 'email', 'rls@example.test'),
  jsonb_build_object('idea', 'A raven'),
  jsonb_build_array(jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 1024))
) as r;

select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f;
select public.finalize_enquiry_intake((select r ->> 'enquiry_id' from t_enq)::uuid);

-- These tests impersonate database roles with SET LOCAL ROLE, so the scratch
-- tables holding fixture ids need to be readable by those roles too.
grant select on t_enq to anon, authenticated, service_role;

-- A project with finance values, created as the owner.
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.transition_enquiry_status((select (r ->> 'enquiry_id')::uuid from t_enq), 'accepted');

create temporary table proj as
select (public.convert_enquiry_to_project((select (r ->> 'enquiry_id')::uuid from t_enq),
        'Finance project') ->> 'project_id')::uuid as id;

grant select on proj to anon, authenticated, service_role;

select public.update_project_estimate((select id from proj), 140.00, 980.00, 2, 7.0);
select public.update_project_deposit((select id from proj), 150.00, 'requested');
select public.schedule_session((select id from proj), now() + interval '30 days',
                               now() + interval '30 days 7 hours', 'proposed');

-- ---------------------------------------------------------------------------
-- Public browser: no direct table access at all
-- ---------------------------------------------------------------------------

set local role anon;
select pg_temp.claims('{"role":"anon"}');

select throws_ok($$select count(*) from public.clients$$, '42501', null,
  'anon cannot select clients');
select throws_ok($$select count(*) from public.enquiries$$, '42501', null,
  'anon cannot select enquiries');
select throws_ok($$select count(*) from public.enquiry_files$$, '42501', null,
  'anon cannot select enquiry files');
select throws_ok($$select count(*) from public.activity_log$$, '42501', null,
  'anon cannot select the activity log');
select throws_ok($$select count(*) from public.projects$$, '42501', null,
  'anon cannot select projects');
select throws_ok($$insert into public.clients (full_name) values ('anon')$$, '42501', null,
  'anon cannot insert a client');
select throws_ok($$select count(*) from storage.objects$$, '42501', null,
  'anon cannot enumerate storage objects');
select throws_ok($$select public.create_enquiry_intake(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)$$,
  '42501', null, 'anon cannot call the intake RPC directly');
reset role;

-- ---------------------------------------------------------------------------
-- An authenticated account with no CRM profile
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}');

select is((select count(*)::int from public.clients), 0,
          'an account with no profile row sees no clients');
select is((select count(*)::int from public.enquiries), 0,
          'an account with no profile row sees no enquiries');
select ok(not public.is_active_user(), 'an account with no profile row is not an active user');
reset role;

-- ---------------------------------------------------------------------------
-- A deactivated profile
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}');

select ok(not public.is_active_user(), 'a deactivated profile is not an active user');
select is((select count(*)::int from public.clients), 0, 'a deactivated profile sees no clients');
select is((select count(*)::int from public.enquiries), 0, 'a deactivated profile sees no enquiries');
select is((select count(*)::int from public.profiles), 0, 'a deactivated profile cannot even read itself');
select throws_ok(
  format($$select public.transition_enquiry_status(%L, 'reviewing')$$,
         (select (r ->> 'enquiry_id')::uuid from t_enq)),
  '42501', null,
  'a deactivated profile cannot run a workflow RPC even with a valid session'
);
reset role;

-- ---------------------------------------------------------------------------
-- read_only
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');

select is((select current_crm_role()::text), 'read_only', 'the read_only role is reported correctly');
select is((select count(*)::int from public.clients), 1, 'read_only can read clients');
select is((select count(*)::int from public.enquiries), 1, 'read_only can read enquiries');
select is((select count(*)::int from public.follow_ups), 0, 'read_only can query follow-ups');

select is((select count(*)::int from public.enquiry_files), 0,
          'read_only sees no file metadata');
select is((select count(*)::int from public.internal_notes), 0,
          'read_only sees no internal notes');
select is((select count(*)::int from public.email_messages), 0,
          'read_only sees no email messages');
select is((select count(*)::int from public.activity_log), 0,
          'read_only sees no activity log entries');
select is((select count(*)::int from public.integration_outbox), 0,
          'read_only sees no integration jobs');

select throws_ok($$select hourly_rate from public.projects$$, '42501', null,
  'read_only cannot select the hourly rate column');
select throws_ok($$select price from public.sessions$$, '42501', null,
  'read_only cannot select the session price column');
select is((select count(*)::int from public.projects_finance), 0,
          'read_only reads no rows from the finance view');

select throws_ok($$insert into public.clients (full_name, email) values ('X', 'x@example.test')$$,
  '42501', null, 'read_only holds no insert privilege on clients');
select throws_ok($$update public.enquiries set idea = 'edited'$$, '42501', null,
  'read_only holds no update privilege on enquiries');
select throws_ok($$delete from public.clients$$, '42501', null,
  'read_only holds no delete privilege on clients');
select throws_ok($$select * from public.list_profiles()$$, '42501', null,
  'read_only cannot list staff profiles');
select is((select count(*)::int from public.system_settings), 0,
          'read_only reads no system settings rows');
reset role;

-- ---------------------------------------------------------------------------
-- booking_manager
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is((select current_crm_role()::text), 'booking_manager', 'the manager role is reported correctly');
select is((select count(*)::int from public.enquiry_files), 1, 'a manager can read file metadata');
select ok((select count(*) from public.activity_log) > 0, 'a manager sees operational activity');

-- but not the user-management or settings trail
select is((select count(*)::int from public.activity_log where event_type like 'profile.%'), 0,
          'a manager sees no profile.* activity');
select is((select count(*)::int from public.activity_log where event_type like 'settings.%'), 0,
          'a manager sees no settings.* activity');

select throws_ok($$select hourly_rate from public.projects$$, '42501', null,
  'a manager cannot select the hourly rate column');
select throws_ok($$select estimate_total from public.projects$$, '42501', null,
  'a manager cannot select the estimate total column');
select throws_ok($$select deposit_amount from public.projects$$, '42501', null,
  'a manager cannot select the deposit amount column');
select throws_ok($$select price from public.sessions$$, '42501', null,
  'a manager cannot select the session price column');
select is((select count(*)::int from public.projects_finance), 0,
          'a manager reads no rows from the project finance view');
select is((select count(*)::int from public.sessions_finance), 0,
          'a manager reads no rows from the session finance view');

-- Operational project columns are still readable, so the CRM stays usable.
select is((select count(*)::int from public.projects), 1, 'a manager can read operational project data');
select is((select deposit_status::text from public.projects), 'requested',
          'a manager can see the deposit STATE without the amount');

select throws_ok($$update public.projects set title = 'renamed'$$, '42501', null,
  'a manager holds no direct update privilege on projects');
select throws_ok($$delete from public.enquiries$$, '42501', null,
  'a manager cannot hard-delete an enquiry');
select throws_ok($$select * from public.list_profiles()$$, '42501', null,
  'a manager cannot list staff profiles');
select throws_ok($$select public.set_profile_role('33333333-3333-4333-8333-333333333333', 'owner')$$,
  '42501', null, 'a manager cannot change a role');
select throws_ok($$select public.set_profile_active('33333333-3333-4333-8333-333333333333', false)$$,
  '42501', null, 'a manager cannot deactivate a profile');
select throws_ok($$select public.update_retention_policy(true, 365)$$, '42501', null,
  'a manager cannot change the retention policy');

select lives_ok($$select * from public.list_assignable_profiles()$$,
  'a manager can list assignable colleagues');
select is((select count(*)::int from public.list_assignable_profiles()), 2,
          'the assignable list contains only active owners and managers');
reset role;

-- ---------------------------------------------------------------------------
-- owner
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');

select is((select current_crm_role()::text), 'owner', 'the owner role is reported correctly');
select is((select count(*)::int from public.projects_finance), 1, 'the owner reads the finance view');
select is((select hourly_rate from public.projects_finance), 140.00,
          'the finance view returns the exact numeric rate');
select is((select estimate_total from public.projects_finance), 980.00,
          'the finance view returns the exact numeric total');
select is((select count(*)::int from public.sessions_finance), 1, 'the owner reads session finance');

-- Even the owner reads finance through the view, never off the base table.
select throws_ok($$select hourly_rate from public.projects$$, '42501', null,
  'finance columns are not granted on the base table to any CRM role, including the owner');

select is((select count(*)::int from public.list_profiles()), 4, 'the owner lists every staff profile');
select ok((select count(*) from public.integration_outbox) > 0, 'the owner sees integration jobs');
select is((select count(*)::int from public.system_settings), 1, 'the owner reads system settings');
select lives_ok($$select public.set_profile_role('33333333-3333-4333-8333-333333333333', 'booking_manager')$$,
  'the owner can change a role');
select lives_ok($$select public.set_profile_active('33333333-3333-4333-8333-333333333333', false)$$,
  'the owner can deactivate a profile');
select throws_ok($$select public.set_profile_active('11111111-1111-4111-8111-111111111111', false)$$,
  '22023', null,
  'the acting owner cannot deactivate themselves and lock everyone out');

select throws_ok($$delete from public.clients$$, '42501', null,
  'even the owner cannot hard-delete a client through the table');
reset role;

-- ---------------------------------------------------------------------------
-- The activity log is append-only for everyone
-- ---------------------------------------------------------------------------

select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');

-- Layer 1: RLS. No UPDATE or DELETE policy exists, so no row is ever reachable
-- for mutation and the attempt silently affects nothing.
create temporary table log_before as select count(*) as n from public.activity_log;
update public.activity_log set event_type = 'client.contacted';
delete from public.activity_log;
select is((select count(*)::int from public.activity_log), (select n::int from log_before),
          'an update and a delete against activity_log change nothing under RLS');

-- Layer 2: the trigger, which is what protects the audit trail from a role that
-- bypasses RLS entirely — hosted Supabase gives `postgres` and `service_role`
-- exactly that. FORCE is lifted here only to reach that code path.
-- activity_log's entity references are DEFERRABLE INITIALLY DEFERRED, and
-- ALTER TABLE refuses to run while their triggers are still pending.
set constraints all immediate;
alter table public.activity_log no force row level security;

select throws_ok($$update public.activity_log set event_type = 'client.contacted'$$,
  '42501', null, 'a role that bypasses RLS still cannot update activity_log');
select throws_ok($$delete from public.activity_log$$,
  '42501', null, 'a role that bypasses RLS still cannot delete from activity_log');
select throws_ok($$truncate public.activity_log$$,
  '42501', null, 'activity_log cannot be truncated');

alter table public.activity_log force row level security;

select hasnt_column('public', 'activity_log', 'deleted_at',
  'there is no soft-delete escape hatch on the activity log');
select is((select count(*)::int from pg_policy
           where polrelid = 'public.activity_log'::regclass and polcmd in ('w', 'd')), 0,
          'no UPDATE or DELETE policy exists on activity_log');

-- Metadata may not become a second copy of the client's personal data.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$insert into public.activity_log (event_type, metadata)
    values ('enquiry.created', '{"email":"leak@example.test"}'::jsonb)$$,
  '23514', null, 'an activity row carrying an email address is rejected');
select throws_ok(
  $$insert into public.activity_log (event_type, metadata)
    values ('enquiry.created', '{"idea":"a raven with a skull"}'::jsonb)$$,
  '23514', null, 'an activity row carrying the client idea text is rejected');
select throws_ok(
  $$insert into public.activity_log (event_type, metadata)
    values ('enquiry.created', '{"signed_url":"https://example.test/x"}'::jsonb)$$,
  '23514', null, 'an activity row carrying a signed URL is rejected');

-- ---------------------------------------------------------------------------
-- The trusted Worker has no arbitrary table access
-- ---------------------------------------------------------------------------

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

select throws_ok($$select count(*) from public.clients$$, '42501', null,
  'service_role holds no direct select privilege on clients');
select throws_ok($$update public.enquiries set idea = 'x'$$, '42501', null,
  'service_role holds no direct update privilege on enquiries');
select throws_ok($$delete from public.activity_log$$, '42501', null,
  'service_role cannot delete audit history');
select lives_ok($$select public.create_enquiry_intake(
    'bbbbbbbb-0000-4000-8000-000000000001',
    jsonb_build_object('full_name', 'Worker Client', 'email', 'worker@example.test'),
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('mime_type','image/png','safe_extension','png','byte_size',512)))$$,
  'service_role can still perform the narrow intake it is granted');
reset role;

-- ---------------------------------------------------------------------------
-- Private schema is unreachable from the browser roles
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select throws_ok($$select count(*) from crm_private.profile_access$$, '42501', null,
  'the access mirror is unreachable from an authenticated session');
select throws_ok($$select crm_private.require_role('owner')$$, '42501', null,
  'the role-assertion helper is not executable from an authenticated session');
select throws_ok(
  $$select crm_private.enqueue_outbox('telegram_notification', 'telegram:forged:1')$$,
  '42501', null,
  'the outbox enqueue helper is not executable from an authenticated session');
reset role;

-- The mirror must stay in step with profiles, or access control would drift.
select is(
  (select count(*)::int from public.profiles p
   join crm_private.profile_access a on a.profile_id = p.id
   where a.role = p.role and a.is_active = p.is_active),
  (select count(*)::int from public.profiles),
  'the access mirror matches every profile row'
);

-- ---------------------------------------------------------------------------
-- RLS is enabled AND forced everywhere
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relkind = 'r'
     and relname in (
       'profiles', 'clients', 'enquiries', 'enquiry_files', 'projects',
       'project_files', 'sessions', 'activity_log', 'internal_notes',
       'email_messages', 'follow_ups', 'integration_outbox',
       'enquiry_status_transitions', 'system_settings', 'retention_holds')),
  'every CRM table has row level security enabled and forced'
);

select * from finish(true);
rollback;
