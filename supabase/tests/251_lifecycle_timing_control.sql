begin;
select plan(30);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'f6100000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000000'::uuid,
  'authenticated', 'authenticated', 'timing-manager@example.test',
  crypt('timing-manager-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

insert into public.profiles (id, email, display_name, role, is_active)
values (
  'f6100000-0000-4000-8000-000000000001'::uuid,
  'timing-manager@example.test', 'Timing Manager', 'booking_manager', true
);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active)
values
  ('f6200000-0000-4000-8000-000000000001'::uuid, 'timing-home', 'Timing Home', 'studio', true),
  ('f6200000-0000-4000-8000-000000000002'::uuid, 'timing-foreign', 'Timing Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, timezone, default_currency, is_active)
values
  ('f6300000-0000-4000-8000-000000000001'::uuid, 'f6200000-0000-4000-8000-000000000001'::uuid, 'timing-home-artist', 'Timing Home Artist', 'Europe/London', 'GBP', true),
  ('f6300000-0000-4000-8000-000000000002'::uuid, 'f6200000-0000-4000-8000-000000000002'::uuid, 'timing-foreign-artist', 'Timing Foreign Artist', 'Europe/London', 'GBP', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'f6100000-0000-4000-8000-000000000001'::uuid,
  'f6300000-0000-4000-8000-000000000001'::uuid,
  'manager', false, false, false, true, true, 'explicit'
);

insert into public.clients (id, full_name, email)
values
  ('f6400000-0000-4000-8000-000000000001'::uuid, 'Timing Client', 'timing-client@example.test');

insert into public.projects (id, client_id, artist_id, title, status)
values
  ('f6500000-0000-4000-8000-000000000001'::uuid, 'f6400000-0000-4000-8000-000000000001'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid, 'Timing Project', 'active');

insert into public.sessions (
  id, artist_id, client_id, project_id, appointment_type, start_at, end_at, status
) values
  ('f6600000-0000-4000-8000-000000000001'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid, 'f6400000-0000-4000-8000-000000000001'::uuid, 'f6500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-10 10:00:00+00', '2026-09-10 17:00:00+00', 'confirmed'),
  ('f6600000-0000-4000-8000-000000000002'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid, 'f6400000-0000-4000-8000-000000000001'::uuid, 'f6500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-20 10:00:00+00', '2026-09-20 17:00:00+00', 'confirmed');

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('f6700000-0000-4000-8000-000000000001'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid, 'Timing Rule', 'appointment.scheduled',
   'send_client_message', 'Timing Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true),
  ('f6700000-0000-4000-8000-000000000002'::uuid, 'f6300000-0000-4000-8000-000000000002'::uuid, 'Foreign Timing Rule', 'appointment.scheduled',
   'send_client_message', 'Foreign Timing Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true),
  ('f6700000-0000-4000-8000-000000000003'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid, 'Internal Notification Rule', 'appointment.scheduled',
   'notify_artist_team', 'Internal Notification Rule', 'normal',
   'event_occurred', 0, null, null, null, null, false);

insert into public.automation_events (
  id, activity_id, artist_id, event_type, entity_kind, entity_id,
  from_status, to_status, occurred_at
) values
  ('f6800000-0000-4000-8000-000000000001'::uuid, 'f6810000-0000-4000-8000-000000000001'::uuid,
   'f6300000-0000-4000-8000-000000000001'::uuid, 'appointment.scheduled', 'session',
   'f6600000-0000-4000-8000-000000000001'::uuid, null, 'confirmed', now()),
  ('f6800000-0000-4000-8000-000000000002'::uuid, 'f6810000-0000-4000-8000-000000000002'::uuid,
   'f6300000-0000-4000-8000-000000000001'::uuid, 'appointment.scheduled', 'session',
   'f6600000-0000-4000-8000-000000000002'::uuid, null, 'confirmed', now());

insert into public.automation_jobs (
  id, rule_id, rule_version, event_id, artist_id,
  action_type, action_title, action_priority,
  scheduled_at, status, attempt_count,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, session_id
) values
  ('f6900000-0000-4000-8000-000000000001'::uuid, 'f6700000-0000-4000-8000-000000000001'::uuid, 1, 'f6800000-0000-4000-8000-000000000001'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'Timing Rule', 'normal', '2026-09-09 10:00:00+00', 'pending', 0,
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'f6600000-0000-4000-8000-000000000001'::uuid),
  ('f6900000-0000-4000-8000-000000000002'::uuid, 'f6700000-0000-4000-8000-000000000001'::uuid, 1, 'f6800000-0000-4000-8000-000000000002'::uuid, 'f6300000-0000-4000-8000-000000000001'::uuid,
   'send_client_message', 'Timing Rule', 'normal', '2026-09-19 10:00:00+00', 'completed', 1,
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', 'f6600000-0000-4000-8000-000000000002'::uuid);

create function pg_temp.as_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated;

select ok(
  has_function_privilege('authenticated', 'public.update_client_lifecycle_rule_timing(uuid,text,integer,text)', 'EXECUTE'),
  'authenticated can execute lifecycle timing mutation'
);
select ok(
  not has_function_privilege('anon', 'public.update_client_lifecycle_rule_timing(uuid,text,integer,text)', 'EXECUTE'),
  'anon cannot execute lifecycle timing mutation'
);
select ok(
  not has_function_privilege('service_role', 'public.update_client_lifecycle_rule_timing(uuid,text,integer,text)', 'EXECUTE'),
  'service role cannot execute browser lifecycle timing mutation'
);
select is(
  (select prosecdef from pg_proc where oid='public.update_client_lifecycle_rule_timing(uuid,text,integer,text)'::regprocedure),
  true,
  'timing RPC is SECURITY DEFINER'
);
select is(
  (select proconfig[1] from pg_proc where oid='public.update_client_lifecycle_rule_timing(uuid,text,integer,text)'::regprocedure),
  'search_path=pg_catalog, public, crm_private',
  'timing RPC pins its search_path'
);

reset role;
select pg_temp.as_profile('f6100000-0000-4000-8000-000000000001'::uuid);
set local role authenticated;

select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000002'::uuid, 'before_session_start', 2, 'days')$$,
  '42501', null,
  'operator cannot change a foreign artist rule'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000003'::uuid, 'before_session_start', 2, 'days')$$,
  '22023', 'the client lifecycle rule is unavailable',
  'non-lifecycle automation cannot enter the timing editor'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'before_session_start', 0, 'days')$$,
  '22023', 'timing amount must be a positive whole number',
  'zero timing amount is rejected'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'before_session_start', 10, 'weeks')$$,
  '22023', 'timing unit must be minutes, hours or days',
  'unknown timing unit is rejected'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'before_session_start', 3, 'minutes')$$,
  '22023', 'lifecycle timing must align to five minutes',
  'minute timing must align to five minutes'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'before_session_start', 31, 'days')$$,
  '22023', 'lifecycle timing must be within 30 days of the appointment',
  'timing beyond 30 days is rejected'
);
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'during_session', 2, 'hours')$$,
  '22023', 'timing direction must be before session start or after session end',
  'unknown timing direction is rejected'
);

