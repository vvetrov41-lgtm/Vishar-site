begin;
select no_plan();

-- The existing health RPC keeps its exact input signature/ACL while appending
-- bounded operational timing fields for the later diagnostics UI.
select ok(
  has_function_privilege(
    'authenticated', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_lifecycle_automation_health(uuid)', 'EXECUTE'
  ),
  'health diagnostics preserve the browser-only authenticated RPC boundary'
);
select ok(
  pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%pending_job_count%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%overdue_pending_job_count%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%next_scheduled_at%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%oldest_overdue_pending_at%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%last_completed_at%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%last_failed_at%',
  'health exposes only the bounded runtime diagnostic fields added by 0111'
);

-- ---------------------------------------------------------------------------
-- Isolated Artist and runtime fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('fe100000-0000-4000-8000-000000000001', 'health-diagnostics@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fe100000-0000-4000-8000-000000000001', 'health-diagnostics@example.test',
   'Health Diagnostics', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fe200000-0000-4000-8000-000000000001', 'health-diagnostics-home',
   'Health Diagnostics Home', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fe300000-0000-4000-8000-000000000001', 'fe200000-0000-4000-8000-000000000001',
   'health-diagnostics-artist', 'Health Diagnostics Artist', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'fe100000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'manager', false, false, false, false, true, 'explicit'
);

insert into public.message_templates (
  id, workspace_id, artist_id, purpose, channel, locale, version, status, subject, body
) values (
  'fe400000-0000-4000-8000-000000000001',
  'fe200000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'session_reminder_24h', 'email', 'en', 1, 'active',
  'Your appointment', 'Your appointment is tomorrow.'
);

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'fe500000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'email', 'google', 'health-diagnostics-google-email',
  'health-diagnostics@example.test', '{}'::jsonb, true
);

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values (
  'fe600000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'Diagnostics reminder', 'appointment.scheduled',
  'send_client_message', 'Diagnostics reminder', 'normal',
  'session_start', -1440, 'tattoo_session',
  'session_reminder_24h', 'email', 'en', true
);

insert into public.clients (id, full_name, email) values (
  'fe700000-0000-4000-8000-000000000001',
  'Diagnostics Client', 'diagnostics-client@example.test'
);

insert into public.projects (id, client_id, artist_id, title) values (
  'fe800000-0000-4000-8000-000000000001',
  'fe700000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'Diagnostics Project'
);

-- Use one transaction-stable, five-minute-aligned clock base. Session writes
-- enforce five-minute increments, so raw now() (with seconds/microseconds)
-- would make an otherwise valid diagnostics fixture fail before the RPC test.
insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type, status, start_at, end_at
) values
  (
    'fe900000-0000-4000-8000-000000000001',
    'fe800000-0000-4000-8000-000000000001',
    'fe700000-0000-4000-8000-000000000001',
    'fe300000-0000-4000-8000-000000000001',
    'tattoo_session', 'confirmed',
    date_trunc('hour', now()) + interval '2 hours',
    date_trunc('hour', now()) + interval '9 hours'
  ),
  (
    'fe900000-0000-4000-8000-000000000002',
    'fe800000-0000-4000-8000-000000000001',
    'fe700000-0000-4000-8000-000000000001',
    'fe300000-0000-4000-8000-000000000001',
    'tattoo_session', 'confirmed',
    date_trunc('hour', now()) - interval '30 minutes',
    date_trunc('hour', now()) + interval '6 hours 30 minutes'
  ),
  (
    'fe900000-0000-4000-8000-000000000003',
    'fe800000-0000-4000-8000-000000000001',
    'fe700000-0000-4000-8000-000000000001',
    'fe300000-0000-4000-8000-000000000001',
    'tattoo_session', 'completed',
    date_trunc('hour', now()) - interval '1 day',
    date_trunc('hour', now()) - interval '17 hours'
  ),
  (
    'fe900000-0000-4000-8000-000000000004',
    'fe800000-0000-4000-8000-000000000001',
    'fe700000-0000-4000-8000-000000000001',
    'fe300000-0000-4000-8000-000000000001',
    'tattoo_session', 'confirmed',
    date_trunc('hour', now()) - interval '3 hours',
    date_trunc('hour', now()) + interval '4 hours'
  );

insert into public.automation_events (
  id, activity_id, artist_id, event_type, entity_kind, entity_id, occurred_at
) values
  ('fea00000-0000-4000-8000-000000000001', 'feb00000-0000-4000-8000-000000000001',
   'fe300000-0000-4000-8000-000000000001', 'appointment.scheduled', 'session',
   'fe900000-0000-4000-8000-000000000001', date_trunc('hour', now()) - interval '1 day'),
  ('fea00000-0000-4000-8000-000000000002', 'feb00000-0000-4000-8000-000000000002',
   'fe300000-0000-4000-8000-000000000001', 'appointment.scheduled', 'session',
   'fe900000-0000-4000-8000-000000000002', date_trunc('hour', now()) - interval '1 day'),
  ('fea00000-0000-4000-8000-000000000003', 'feb00000-0000-4000-8000-000000000003',
   'fe300000-0000-4000-8000-000000000001', 'appointment.scheduled', 'session',
   'fe900000-0000-4000-8000-000000000003', date_trunc('hour', now()) - interval '2 days'),
  ('fea00000-0000-4000-8000-000000000004', 'feb00000-0000-4000-8000-000000000004',
   'fe300000-0000-4000-8000-000000000001', 'appointment.scheduled', 'session',
   'fe900000-0000-4000-8000-000000000004', date_trunc('hour', now()) - interval '1 day');

