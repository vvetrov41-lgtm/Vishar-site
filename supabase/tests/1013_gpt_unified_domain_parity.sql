-- 1013_gpt_unified_domain_parity.sql
--
-- Unified GPT v2 operator parity: the shared domain context, the new owner-only
-- ceilings, record ownership, idempotency receipts and the CRM Core, Projects
-- and Scheduling wrappers.

begin;
select no_plan();

-- ------------------------------------------------------------ closed surface

select ok(
  (select bool_and(
     not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'crm_private'
     and p.proname in ('require_gpt_ceiling', 'require_gpt_domain_context', 'require_gpt_profile_scope',
                       'require_gpt_context_workspace', 'require_gpt_record_artist',
                       'require_gpt_client_exclusive', 'gpt_receipt_begin', 'gpt_receipt_finish')),
  'no API role can call a unified GPT resolver directly'
);

select ok(
  (select bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')
     and p.prosecdef
     and array_to_string(p.proconfig, ',') like '%search_path=%')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('gpt_list_my_capabilities', 'gpt_get_today_pulse', 'gpt_archive_client',
                       'gpt_get_client_ai_state', 'gpt_archive_enquiry', 'gpt_get_enquiry_ai_result',
                       'gpt_retry_enquiry_ai', 'gpt_remove_enquiry_file',
                       'gpt_schedule_appointment_with_price', 'gpt_set_appointment_price',
                       'gpt_list_booking_conflicts', 'gpt_schedule_project_session',
                       'gpt_set_project_session_status', 'gpt_get_session_booking_card_status',
                       'gpt_get_scheduling_preferences', 'gpt_set_scheduling_preferences',
                       'gpt_list_schedule_overrides', 'gpt_set_schedule_override',
                       'gpt_get_session_pricing', 'gpt_set_session_pricing')),
  'every new wrapper is an authenticated-only SECURITY DEFINER function with a pinned search_path'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('gpt_list_my_capabilities', 'gpt_get_today_pulse', 'gpt_archive_client',
                       'gpt_get_client_ai_state', 'gpt_archive_enquiry', 'gpt_get_enquiry_ai_result',
                       'gpt_retry_enquiry_ai', 'gpt_remove_enquiry_file',
                       'gpt_schedule_appointment_with_price', 'gpt_set_appointment_price',
                       'gpt_list_booking_conflicts', 'gpt_schedule_project_session',
                       'gpt_set_project_session_status', 'gpt_get_session_booking_card_status',
                       'gpt_get_scheduling_preferences', 'gpt_set_scheduling_preferences',
                       'gpt_list_schedule_overrides', 'gpt_set_schedule_override',
                       'gpt_get_session_pricing', 'gpt_set_session_pricing')),
  20,
  'all twenty wrappers of this stage exist'
);

select ok(
  (select not bool_or(pg_get_function_identity_arguments(p.oid) ~ 'p_artist_id|p_workspace_id')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'gpt\_%' and p.proname <> 'gpt_artist_context'),
  'no GPT business RPC accepts an Artist or workspace id'
);

-- New ceilings default off and are physically unavailable to Artist-bound clients.
select ok(
  (select bool_and(not can_manage_automations and not can_manage_integrations and not can_administer_workspace)
   from crm_private.gpt_action_clients),
  'the new unified ceilings ship off for every GPT client'
);
select throws_ok(
  $$update crm_private.gpt_action_clients set can_administer_workspace = true
    where integration_key = 'vladimir-gpt-actions'$$,
  '23514', null,
  'a legacy Artist-bound client cannot carry a unified-only ceiling'
);

-- ------------------------------------------------------------------ fixtures

insert into auth.users (id, email) values
  ('dc011111-1111-4111-8111-111111111111', 'gpt-parity-owner@example.test'),
  ('dc022222-2222-4222-8222-222222222222', 'gpt-parity-manager@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('dc011111-1111-4111-8111-111111111111', 'gpt-parity-owner@example.test', 'GPT Parity Owner', 'owner', true),
  ('dc022222-2222-4222-8222-222222222222', 'gpt-parity-manager@example.test', 'GPT Parity Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'dc022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'manager',
  false, false, true, false, true
);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"dc022222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  $$select public.configure_gpt_unified_domain_access('vishar-unified-gpt', true, true, true)$$,
  '42501', null,
  'a non-owner cannot configure unified GPT domain ceilings'
);

