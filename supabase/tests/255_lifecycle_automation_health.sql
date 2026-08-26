begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- API boundary
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege(
    'authenticated', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  ),
  'authenticated CRM users can execute the lifecycle health RPC'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  ),
  'anonymous callers cannot execute the lifecycle health RPC'
);
select ok(
  not has_function_privilege(
    'service_role', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  ),
  'the service backend cannot impersonate a browser lifecycle health read'
);
select is(
  (select prosecdef from pg_proc
   where oid = 'public.get_lifecycle_automation_health(uuid)'::regprocedure),
  true,
  'lifecycle health is SECURITY DEFINER'
);
select is(
  (select provolatile::text from pg_proc
   where oid = 'public.get_lifecycle_automation_health(uuid)'::regprocedure),
  's',
  'lifecycle health is stable and read-only'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(proconfig)
   from pg_proc
   where oid = 'public.get_lifecycle_automation_health(uuid)'::regprocedure),
  'lifecycle health pins its search path'
);
select ok(
  pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%client%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%subject%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%body%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%destination%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%provider%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) not ilike '%error%',
  'health result excludes client data, message copy, destinations, providers and raw errors'
);

-- ---------------------------------------------------------------------------
-- Isolated Artist fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('fd100000-0000-4000-8000-000000000001', 'health-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fd100000-0000-4000-8000-000000000001', 'health-reader@example.test',
   'Health Reader', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fd200000-0000-4000-8000-000000000001', 'health-home', 'Health Home', 'studio', true),
  ('fd200000-0000-4000-8000-000000000002', 'health-foreign', 'Health Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fd300000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001',
   'health-home-artist', 'Health Home Artist', true),
  ('fd300000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000002',
   'health-foreign-artist', 'Health Foreign Artist', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'fd100000-0000-4000-8000-000000000001',
  'fd300000-0000-4000-8000-000000000001',
  'manager', false, false, false, false, true, 'explicit'
);

insert into public.message_templates (
  id, workspace_id, artist_id, purpose, channel, locale, version, status, subject, body
) values
  (
    'fd400000-0000-4000-8000-000000000001',
    'fd200000-0000-4000-8000-000000000001', null,
    'session_reminder_24h', 'email', 'en', 1, 'active',
    'Your appointment', 'Your appointment is tomorrow.'
  ),
  (
    'fd400000-0000-4000-8000-000000000003',
    'fd200000-0000-4000-8000-000000000001',
    'fd300000-0000-4000-8000-000000000001',
    'session_reminder_24h', 'email', 'en', 2, 'active',
    '{{confirm_link}}', 'Artist override with an action link in its subject.'
  );

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('fd500000-0000-4000-8000-000000000001', 'fd300000-0000-4000-8000-000000000001',
   'Healthy reminder', 'appointment.scheduled', 'send_client_message', 'Healthy reminder', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true),
  ('fd500000-0000-4000-8000-000000000002', 'fd300000-0000-4000-8000-000000000001',
   'Missing template', 'appointment.scheduled', 'send_client_message', 'Missing template', 'normal',
   'session_start', -1440, 'in_person_consultation', 'consultation_reminder', 'email', 'en', true),
  ('fd500000-0000-4000-8000-000000000004', 'fd300000-0000-4000-8000-000000000001',
   'Disabled reminder', 'appointment.scheduled', 'send_client_message', 'Disabled reminder', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false),
  ('fd500000-0000-4000-8000-000000000005', 'fd300000-0000-4000-8000-000000000002',
   'Foreign reminder', 'appointment.scheduled', 'send_client_message', 'Foreign reminder', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true);

-- Simulate a legacy malformed rule that predates the current write guard. The
-- health read must report it rather than trusting that all stored history was
-- necessarily authored by today's code.
alter table public.automation_rules disable trigger automation_rules_guard_client_definition;
insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values (
  'fd500000-0000-4000-8000-000000000003', 'fd300000-0000-4000-8000-000000000001',
  'Legacy malformed reminder', 'appointment.scheduled',
  'send_client_message', 'Legacy malformed reminder', 'normal',
  'session_start', 60, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true
);
alter table public.automation_rules enable trigger automation_rules_guard_client_definition;

create temporary table lifecycle_health_side_effects_before as
select
  (select count(*) from public.automation_jobs) as jobs,
  (select count(*) from public.email_messages) as emails,
  (select count(*) from public.integration_outbox) as outbox;

create function pg_temp.as_health_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_health_profile(uuid) to authenticated;

reset role;
select pg_temp.as_health_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;

select is(
  (select row(
     health_status, automation_enabled, active_rule_count, disabled_rule_count,
     attention_item_count, missing_template_rule_count, invalid_rule_count,
     integration_available, recent_failed_job_count
   )::text
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  row('attention', true, 3, 1, 3, 2, 1, false, 0)::text,
  'health aggregates active, disabled, invalid, missing-template and integration state'
);
select is(
  (select missing_template_rule_count
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  2,
  'an unusable Artist override is not hidden by a usable workspace fallback'
);
select is(
  (select blocker_codes::text
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  '{integration_unavailable,missing_active_template,invalid_rule}',
  'health returns deterministic allowlisted blocker codes'
);
select is(
  (select count(*)::integer
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000002')),
  0,
  'cross-Artist health fails closed'
);

reset role;
delete from public.message_templates
where id = 'fd400000-0000-4000-8000-000000000003';
insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'fd600000-0000-4000-8000-000000000001',
  'fd300000-0000-4000-8000-000000000001',
  'email', 'google', 'health-google-email',
  'health@example.test', '{}'::jsonb, true
);
insert into public.message_templates (
  id, workspace_id, artist_id, purpose, channel, locale, version, status, subject, body
) values (
  'fd400000-0000-4000-8000-000000000002',
  'fd200000-0000-4000-8000-000000000001', null,
  'consultation_reminder', 'email', 'en', 1, 'active',
  'Your consultation', 'Your consultation is tomorrow.'
);
update public.automation_rules
set anchor_offset_minutes = -60
where id = 'fd500000-0000-4000-8000-000000000003';

select pg_temp.as_health_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select row(health_status, attention_item_count, integration_available, blocker_codes)::text
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  row('healthy', 0, true, array[]::text[])::text,
  'health becomes healthy after all active rules have a usable template and integration'
);

reset role;
insert into public.automation_kill_switches (scope_kind, scope_id, is_enabled, note)
values ('artist', 'fd300000-0000-4000-8000-000000000001', false, 'health fixture pause');

select pg_temp.as_health_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select row(health_status, automation_enabled, attention_item_count, blocker_codes)::text
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  row('attention', false, 1, array['automation_paused']::text[])::text,
  'an Artist kill switch is reported as an attention item'
);

reset role;
delete from public.automation_kill_switches
where scope_kind = 'artist'
  and scope_id = 'fd300000-0000-4000-8000-000000000001';
update public.automation_rules
set is_enabled = false
where artist_id = 'fd300000-0000-4000-8000-000000000001';

select pg_temp.as_health_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select row(health_status, active_rule_count, disabled_rule_count, attention_item_count)::text
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  row('inactive', 0, 4, 0)::text,
  'an Artist with only intentionally disabled rules is inactive rather than unhealthy'
);

reset role;
update crm_private.profile_access
set is_active = false
where profile_id = 'fd100000-0000-4000-8000-000000000001';

set local role authenticated;
select is(
  (select count(*)::integer
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  0,
  'inactive identities receive no lifecycle health row'
);

reset role;
select is(
  (select row(
     (select count(*) from public.automation_jobs),
     (select count(*) from public.email_messages),
     (select count(*) from public.integration_outbox)
   )::text),
  (select row(jobs, emails, outbox)::text from lifecycle_health_side_effects_before),
  'health reads create no jobs, messages or outbox rows'
);

select ok(
  not has_table_privilege('authenticated', 'public.automation_jobs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.message_templates', 'SELECT'),
  'health RPC does not widen protected direct table reads'
);

select * from finish();
rollback;