insert into public.automation_jobs (
  id, rule_id, rule_version, event_id, artist_id,
  action_type, action_title, action_priority,
  scheduled_at, status, attempt_count, completed_at, updated_at,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, session_id
) values
  (
    'fec00000-0000-4000-8000-000000000001',
    'fe600000-0000-4000-8000-000000000001', 1,
    'fea00000-0000-4000-8000-000000000001',
    'fe300000-0000-4000-8000-000000000001',
    'send_client_message', 'Diagnostics reminder', 'normal',
    date_trunc('hour', now()) + interval '2 hours', 'pending', 0, null,
    date_trunc('hour', now()),
    'session_start', -1440, 'tattoo_session',
    'session_reminder_24h', 'email', 'en',
    'fe900000-0000-4000-8000-000000000001'
  ),
  (
    'fec00000-0000-4000-8000-000000000002',
    'fe600000-0000-4000-8000-000000000001', 1,
    'fea00000-0000-4000-8000-000000000002',
    'fe300000-0000-4000-8000-000000000001',
    'send_client_message', 'Diagnostics reminder', 'normal',
    date_trunc('hour', now()) - interval '30 minutes', 'pending', 0, null,
    date_trunc('hour', now()) - interval '30 minutes',
    'session_start', -1440, 'tattoo_session',
    'session_reminder_24h', 'email', 'en',
    'fe900000-0000-4000-8000-000000000002'
  ),
  (
    'fec00000-0000-4000-8000-000000000003',
    'fe600000-0000-4000-8000-000000000001', 1,
    'fea00000-0000-4000-8000-000000000003',
    'fe300000-0000-4000-8000-000000000001',
    'send_client_message', 'Diagnostics reminder', 'normal',
    date_trunc('hour', now()) - interval '1 day', 'completed', 1,
    date_trunc('hour', now()) - interval '23 hours',
    date_trunc('hour', now()) - interval '23 hours',
    'session_start', -1440, 'tattoo_session',
    'session_reminder_24h', 'email', 'en',
    'fe900000-0000-4000-8000-000000000003'
  ),
  (
    'fec00000-0000-4000-8000-000000000004',
    'fe600000-0000-4000-8000-000000000001', 1,
    'fea00000-0000-4000-8000-000000000004',
    'fe300000-0000-4000-8000-000000000001',
    'send_client_message', 'Diagnostics reminder', 'normal',
    date_trunc('hour', now()) - interval '3 hours', 'failed', 3, null,
    date_trunc('hour', now()) - interval '2 hours',
    'session_start', -1440, 'tattoo_session',
    'session_reminder_24h', 'email', 'en',
    'fe900000-0000-4000-8000-000000000004'
  );

create function pg_temp.as_health_diagnostics_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_health_diagnostics_profile(uuid) to authenticated;

select pg_temp.as_health_diagnostics_profile('fe100000-0000-4000-8000-000000000001');
set local role authenticated;

select is(
  (select row(
     health_status,
     recent_failed_job_count,
     pending_job_count,
     overdue_pending_job_count
   )::text
   from public.get_lifecycle_automation_health('fe300000-0000-4000-8000-000000000001')),
  row('healthy', 1, 2, 1)::text,
  'diagnostics count pending and overdue jobs without changing the existing health threshold'
);
select is(
  (select next_scheduled_at
   from public.get_lifecycle_automation_health('fe300000-0000-4000-8000-000000000001')),
  date_trunc('hour', now()) + interval '2 hours',
  'diagnostics expose the next future pending schedule time'
);
select is(
  (select oldest_overdue_pending_at
   from public.get_lifecycle_automation_health('fe300000-0000-4000-8000-000000000001')),
  date_trunc('hour', now()) - interval '30 minutes',
  'diagnostics expose the oldest overdue pending schedule time'
);
select is(
  (select last_completed_at
   from public.get_lifecycle_automation_health('fe300000-0000-4000-8000-000000000001')),
  date_trunc('hour', now()) - interval '23 hours',
  'diagnostics expose the most recent completed lifecycle job time'
);
select is(
  (select last_failed_at
   from public.get_lifecycle_automation_health('fe300000-0000-4000-8000-000000000001')),
  date_trunc('hour', now()) - interval '2 hours',
  'diagnostics expose the most recent failed lifecycle job time'
);

reset role;
select is(
  (select count(*)::integer from public.automation_jobs
   where artist_id = 'fe300000-0000-4000-8000-000000000001'),
  4,
  'health diagnostics remain read-only and create no additional jobs'
);

select * from finish();
rollback;