select pg_temp.claims('{"sub":"dc011111-1111-4111-8111-111111111111","role":"authenticated"}');
select throws_ok(
  $$select public.configure_gpt_unified_domain_access('vishar-unified-gpt', true, false, false)$$,
  '42501', null,
  'domain ceilings cannot be enabled while the unified client is dormant'
);
select throws_ok(
  $$select public.configure_gpt_unified_domain_access('vladimir-gpt-actions', true, false, false)$$,
  '42501', null,
  'the owner cannot hand unified domain ceilings to a legacy Artist-bound client'
);
select lives_ok(
  $$select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-parity', true, true)$$,
  'owner binds the unified client for the fixture'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true)$$,
  'owner enables unified enquiry reads'
);
select lives_ok(
  $$select public.configure_gpt_full_management('vishar-unified-gpt', true, false, true)$$,
  'owner enables unified CRM and communications, finance still off'
);
select lives_ok(
  $$select public.configure_gpt_unified_domain_access('vishar-unified-gpt', true, true, true)$$,
  'owner enables the unified domain ceilings on the active profile-bound client'
);
reset role;
select ok(
  (select can_manage_automations and can_manage_integrations and can_administer_workspace
   from crm_private.gpt_action_clients where integration_key = 'vishar-unified-gpt'),
  'the unified client now carries the new ceilings'
);
set local role authenticated;

create temporary table parity_vladimir as
select public.create_manual_enquiry(
  'dc031111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('full_name', 'Parity Vladimir Client', 'email', 'parity-vladimir@example.test'),
  jsonb_build_object('project_type', 'Realism', 'placement', 'Forearm', 'idea', 'Synthetic parity fixture'),
  true) as result;
create temporary table parity_kristina as
select public.create_manual_enquiry(
  'dc032222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object('full_name', 'Parity Kristina Client', 'email', 'parity-kristina@example.test'),
  jsonb_build_object('project_type', 'Fine line', 'placement', 'Ankle', 'idea', 'Synthetic parity fixture'),
  true) as result;
grant select on parity_vladimir, parity_kristina to authenticated;

select public.transition_enquiry_status((select (result ->> 'enquiry_id')::uuid from parity_vladimir), 'accepted');
create temporary table parity_project as
select (public.convert_enquiry_to_project(
  (select (result ->> 'enquiry_id')::uuid from parity_vladimir), 'Parity project', 'Synthetic')) as result;
grant select on parity_project to authenticated;

-- ------------------------------------------------ context before any action

select pg_temp.claims('{"sub":"dc011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-parity"}');
select throws_ok(
  $$select public.gpt_list_my_capabilities()$$,
  '22023', null,
  'a multi-Artist owner must select an Artist before any domain action'
);
select lives_ok(
  $$select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111')$$,
  'the owner selects Vladimir through the context contract'
);
select ok(
  jsonb_array_length(public.gpt_list_my_capabilities()) > 0,
  'capabilities are listed for the active Artist'
);
select ok(
  (select bool_and(item ->> 'artist_id' = 'a1111111-1111-4111-8111-111111111111')
   from jsonb_array_elements(public.gpt_list_my_capabilities()) item),
  'capabilities never describe an Artist other than the active one'
);
select lives_ok($$select public.gpt_get_today_pulse()$$, 'Today pulse reads for the active Artist');

-- ---------------------------------------------------- record ownership rules

