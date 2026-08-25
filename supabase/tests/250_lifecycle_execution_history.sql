begin;
select plan(19);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'f5100000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated', 'authenticated', 'history-owner@example.test',
  crypt('history-owner-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

insert into public.user_profiles (id, full_name, role)
values ('f5100000-0000-4000-8000-000000000001'::uuid, 'History Owner', 'owner');

insert into public.workspaces (id, slug, display_name, created_by)
values
  ('f5200000-0000-4000-8000-000000000001'::uuid, 'history-home', 'History Home', 'f5100000-0000-4000-8000-000000000001'::uuid),
  ('f5200000-0000-4000-8000-000000000002'::uuid, 'history-foreign', 'History Foreign', 'f5100000-0000-4000-8000-000000000001'::uuid);

insert into public.workspace_memberships (workspace_id, profile_id, role, is_active, created_by)
values ('f5200000-0000-4000-8000-000000000001'::uuid, 'f5100000-0000-4000-8000-000000000001'::uuid, 'owner', true, 'f5100000-0000-4000-8000-000000000001'::uuid);

insert into public.artists (id, workspace_id, slug, display_name, timezone, default_currency, is_active)
values
  ('f5300000-0000-4000-8000-000000000001'::uuid, 'f5200000-0000-4000-8000-000000000001'::uuid, 'history-home-artist', 'History Home Artist', 'Europe/London', 'GBP', true),
  ('f5300000-0000-4000-8000-000000000002'::uuid, 'f5200000-0000-4000-8000-000000000002'::uuid, 'history-foreign-artist', 'History Foreign Artist', 'Europe/London', 'GBP', true);

insert into public.clients (id, artist_id, full_name, email)
values
  ('f5400000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'History Client', 'history-client@example.test'),
  ('f5400000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'Foreign History Client', 'foreign-history@example.test');

insert into public.projects (id, artist_id, client_id, title, status)
values
  ('f5500000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'f5400000-0000-4000-8000-000000000001'::uuid, 'History Project', 'active'),
  ('f5500000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'f5400000-0000-4000-8000-000000000002'::uuid, 'Foreign History Project', 'active');

insert into public.sessions (
  id, artist_id, client_id, project_id, appointment_type, start_at, end_at, status
) values
  ('f5600000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'f5400000-0000-4000-8000-000000000001'::uuid, 'f5500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-01 10:00:00+00', '2026-09-01 17:00:00+00', 'confirmed'),
  ('f5600000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'f5400000-0000-4000-8000-000000000002'::uuid, 'f5500000-0000-4000-8000-000000000002'::uuid, 'tattoo_session', '2026-09-01 10:00:00+00', '2026-09-01 17:00:00+00', 'confirmed');

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('f5700000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'History Rule', 'appointment.scheduled',
   'send_client_message', 'History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false),
  ('f5700000-0000-4000-8000-000000000003'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'Suppressed History Rule', 'appointment.scheduled',
   'send_client_message', 'Suppressed History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false),
  ('f5700000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'Foreign History Rule', 'appointment.scheduled',
   'send_client_message', 'Foreign History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false);

select set_config('test.history_event_home', public.record_appointment_event(
  'f5300000-0000-4000-8000-000000000001'::uuid,
  'appointment.scheduled', 'session', 'f5600000-0000-4000-8000-000000000001'::uuid,
  null, 'confirmed', now()
)::text, false);
select set_config('test.history_event_foreign', public.record_appointment_event(
  'f5300000-0000-4000-8000-000000000002'::uuid,
  'appointment.scheduled', 'session', 'f5600000-0000-4000-8000-000000000002'::uuid,
  null, 'confirmed', now()
)::text, false);

insert into public.automation_jobs (
  id, rule_id, rule_version, event_id, artist_id,
  action_type, action_title, action_priority,
  scheduled_at, status, attempt_count,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, session_id
) values
  ('f5800000-0000-4000-8000-000000000001'::uuid, 'f5700000-0000-4000-8000-000000000001'::uuid, 1, current_setting('test.history_event_home')::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'History Rule', 'normal', now() + interval '1 day', 'pending', 0,
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'f5600000-0000-4000-8000-000000000001'::uuid),
  ('f5800000-0000-4000-8000-000000000002'::uuid, 'f5700000-0000-4000-8000-000000000003'::uuid, 1, current_setting('test.history_event_home')::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'History Rule', 'normal', now() - interval '1 day', 'cancelled', 1,
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'f5600000-0000-4000-8000-000000000001'::uuid),
  ('f5800000-0000-4000-8000-000000000003'::uuid, 'f5700000-0000-4000-8000-000000000002'::uuid, 1, current_setting('test.history_event_foreign')::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid,
   'send_client_message', 'Foreign History Rule', 'normal', now() + interval '1 day', 'pending', 0,
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'f5600000-0000-4000-8000-000000000002'::uuid);

update public.automation_jobs
set last_error_category = 'client_blocked', cancelled_at = now()
where id = 'f5800000-0000-4000-8000-000000000002'::uuid;

select test_set_auth_claims('f5100000-0000-4000-8000-000000000001'::uuid, 'owner');
set local role authenticated;

select is(
  (select count(*)::integer from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50)),
  2,
  'authorized operator sees only the requested artist history'
);

select is(
  (select lifecycle_status from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50) where job_id='f5800000-0000-4000-8000-000000000001'::uuid),
  'scheduled',
  'future pending job is normalized to scheduled'
);

select is(
  (select lifecycle_status from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50) where job_id='f5800000-0000-4000-8000-000000000002'::uuid),
  'suppressed',
  'client-blocked cancellation is normalized to suppressed'
);

select is(
  (select failure_reason from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50) where job_id='f5800000-0000-4000-8000-000000000002'::uuid),
  'client_suppressed',
  'history exposes only the normalized client suppression reason'
);

select is(
  (select client_name from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50) where job_id='f5800000-0000-4000-8000-000000000001'::uuid),
  'History Client',
  'authorized history can project the RLS-visible client display name'
);

select is(
  (select count(*)::integer from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000002'::uuid, 50)),
  0,
  'cross-workspace artist history fails closed'
);

select is(
  (select count(*)::integer from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 1)),
  1,
  'history limit is bounded and honored'
);

reset role;

select ok(
  not has_table_privilege('authenticated', 'public.automation_jobs', 'SELECT'),
  'history RPC does not widen direct authenticated automation_jobs SELECT'
);

select ok(
  has_function_privilege('authenticated', 'public.list_client_lifecycle_execution_history(uuid,integer)', 'EXECUTE'),
  'authenticated can execute lifecycle history RPC'
);
select ok(
  not has_function_privilege('anon', 'public.list_client_lifecycle_execution_history(uuid,integer)', 'EXECUTE'),
  'anon cannot execute lifecycle history RPC'
);
select ok(
  not has_function_privilege('service_role', 'public.list_client_lifecycle_execution_history(uuid,integer)', 'EXECUTE'),
  'service role cannot execute browser lifecycle history RPC'
);

select is(
  (select prosecdef from pg_proc where oid='public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure),
  true,
  'history RPC is SECURITY DEFINER'
);
select is(
  (select proconfig[1] from pg_proc where oid='public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure),
  'search_path=pg_catalog, public, crm_private',
  'history RPC pins its search_path'
);

select ok(
  pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%to_email%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%provider_message_id%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%payload%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%last_error_code%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%last_error_category%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%body%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%subject%',
  'history projection excludes recipient, provider, payload, raw error and message content fields'
);

update crm_private.profile_access
set is_active=false
where profile_id='f5100000-0000-4000-8000-000000000001'::uuid;

set local role authenticated;
select is(
  (select count(*)::integer from public.list_client_lifecycle_execution_history('f5300000-0000-4000-8000-000000000001'::uuid, 50)),
  0,
  'inactive identity receives no lifecycle history rows'
);
reset role;

select ok(
  exists (select 1 from public.automation_rules where id='f5700000-0000-4000-8000-000000000001'::uuid and not is_enabled),
  'history read leaves lifecycle rule state unchanged'
);
select ok(
  exists (select 1 from public.automation_jobs where id='f5800000-0000-4000-8000-000000000001'::uuid and status='pending'),
  'history read leaves automation job state unchanged'
);
select is(
  (select count(*)::integer from public.email_messages where automation_job_id in ('f5800000-0000-4000-8000-000000000001'::uuid,'f5800000-0000-4000-8000-000000000002'::uuid)),
  0,
  'history read creates no email messages'
);
select is(
  (select count(*)::integer from public.integration_outbox where email_message_id in (select id from public.email_messages where automation_job_id in ('f5800000-0000-4000-8000-000000000001'::uuid,'f5800000-0000-4000-8000-000000000002'::uuid))),
  0,
  'history read creates no provider outbox rows'
);

select * from finish();
rollback;
