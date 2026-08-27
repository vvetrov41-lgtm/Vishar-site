begin;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'fa100000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000000'::uuid,
  'authenticated', 'authenticated', 'recovery-manager@example.test',
  crypt('recovery-manager-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

insert into public.profiles (id, email, display_name, role, is_active)
values (
  'fa100000-0000-4000-8000-000000000001'::uuid,
  'recovery-manager@example.test', 'Recovery Manager', 'booking_manager', true
);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active)
values
  ('fa200000-0000-4000-8000-000000000001'::uuid, 'recovery-home', 'Recovery Home', 'studio', true),
  ('fa200000-0000-4000-8000-000000000002'::uuid, 'recovery-foreign', 'Recovery Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, timezone, default_currency, is_active)
values
  ('fa300000-0000-4000-8000-000000000001'::uuid, 'fa200000-0000-4000-8000-000000000001'::uuid, 'recovery-home-artist', 'Recovery Home Artist', 'Europe/London', 'GBP', true),
  ('fa300000-0000-4000-8000-000000000002'::uuid, 'fa200000-0000-4000-8000-000000000002'::uuid, 'recovery-foreign-artist', 'Recovery Foreign Artist', 'Europe/London', 'GBP', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'fa100000-0000-4000-8000-000000000001'::uuid,
  'fa300000-0000-4000-8000-000000000001'::uuid,
  'manager', false, false, false, true, true, 'explicit'
);

insert into public.clients (id, full_name, email)
values
  ('fa400000-0000-4000-8000-000000000001'::uuid, 'Recovery Client', 'recovery-client@example.test'),
  ('fa400000-0000-4000-8000-000000000002'::uuid, 'Foreign Recovery Client', 'foreign-recovery@example.test');

insert into public.projects (id, client_id, artist_id, title, status)
values
  ('fa500000-0000-4000-8000-000000000001'::uuid, 'fa400000-0000-4000-8000-000000000001'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'Recovery Project', 'active'),
  ('fa500000-0000-4000-8000-000000000002'::uuid, 'fa400000-0000-4000-8000-000000000002'::uuid, 'fa300000-0000-4000-8000-000000000002'::uuid, 'Foreign Recovery Project', 'active');

insert into public.sessions (
  id, artist_id, client_id, project_id, appointment_type, start_at, end_at, status
) values
  ('fa600000-0000-4000-8000-000000000001'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'fa400000-0000-4000-8000-000000000001'::uuid, 'fa500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-10 10:00:00+00', '2026-09-10 17:00:00+00', 'confirmed'),
  ('fa600000-0000-4000-8000-000000000002'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'fa400000-0000-4000-8000-000000000001'::uuid, 'fa500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-11 10:00:00+00', '2026-09-11 17:00:00+00', 'confirmed'),
  ('fa600000-0000-4000-8000-000000000003'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'fa400000-0000-4000-8000-000000000001'::uuid, 'fa500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-12 10:00:00+00', '2026-09-12 17:00:00+00', 'confirmed'),
  ('fa600000-0000-4000-8000-000000000004'::uuid, 'fa300000-0000-4000-8000-000000000002'::uuid, 'fa400000-0000-4000-8000-000000000002'::uuid, 'fa500000-0000-4000-8000-000000000002'::uuid, 'tattoo_session', '2026-09-13 10:00:00+00', '2026-09-13 17:00:00+00', 'confirmed');

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('fa700000-0000-4000-8000-000000000001'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'Recovery Rule', 'appointment.scheduled',
   'send_client_message', 'Recovery Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true),
  ('fa700000-0000-4000-8000-000000000002'::uuid, 'fa300000-0000-4000-8000-000000000002'::uuid, 'Foreign Recovery Rule', 'appointment.scheduled',
   'send_client_message', 'Foreign Recovery Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true);

insert into public.automation_events (
  id, activity_id, artist_id, event_type, entity_kind, entity_id, occurred_at
) values
  ('fa800000-0000-4000-8000-000000000001'::uuid, 'fa810000-0000-4000-8000-000000000001'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'appointment.scheduled', 'session', 'fa600000-0000-4000-8000-000000000001'::uuid, now()),
  ('fa800000-0000-4000-8000-000000000002'::uuid, 'fa810000-0000-4000-8000-000000000002'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'appointment.scheduled', 'session', 'fa600000-0000-4000-8000-000000000002'::uuid, now()),
  ('fa800000-0000-4000-8000-000000000003'::uuid, 'fa810000-0000-4000-8000-000000000003'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid, 'appointment.scheduled', 'session', 'fa600000-0000-4000-8000-000000000003'::uuid, now()),
  ('fa800000-0000-4000-8000-000000000004'::uuid, 'fa810000-0000-4000-8000-000000000004'::uuid, 'fa300000-0000-4000-8000-000000000002'::uuid, 'appointment.scheduled', 'session', 'fa600000-0000-4000-8000-000000000004'::uuid, now());

insert into public.automation_jobs (
  id, rule_id, rule_version, event_id, artist_id,
  action_type, action_title, action_priority,
  scheduled_at, status, attempt_count, last_error_category,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, session_id,
  completed_at
) values
  ('fa900000-0000-4000-8000-000000000001'::uuid, 'fa700000-0000-4000-8000-000000000001'::uuid, 1, 'fa800000-0000-4000-8000-000000000001'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'Recovery Rule', 'normal', now() - interval '1 hour', 'failed', 2, 'integration_unavailable',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'fa600000-0000-4000-8000-000000000001'::uuid, null),
  ('fa900000-0000-4000-8000-000000000002'::uuid, 'fa700000-0000-4000-8000-000000000001'::uuid, 1, 'fa800000-0000-4000-8000-000000000002'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'Recovery Rule', 'normal', now() - interval '2 hours', 'failed', 3, 'unknown',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'fa600000-0000-4000-8000-000000000002'::uuid, null),
  ('fa900000-0000-4000-8000-000000000003'::uuid, 'fa700000-0000-4000-8000-000000000001'::uuid, 1, 'fa800000-0000-4000-8000-000000000003'::uuid, 'fa300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'Recovery Rule', 'normal', now() - interval '3 hours', 'completed', 1, 'none',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'fa600000-0000-4000-8000-000000000003'::uuid, now() - interval '3 hours'),
  ('fa900000-0000-4000-8000-000000000004'::uuid, 'fa700000-0000-4000-8000-000000000002'::uuid, 1, 'fa800000-0000-4000-8000-000000000004'::uuid, 'fa300000-0000-4000-8000-000000000002'::uuid,
   'send_client_message', 'Foreign Recovery Rule', 'normal', now() - interval '1 hour', 'failed', 1, 'template_unavailable',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'fa600000-0000-4000-8000-000000000004'::uuid, null);

-- Even a failed execution becomes non-retryable once an email artefact exists.
-- This synthetic edge case pins the duplicate-send boundary explicitly.
insert into public.email_messages (
  id, artist_id, automation_job_id, client_id, project_id,
  to_email, subject, body, created_by_kind, status, approved_at
) values (
  'faa00000-0000-4000-8000-000000000001'::uuid,
  'fa300000-0000-4000-8000-000000000001'::uuid,
  'fa900000-0000-4000-8000-000000000002'::uuid,
  'fa400000-0000-4000-8000-000000000001'::uuid,
  'fa500000-0000-4000-8000-000000000001'::uuid,
  'private-recipient@example.test', 'Private subject', 'Private body',
  'system', 'approved', now()
);

create function pg_temp.as_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated;

select ok(
  has_function_privilege('authenticated', 'public.retry_client_lifecycle_job(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.retry_client_lifecycle_job(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.retry_client_lifecycle_job(uuid)', 'EXECUTE'),
  'only authenticated operators receive SQL execute on lifecycle recovery'
);
select ok(
  (select prosecdef and 'search_path=pg_catalog, public, crm_private'=any(proconfig)
   from pg_proc where oid='public.retry_client_lifecycle_job(uuid)'::regprocedure),
  'recovery RPC is SECURITY DEFINER with a pinned search path'
);
select ok(
  pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) ilike '%retryable boolean%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%to_email%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%body%'
  and pg_get_function_result('public.list_client_lifecycle_execution_history(uuid,integer)'::regprocedure) not ilike '%provider_message_id%',
  'history adds only a boolean recovery hint and keeps sensitive delivery fields private'
);

reset role;
select pg_temp.as_profile('fa100000-0000-4000-8000-000000000001'::uuid);
set local role authenticated;

select is(
  (select retryable from public.list_client_lifecycle_execution_history('fa300000-0000-4000-8000-000000000001'::uuid, 50)
   where job_id='fa900000-0000-4000-8000-000000000001'::uuid),
  true,
  'failed lifecycle execution with no email artefact is server-authoritatively retryable'
);
select is(
  (select retryable from public.list_client_lifecycle_execution_history('fa300000-0000-4000-8000-000000000001'::uuid, 50)
   where job_id='fa900000-0000-4000-8000-000000000002'::uuid),
  false,
  'failed execution with an email artefact is not retryable'
);
select is(
  (select retryable from public.list_client_lifecycle_execution_history('fa300000-0000-4000-8000-000000000001'::uuid, 50)
   where job_id='fa900000-0000-4000-8000-000000000003'::uuid),
  false,
  'completed delivery-phase work is not retryable through execution recovery'
);
select is(
  (select count(*)::integer from public.list_client_lifecycle_execution_history('fa300000-0000-4000-8000-000000000002'::uuid, 50)),
  0,
  'history still fails closed across artist scope'
);

select throws_ok(
  $$select * from public.retry_client_lifecycle_job('fa900000-0000-4000-8000-000000000004'::uuid)$$,
  '42501', null,
  'operator cannot recover another artist execution'
);
select throws_ok(
  $$select * from public.retry_client_lifecycle_job('fa900000-0000-4000-8000-000000000002'::uuid)$$,
  '22023', 'the lifecycle execution is not retryable',
  'email-backed failed execution is rejected to prevent duplicate delivery'
);
select throws_ok(
  $$select * from public.retry_client_lifecycle_job('fa900000-0000-4000-8000-000000000003'::uuid)$$,
  '22023', 'the lifecycle execution is not retryable',
  'completed lifecycle work cannot be requeued'
);

create temporary table recovery_result as
select * from public.retry_client_lifecycle_job('fa900000-0000-4000-8000-000000000001'::uuid);
grant select on recovery_result to authenticated;

select is((select job_status::text from recovery_result), 'pending', 'safe recovery returns pending state');
select is((select attempt_count from recovery_result), 2, 'safe recovery preserves historical attempt count');
select throws_ok(
  $$select * from public.retry_client_lifecycle_job('fa900000-0000-4000-8000-000000000001'::uuid)$$,
  '22023', 'the lifecycle execution is not retryable',
  'recovery is not repeatable once the job is pending'
);

reset role;
select is(
  (select status::text from public.automation_jobs where id='fa900000-0000-4000-8000-000000000001'::uuid),
  'pending',
  'safe failed job is requeued'
);
select is(
  (select attempt_count from public.automation_jobs where id='fa900000-0000-4000-8000-000000000001'::uuid),
  2,
  'requeue does not erase execution attempts'
);
select is(
  (select last_error_category from public.automation_jobs where id='fa900000-0000-4000-8000-000000000001'::uuid),
  null,
  'requeue clears the resolved failure category'
);
select is(
  (select status::text from public.automation_jobs where id='fa900000-0000-4000-8000-000000000002'::uuid),
  'failed',
  'email-backed failure remains terminal'
);
select is(
  (select count(*)::integer from public.activity_log
   where event_type='automation.job_requeued'
     and artist_id='fa300000-0000-4000-8000-000000000001'::uuid
     and client_id is null and enquiry_id is null and project_id is null and session_id is null),
  1,
  'recovery writes one artist-scoped audit event without customer entity linkage'
);
select ok(
  (select metadata @> '{"job_id":"fa900000-0000-4000-8000-000000000001","previous_failure_category":"integration_unavailable","attempt_count":2}'::jsonb
   from public.activity_log
   where event_type='automation.job_requeued'
     and artist_id='fa300000-0000-4000-8000-000000000001'::uuid
   order by created_at desc limit 1),
  'audit metadata contains only bounded technical recovery state'
);
select is(
  (select count(*)::integer from public.email_messages where automation_job_id='fa900000-0000-4000-8000-000000000001'::uuid),
  0,
  'requeue itself creates no email'
);
select is(
  (select count(*)::integer from public.integration_outbox where email_message_id='faa00000-0000-4000-8000-000000000001'::uuid),
  0,
  'requeue itself creates no provider outbox work'
);

select * from finish(true);
rollback;