select throws_ok(
  $$select public.gpt_get_enquiry_ai_result((select (result ->> 'enquiry_id')::uuid from parity_kristina))$$,
  '42501', null,
  'a Kristina enquiry cannot be read while the context is Vladimir'
);
select throws_ok(
  $$select public.gpt_archive_enquiry((select (result ->> 'enquiry_id')::uuid from parity_kristina))$$,
  '42501', null,
  'a Kristina enquiry cannot be archived while the context is Vladimir'
);
select throws_ok(
  $$select public.gpt_get_client_ai_state((select (result ->> 'client_id')::uuid from parity_kristina))$$,
  '42501', null,
  'a Kristina-only client is outside the Vladimir context'
);
select lives_ok(
  $$select public.gpt_get_enquiry_ai_result((select (result ->> 'enquiry_id')::uuid from parity_vladimir))$$,
  'a Vladimir enquiry AI result reads in the Vladimir context'
);

-- ----------------------------------------------------------- scheduling path

select lives_ok($$select public.gpt_get_scheduling_preferences()$$, 'scheduling preferences read');
select lives_ok(
  $$select public.gpt_set_scheduling_preferences('10:00', '19:00', array['10:00', '12:00'], '10:00', '18:00', false, 1)$$,
  'scheduling preferences write through the CRM contract'
);
select is(
  public.gpt_get_scheduling_preferences() ->> 'tattoo_earliest_start',
  '10:00',
  'the preference change is visible through the same read'
);
select lives_ok($$select public.gpt_list_schedule_overrides(current_date, current_date + 30)$$, 'overrides list');
select lives_ok(
  $$select public.gpt_list_booking_conflicts('tattoo_session', now() + interval '10 days', now() + interval '10 days 4 hours')$$,
  'booking conflicts check'
);

create temporary table parity_session_first as
select public.gpt_schedule_project_session(
  'dc041111-1111-4111-8111-111111111111',
  (select (result ->> 'project_id')::uuid from parity_project),
  date_trunc('day', now()) + interval '20 days 11 hours',
  date_trunc('day', now()) + interval '20 days 15 hours',
  'proposed', 'Parity session') as result;
grant select on parity_session_first to authenticated;
select is(
  (select result ->> 'idempotent_replay' from parity_session_first),
  'false',
  'the first project-session request runs'
);
select is(
  (public.gpt_schedule_project_session(
     'dc041111-1111-4111-8111-111111111111',
     (select (result ->> 'project_id')::uuid from parity_project),
     date_trunc('day', now()) + interval '20 days 11 hours',
     date_trunc('day', now()) + interval '20 days 15 hours',
     'proposed', 'Parity session')) ->> 'idempotent_replay',
  'true',
  'an identical retry replays the receipt instead of booking twice'
);
select throws_ok(
  $$select public.gpt_schedule_project_session(
     'dc041111-1111-4111-8111-111111111111',
     (select (result ->> 'project_id')::uuid from parity_project),
     date_trunc('day', now()) + interval '21 days 11 hours',
     date_trunc('day', now()) + interval '21 days 15 hours',
     'proposed', 'Changed')$$,
  '22023', null,
  'a request_id cannot be reused for a different booking'
);

-- Finance ceiling is off for this client: the money setting is refused.
select throws_ok(
  $$select public.gpt_set_session_pricing(150, 900, 7, 100, 'GBP')$$,
  '42501', null,
  'session pricing needs the finance ceiling'
);

-- Switching context moves every read with it; no Vladimir data leaks after.
select lives_ok(
  $$select public.gpt_artist_context('a2222222-2222-4222-8222-222222222222')$$,
  'the owner switches to Kristina'
);
select throws_ok(
  $$select public.gpt_schedule_project_session(
     'dc042222-2222-4222-8222-222222222222',
     (select (result ->> 'project_id')::uuid from parity_project),
     date_trunc('day', now()) + interval '22 days 11 hours',
     date_trunc('day', now()) + interval '22 days 15 hours',
     'proposed', null)$$,
  '42501', null,
  'a Vladimir project is outside the Kristina context'
);

-- ------------------------------------------ human capability still applies

select pg_temp.claims('{"sub":"dc022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-parity"}');
select lives_ok($$select public.gpt_get_scheduling_preferences()$$, 'a single-Artist manager needs no selection step');
select throws_ok(
  $$select public.gpt_archive_client((select (result ->> 'client_id')::uuid from parity_kristina))$$,
  '42501', null,
  'a manager cannot reach a client of an Artist they do not belong to'
);

select * from finish();
rollback;
