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
-- Fixtures created by the privileged test/migration owner
-- ---------------------------------------------------------------------------

-- The claims let the stricter plain-PostgreSQL harness satisfy FORCE RLS.
-- These direct inserts are fixture setup and do not represent Worker table
-- access; the service_role section below exercises its controlled RPC surface.
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

-- Artist access is explicit. The owner trigger grants both artist scopes; these
-- fixtures model one shared operational manager and one read-only colleague for
-- Vladimir without introducing any production fallback assignment.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('22222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, true),
  ('33333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true),
  ('44444444-4444-4444-8444-444444444444', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text)
  to anon, authenticated, service_role;

create temporary table t_enq as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'RLS Client', 'email', 'rls@example.test'),
  jsonb_build_object(
    'idea', 'A raven',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
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
select is((select count(*)::int from storage.objects), 0,
  'anon reads zero Storage objects through the managed-table RLS boundary');
select throws_ok($$select public.create_enquiry_intake(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)$$,
  '42501', null, 'anon cannot call the intake RPC directly');
select ok(
  not has_function_privilege('authenticated',
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'authenticated has no intake RPC privilege even though Supabase normally grants new functions'
);
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
select is((select count(*)::int from public.profiles), 1,
          'a manager sees only their own base profile row');
select throws_ok(
  $$insert into public.activity_log (event_type, actor_kind, metadata)
    values ('enquiry.reviewed', 'owner', '{}'::jsonb)$$,
  '42501', null,
  'a manager cannot forge an audit row through direct table access'
);

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
select ok(not has_table_privilege('authenticated', 'public.projects_finance', 'UPDATE'),
          'authenticated has SELECT-only access to the finance view');

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
select throws_ok($$select public.update_retention_policy(true, 365)$$,
  '42501', null, 'a manager cannot change the retention policy');

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
select throws_ok(
  $$update public.projects_finance set deposit_amount = 1$$,
  '42501', null,
  'the owner cannot bypass the audited finance RPC by updating the view'
);

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

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');

-- Layer 1: the authenticated ACL/RLS boundary. No application role has a
-- mutation grant or an UPDATE/DELETE policy.
create temporary table log_before as select count(*) as n from public.activity_log;
select throws_ok($$update public.activity_log set event_type = 'client.contacted'$$,
  '42501', null, 'an authenticated owner cannot update activity_log directly');
select throws_ok($$delete from public.activity_log$$,
  '42501', null, 'an authenticated owner cannot delete activity_log directly');
select is((select count(*)::int from public.activity_log), (select n::int from log_before),
          'authenticated mutation attempts leave activity_log unchanged');

-- Layer 2: the trigger, which is what protects the audit trail from a role that
-- bypasses RLS entirely — hosted Supabase gives `postgres` and `service_role`
-- exactly that. FORCE is lifted here only to reach that code path.
-- activity_log's entity references are DEFERRABLE INITIALLY DEFERRED, and
-- ALTER TABLE refuses to run while their triggers are still pending.
reset role;
set constraints all immediate;
alter table public.activity_log no force row level security;

select throws_ok($$update public.activity_log set event_type = 'client.contacted'$$,
  '42501', null, 'a role that bypasses RLS still cannot update activity_log');
select throws_ok($$delete from public.activity_log$$,
  '42501', null, 'a role that bypasses RLS still cannot delete activity_log');
select throws_ok($$truncate public.activity_log$$,
  '42501', null, 'activity_log cannot be truncated');

alter table public.activity_log force row level security;

select hasnt_column('public', 'activity_log', 'deleted_at',
  'there is no soft-delete escape hatch on the activity log');
select is((select count(*)::int from pg_policy
           where polrelid = 'public.activity_log'::regclass and polcmd in ('w', 'd')), 0,
          'no UPDATE or DELETE policy exists on activity_log');

-- Metadata may not become a second copy of the client's personal data.
-- These are privileged constraint probes, not service_role table inserts.
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
select throws_ok(
  $$insert into public.activity_log (event_type, metadata)
    values ('enquiry.created', '{"context":{"email":"nested@example.test"}}'::jsonb)$$,
  '23514', null, 'nested personal data is also rejected from activity metadata');

-- ---------------------------------------------------------------------------
-- The trusted Worker has no arbitrary table access
-- ---------------------------------------------------------------------------

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

select throws_ok($$select count(*) from public.clients$$, '42501', null,
  'service_role holds no direct select privilege on clients');
select throws_ok($$update public.enquiries set idea = 'x'$$, '42501', null,
  'service_role holds no direct update privilege on enquiries');
select throws_ok($$select count(*) from public.integration_outbox$$, '42501', null,
  'service_role reaches the outbox only through narrow RPCs, not the table endpoint');
select throws_ok($$delete from public.activity_log$$, '42501', null,
  'service_role cannot delete audit history');
select lives_ok($$select public.create_enquiry_intake(
    'bbbbbbbb-0000-4000-8000-000000000001',
    jsonb_build_object('full_name', 'Worker Client', 'email', 'worker@example.test'),
    jsonb_build_object(
      'privacy_acknowledged', true,
      'privacy_notice_version', '2026-07-29'
    ),
    jsonb_build_array(jsonb_build_object('mime_type','image/png','safe_extension','png','byte_size',512)))$$,
  'service_role can still perform the narrow intake it is granted');
select ok(
  has_function_privilege('service_role',
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'service_role has the intake RPC privilege explicitly'
);
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

-- Supabase grants new public objects to API roles unless migrations change the
-- defaults. A probe created after all migrations must stay closed.
create table public.default_acl_probe (id integer);
create function public.default_acl_probe() returns integer language sql as $$select 1$$;
create function crm_private.default_acl_probe() returns integer language sql as $$select 1$$;

select is(current_user, 'postgres'::name,
          'canonical migrations and pgTAP use the postgres owner context');
select is(
  (select r.rolname
   from pg_proc p
   join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.convert_enquiry_to_project(uuid,text,text)'::regprocedure),
  'postgres'::name,
  'CRM migration functions are owned by postgres'
);

select is(
  (select count(*)::int
   from pg_default_acl d
   join pg_roles r on r.oid = d.defaclrole
   where r.rolname = 'postgres'
     and d.defaclnamespace = 0::oid
     and d.defaclobjtype = 'f'),
  1,
  'postgres has a global function default-ACL row'
);
select is(
  (select count(*)::int
   from pg_default_acl d
   join pg_roles r on r.oid = d.defaclrole
   cross join lateral aclexplode(d.defaclacl) a
   left join pg_namespace n on n.oid = d.defaclnamespace
   where r.rolname = 'postgres'
     and d.defaclobjtype = 'f'
     and (d.defaclnamespace = 0::oid or n.nspname in ('public', 'crm_private'))
     and a.privilege_type = 'EXECUTE'
     and (
       a.grantee = 0
       or a.grantee in (
         select oid from pg_roles
         where rolname in ('anon', 'authenticated', 'service_role')
       )
     )),
  0,
  'global/public/crm_private defaults grant no function EXECUTE to PUBLIC or API roles'
);

select ok(not has_table_privilege('anon', 'public.default_acl_probe', 'SELECT'),
          'new public tables are closed to anon by default');
select ok(not has_table_privilege('authenticated', 'public.default_acl_probe', 'SELECT'),
          'new public tables are closed to authenticated by default');
select ok(not has_table_privilege('service_role', 'public.default_acl_probe', 'SELECT'),
          'new public tables are closed to service_role by default');
select ok(not has_function_privilege('anon', 'public.default_acl_probe()', 'EXECUTE'),
          'new public functions are closed to anon by default');
select ok(not has_function_privilege('authenticated', 'public.default_acl_probe()', 'EXECUTE'),
          'new public functions are closed to authenticated by default');
select ok(not has_function_privilege('service_role', 'public.default_acl_probe()', 'EXECUTE'),
          'new public functions are closed to service_role by default');
select ok(not has_function_privilege('anon', 'crm_private.default_acl_probe()', 'EXECUTE'),
          'new crm_private functions are closed to anon by default');
select ok(not has_function_privilege('authenticated', 'crm_private.default_acl_probe()', 'EXECUTE'),
          'new crm_private functions are closed to authenticated by default');
select ok(not has_function_privilege('service_role', 'crm_private.default_acl_probe()', 'EXECUTE'),
          'new crm_private functions are closed to service_role by default');

-- Every callable CRM function belongs to an explicit allow-list. This checks
-- effective privileges, so an accidental PUBLIC grant would expose unexpected
-- functions and fail the inventory even if direct role ACLs looked correct.
create temporary table expected_function_acl (
  signature             text primary key,
  anon_allowed          boolean not null,
  authenticated_allowed boolean not null,
  service_role_allowed  boolean not null
);

insert into expected_function_acl values
  -- Identity/policy helpers used by authenticated CRM requests and the backend.
  ('public.is_active_user()', false, true, true),
  ('public.current_crm_role()', false, true, true),
  ('public.is_owner()', false, true, true),
  ('public.can_manage_crm()', false, true, true),
  ('public.can_access_client(uuid)', false, true, true),
  ('public.can_manage_client(uuid)', false, true, true),
  ('public.crm_storage_object_is_known(text)', false, true, true),
  ('public.crm_storage_object_readable(text)', false, true, true),
  ('public.crm_storage_object_writable(text)', false, true, true),
  ('public.can_access_artist(uuid)', false, true, true),
  ('public.can_manage_artist(uuid)', false, true, true),
  ('public.can_view_artist_finance(uuid)', false, true, true),
  ('public.can_manage_artist_finance(uuid)', false, true, true),
  ('public.can_manage_artist_sessions(uuid)', false, true, true),
  ('public.can_manage_artist_integrations(uuid)', false, true, true),

  -- Worker-only durable intake, reconciliation and payment RPCs.
  ('public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)', false, false, true),
  ('public.create_trusted_enquiry_intake(text,text,text,uuid,jsonb,jsonb,jsonb)', false, false, true),
  ('public.mark_enquiry_file_uploaded(uuid,text)', false, false, true),
  ('public.finalize_enquiry_intake(uuid)', false, false, true),
  ('public.fail_enquiry_intake(uuid,text)', false, false, true),
  ('public.record_outbox_attempt(uuid,boolean,text)', false, false, true),
  ('public.claim_telegram_outbox(text,integer,integer)', false, false, true),
  ('public.claim_telegram_outbox_by_id(uuid,text,integer)', false, false, true),
  ('public.record_telegram_outbox_result(uuid,text,boolean,text)', false, false, true),
  ('public.resolve_outbox_route(uuid)', false, false, true),
  ('public.list_incomplete_intakes(integer,integer)', false, false, true),
  ('public.resolve_booking_source(text,text,text)', false, false, true),
  ('public.register_payment_webhook_event(text,text,text,text)', false, false, true),
  ('public.record_provider_payment(uuid,uuid,uuid,text,numeric,boolean,timestamptz)', false, false, true),
  ('public.record_calendar_sync_result(uuid,integer,boolean,public.calendar_provider,text,text)', false, false, true),
  ('public.claim_calendar_outbox(text,integer,integer)', false, false, true),
  ('public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)', false, false, true),
  ('public.claim_calendar_availability_outbox(text,integer,integer)', false, false, true),
  ('public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)', false, false, true),
  ('public.set_calendar_connection_metadata(uuid,text,text,boolean)', false, false, true),
  ('public.authorize_calendar_actor(text,uuid)', false, false, true),
  ('public.resolve_monzo_deposit_redirect(uuid)', false, false, true),
  ('public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)', false, false, true),
  ('public.list_calendar_connection_status()', false, true, false),

  -- Authenticated CRM RPCs. Their bodies enforce owner/manager sub-roles.
  ('public.record_activity(text,uuid,uuid,uuid,uuid,jsonb)', false, true, false),
  ('public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)', false, true, false),
  ('public.transition_enquiry_status(uuid,public.enquiry_status)', false, true, false),
  ('public.assign_enquiry(uuid,uuid)', false, true, false),
  ('public.convert_enquiry_to_project(uuid,text,text)', false, true, false),
  ('public.schedule_session(uuid,timestamptz,timestamptz,public.session_status,text)', false, true, false),
  ('public.set_session_status(uuid,public.session_status)', false, true, false),
  ('public.list_appointment_conflicts(uuid,timestamptz,timestamptz,uuid)', false, true, false),
  ('public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)', false, true, false),
  ('public.set_appointment_status(uuid,public.session_status)', false, true, false),
  ('public.reschedule_appointment(uuid,timestamptz,timestamptz)', false, true, false),
  ('public.list_artist_availability_blocks(uuid,timestamptz,timestamptz,boolean)', false, true, false),
  ('public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)', false, true, false),
  ('public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)', false, true, false),
  ('public.cancel_artist_availability_block(uuid)', false, true, false),
  ('public.update_project_deposit(uuid,numeric,public.deposit_status,text)', false, true, false),
  ('public.update_project_estimate(uuid,numeric,numeric,integer,numeric,text)', false, true, false),
  ('public.create_internal_note(text,uuid,uuid,uuid,uuid)', false, true, false),
  ('public.create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text)', false, true, false),
  ('public.complete_follow_up(uuid)', false, true, false),
  ('public.create_email_draft(text,text,text,uuid,uuid,uuid,text)', false, true, false),
  ('public.approve_email_draft(uuid)', false, true, false),
  ('public.set_profile_active(uuid,boolean)', false, true, false),
  ('public.set_profile_role(uuid,public.crm_role)', false, true, false),
  ('public.list_profiles()', false, true, false),
  ('public.list_team_memberships()', false, true, false),
  ('public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb)', false, true, false),
  ('public.finalize_staff_invite(uuid)', false, true, false),
  ('public.list_assignable_profiles()', false, true, false),
  ('public.update_retention_policy(boolean,integer,integer,integer,integer,boolean)', false, true, false),
  ('public.list_accessible_artists()', false, true, false),
  ('public.upsert_artist_membership(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean,boolean)', false, true, false),
  ('public.configure_artist_integration(uuid,public.artist_integration_type,text,text,text,jsonb,boolean)', false, true, false),
  ('public.create_artist_payment_policy(uuid,integer,public.payment_policy_mode,numeric,numeric,integer,boolean,text,timestamptz)', false, true, false),
  ('public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz)', false, true, false),
  ('public.record_manual_payment(uuid,uuid,numeric,timestamptz,text)', false, true, false),
  ('public.record_manual_refund(uuid,uuid,numeric,boolean,timestamptz,text)', false, true, false),
  ('public.cancel_payment_request(uuid)', false, true, false),
  ('public.transfer_work_to_artist(uuid,uuid,uuid,text)', false, true, false),
  ('public.configure_monzo_easy_bank_transfer(uuid,text,boolean)', false, true, false),
  ('public.get_monzo_easy_bank_transfer_settings(uuid)', false, true, false),
  ('public.request_session_deposit(uuid,uuid,text)', false, true, false),
  ('public.queue_whatsapp_message(uuid,text,uuid)', false, true, false),

  -- Private helpers required by RLS; crm_private is not a PostgREST schema.
  ('crm_private.jwt_role()', false, true, true),
  ('crm_private.is_service_backend()', false, true, true),
  ('crm_private.no_active_owner()', false, true, true);

select is(
  (select count(*)::int
   from expected_function_acl e
   where has_function_privilege('anon', e.signature, 'EXECUTE') = e.anon_allowed
     and has_function_privilege('authenticated', e.signature, 'EXECUTE') = e.authenticated_allowed
     and has_function_privilege('service_role', e.signature, 'EXECUTE') = e.service_role_allowed),
  (select count(*)::int from expected_function_acl),
  'every intentionally callable function has exactly its documented API-role grants'
);

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('service_role', p.oid, 'EXECUTE')
     )
     and not exists (
       select 1
       from expected_function_acl e
       where to_regprocedure(e.signature) = p.oid
     )),
  0,
  'no public or crm_private function outside the explicit allow-list is callable by an API role'
);

drop function crm_private.default_acl_probe();
drop function public.default_acl_probe();
drop table public.default_acl_probe;

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
       'enquiry_status_transitions', 'system_settings', 'retention_holds',
       'artist_availability_blocks')),
  'every CRM table has row level security enabled and forced'
);

select * from finish(true);
rollback;