create temporary table timing_result as
select * from public.update_client_lifecycle_rule_timing(
  'f6700000-0000-4000-8000-000000000001'::uuid,
  'before_session_start', 2, 'days'
);
grant select on timing_result to authenticated;

select is((select schedule_anchor::text from timing_result), 'session_start', 'human direction maps to session start');
select is((select anchor_offset_minutes from timing_result), -2880, 'two days maps to canonical signed minutes');
select is((select rule_version from timing_result), 2, 'timing change creates a new rule version');
select is((select pending_jobs_rescheduled from timing_result), 1, 'the pending unsent job is rescheduled');
select is((select anchor_offset_minutes from public.automation_rules where id='f6700000-0000-4000-8000-000000000001'::uuid), -2880, 'only canonical rule timing changes');
select ok((select is_enabled from public.automation_rules where id='f6700000-0000-4000-8000-000000000001'::uuid), 'timing change preserves enabled state');
select is((select message_purpose from public.automation_rules where id='f6700000-0000-4000-8000-000000000001'::uuid), 'session_reminder_24h', 'timing change preserves message purpose');
select is((select rule_version from public.automation_jobs where id='f6900000-0000-4000-8000-000000000001'::uuid), 2, 'pending job moves to the new rule version');
select is((select scheduled_at from public.automation_jobs where id='f6900000-0000-4000-8000-000000000001'::uuid), '2026-09-08 10:00:00+00'::timestamptz, 'pending job time is recomputed from the authoritative session');
select is((select rule_version from public.automation_jobs where id='f6900000-0000-4000-8000-000000000002'::uuid), 1, 'completed history keeps its original rule version');
select is((select anchor_offset_minutes from public.automation_jobs where id='f6900000-0000-4000-8000-000000000002'::uuid), -1440, 'completed history keeps its original timing snapshot');
select is(
  (select count(*)::integer from public.activity_log where event_type='automation.rule_timing_updated' and artist_id='f6300000-0000-4000-8000-000000000001'::uuid),
  1,
  'timing mutation records one artist-scoped audit event'
);
select ok(
  (select metadata @> '{"before":{"anchor_offset_minutes":-1440,"version":1},"after":{"anchor_offset_minutes":-2880,"version":2},"pending_jobs_rescheduled":1}'::jsonb
   from public.activity_log
   where event_type='automation.rule_timing_updated'
     and artist_id='f6300000-0000-4000-8000-000000000001'::uuid
   order by created_at desc limit 1),
  'audit event carries bounded before/after timing state'
);

select is(
  (select rule_version from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'before_session_start', 2, 'days')),
  2,
  'saving identical timing is an idempotent no-op'
);
select is(
  (select count(*)::integer from public.activity_log where event_type='automation.rule_timing_updated' and artist_id='f6300000-0000-4000-8000-000000000001'::uuid),
  1,
  'idempotent no-op does not add a second audit event'
);
select is(
  (select count(*)::integer from public.email_messages where automation_job_id in ('f6900000-0000-4000-8000-000000000001'::uuid, 'f6900000-0000-4000-8000-000000000002'::uuid)),
  0,
  'timing mutation creates no email side effect'
);
select is(
  (select count(*)::integer from public.integration_outbox where email_message_id in (select id from public.email_messages where automation_job_id in ('f6900000-0000-4000-8000-000000000001'::uuid, 'f6900000-0000-4000-8000-000000000002'::uuid))),
  0,
  'timing mutation creates no provider outbox side effect'
);

reset role;
update crm_private.profile_access
set is_active=false
where profile_id='f6100000-0000-4000-8000-000000000001'::uuid;

set local role authenticated;
select throws_ok(
  $$select * from public.update_client_lifecycle_rule_timing('f6700000-0000-4000-8000-000000000001'::uuid, 'after_session_end', 1, 'days')$$,
  '42501', null,
  'inactive identity cannot mutate lifecycle timing'
);
reset role;

select * from finish();
rollback;
