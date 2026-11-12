-- Synthetic, rollback-only coverage of the automatic retry of client lifecycle
-- jobs that failed because the sending integration was unavailable.
begin;
select no_plan();

insert into public.workspaces (id, slug, display_name, workspace_type, is_active)
values ('c8200000-0000-4000-8000-000000000001'::uuid, 'auto-retry-home', 'Auto Retry Home', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, timezone, default_currency, is_active)
values ('c8300000-0000-4000-8000-000000000001'::uuid, 'c8200000-0000-4000-8000-000000000001'::uuid,
        'auto-retry-artist', 'Auto Retry Artist', 'Europe/London', 'GBP', true);

insert into public.clients (id, full_name, email)
values ('c8400000-0000-4000-8000-000000000001'::uuid, 'Auto Retry Client', 'auto-retry-client@example.test');

insert into public.projects (id, client_id, artist_id, title, status)
values ('c8500000-0000-4000-8000-000000000001'::uuid, 'c8400000-0000-4000-8000-000000000001'::uuid,
        'c8300000-0000-4000-8000-000000000001'::uuid, 'Auto Retry Project', 'active');

-- Sessions are created before the rules, so nothing enrols them implicitly.
-- 01 starts in 20h           05 starts in 14h (email row exists)
-- 02 started an hour ago     06 starts in 12h (72h and 24h both due)
-- 03 starts in 18h           07 starts in 2 days (only 72h due)
-- 04 starts in 16h           08 ended 30h ago, 09 ended 60h ago (completed)
-- 10 starts in 10h (rule changed since the job was created)
insert into public.sessions (
  id, artist_id, client_id, project_id, appointment_type, start_at, end_at, status
)
select
  ('c8600000-0000-4000-8000-0000000000' || lpad(x.n::text, 2, '0'))::uuid,
  'c8300000-0000-4000-8000-000000000001'::uuid,
  'c8400000-0000-4000-8000-000000000001'::uuid,
  'c8500000-0000-4000-8000-000000000001'::uuid,
  'tattoo_session',
  date_trunc('hour', now()) + x.start_offset,
  date_trunc('hour', now()) + x.start_offset + interval '1 hour',
  'confirmed'
from (values
  (1,  interval '20 hours'),
  (2,  interval '-1 hour'),
  (3,  interval '18 hours'),
  (4,  interval '16 hours'),
  (5,  interval '14 hours'),
  (6,  interval '12 hours'),
  (7,  interval '2 days'),
  (8,  interval '-31 hours'),
  (9,  interval '-61 hours'),
  (10, interval '10 hours')
) as x(n, start_offset);

update public.sessions set status = 'completed'
where id in ('c8600000-0000-4000-8000-000000000008'::uuid,
             'c8600000-0000-4000-8000-000000000009'::uuid);

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('c8700000-0000-4000-8000-000000000001'::uuid, 'c8300000-0000-4000-8000-000000000001'::uuid,
   'Auto retry 24h', 'appointment.scheduled', 'send_client_message', 'Auto retry 24h', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', true),
  ('c8700000-0000-4000-8000-000000000002'::uuid, 'c8300000-0000-4000-8000-000000000001'::uuid,
   'Auto retry 72h', 'appointment.scheduled', 'send_client_message', 'Auto retry 72h', 'normal',
   'session_start', -4320, 'tattoo_session', 'session_reminder_72h', 'email', 'en', true),
  ('c8700000-0000-4000-8000-000000000003'::uuid, 'c8300000-0000-4000-8000-000000000001'::uuid,
   'Auto retry check-in', 'appointment.scheduled', 'send_client_message', 'Auto retry check-in', 'normal',
   'session_end', 1440, 'tattoo_session', 'post_session_checkin', 'email', 'en', true);

insert into public.automation_events (
  id, activity_id, artist_id, event_type, entity_kind, entity_id, occurred_at
)
select
  ('c8800000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('c8810000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'c8300000-0000-4000-8000-000000000001'::uuid,
  'appointment.scheduled', 'session',
  ('c8600000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  now()
from generate_series(1, 10) as n;

-- job, session, rule (1 = 24h, 2 = 72h, 3 = check-in), status, attempts,
-- error category, age of the last attempt, rule version stored on the job.
create temporary table job_378 (
  n integer, session_n integer, rule_n integer, status text,
  attempts integer, error text, age interval, rule_version integer
);
insert into job_378 values
  (1,  1,  1, 'failed',  2, 'integration_unavailable', interval '1 hour',     1),
  (2,  2,  1, 'failed',  1, 'integration_unavailable', interval '2 hours',    1),
  (3,  3,  1, 'failed',  1, 'integration_unavailable', interval '10 minutes', 1),
  (4,  4,  1, 'failed',  1, 'destination_unavailable', interval '1 hour',     1),
  (5,  5,  1, 'failed',  1, 'integration_unavailable', interval '1 hour',     1),
  (6,  6,  2, 'failed',  1, 'integration_unavailable', interval '2 days',     1),
  (7,  6,  1, 'pending', 0, null,                      interval '2 days',     1),
  (8,  7,  2, 'failed',  1, 'integration_unavailable', interval '1 hour',     1),
  (9,  7,  1, 'pending', 0, null,                      interval '1 hour',     1),
  (10, 8,  3, 'failed',  1, 'integration_unavailable', interval '1 hour',     1),
  (11, 9,  3, 'failed',  1, 'integration_unavailable', interval '1 hour',     1),
  (12, 10, 1, 'failed',  1, 'integration_unavailable', interval '1 hour',     0);

insert into public.automation_jobs (
  id, rule_id, rule_version, event_id, artist_id,
  action_type, action_title, action_priority,
  scheduled_at, status, attempt_count, last_error_category,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, session_id,
  updated_at
)
select
  ('c8900000-0000-4000-8000-0000000000' || lpad(j.n::text, 2, '0'))::uuid,
  r.id, j.rule_version,
  ('c8800000-0000-4000-8000-0000000000' || lpad(j.session_n::text, 2, '0'))::uuid,
  r.artist_id,
  'send_client_message', r.action_title, 'normal',
  case r.schedule_anchor
    when 'session_start'::public.automation_schedule_anchor then s.start_at
    else s.end_at
  end + make_interval(mins => r.anchor_offset_minutes),
  j.status::public.automation_job_status, j.attempts, j.error,
  r.schedule_anchor, r.anchor_offset_minutes, r.condition_appointment_type,
  r.message_purpose, r.message_channel, r.message_locale, s.id,
  now() - j.age
from job_378 j
join public.automation_rules r
  on r.id = ('c8700000-0000-4000-8000-00000000000' || j.rule_n::text)::uuid
join public.sessions s
  on s.id = ('c8600000-0000-4000-8000-0000000000' || lpad(j.session_n::text, 2, '0'))::uuid;

-- Something was already materialised for job 5: a replay could duplicate it.
insert into public.email_messages (
  id, artist_id, automation_job_id, client_id, project_id,
  to_email, subject, body, created_by_kind, status, approved_at
) values (
  'c8a00000-0000-4000-8000-000000000001'::uuid,
  'c8300000-0000-4000-8000-000000000001'::uuid,
  'c8900000-0000-4000-8000-000000000005'::uuid,
  'c8400000-0000-4000-8000-000000000001'::uuid,
  'c8500000-0000-4000-8000-000000000001'::uuid,
  'auto-retry-client@example.test', 'Subject', 'Body',
  'system', 'approved', now()
);

create function pg_temp.job_state(p_n integer) returns text language sql as $$
  select j.status::text || '/' || coalesce(j.last_error_category, '-') || '/' || j.attempt_count::text
  from public.automation_jobs j
  where j.id = ('c8900000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'))::uuid;
$$;

select ok(
  not has_function_privilege('anon', 'crm_private.requeue_recoverable_lifecycle_jobs(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.requeue_recoverable_lifecycle_jobs(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.requeue_recoverable_lifecycle_jobs(integer)', 'EXECUTE'),
  'no API role can call the requeue helper directly'
);
select ok(
  (select prosecdef and 'search_path=pg_catalog, public, crm_private' = any(proconfig)
   from pg_proc where oid = 'crm_private.requeue_recoverable_lifecycle_jobs(integer)'::regprocedure),
  'requeue helper is SECURITY DEFINER with a pinned search path'
);
select ok(
  position('crm_private.requeue_recoverable_lifecycle_jobs(p_limit)'
           in pg_get_functiondef('public.service_run_automation_tick(integer)'::regprocedure)) > 0
  and position('crm_private.requeue_recoverable_lifecycle_jobs(p_limit)'
               in pg_get_functiondef('public.service_run_automation_tick(integer)'::regprocedure))
      < position('Reconcile every still-pending lifecycle job'
                 in pg_get_functiondef('public.service_run_automation_tick(integer)'::regprocedure)),
  'the scheduler requeues recoverable jobs before it reconciles and executes'
);
select ok(
  has_function_privilege('service_role', 'public.service_run_automation_tick(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_run_automation_tick(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_run_automation_tick(integer)', 'EXECUTE'),
  'scheduler tick stays backend-only'
);

create temporary table requeued_378 as
select crm_private.requeue_recoverable_lifecycle_jobs(500) as n;

select cmp_ok((select n from requeued_378), '>=', 3,
  'the helper reports the jobs it returned to pending');

select is(pg_temp.job_state(1), 'pending/-/2',
  'a reminder for an appointment that is still ahead is retried and keeps its attempt history');
select is(pg_temp.job_state(2), 'failed/integration_unavailable/1',
  'a reminder is not retried once the appointment has started');
select is(pg_temp.job_state(3), 'failed/integration_unavailable/1',
  'a job that failed less than 30 minutes ago waits for the next window');
select is(pg_temp.job_state(4), 'failed/destination_unavailable/1',
  'a failure that reconnecting cannot fix is left to the operator');
select is(pg_temp.job_state(5), 'failed/integration_unavailable/1',
  'a job with a materialised email is never replayed');
select is(pg_temp.job_state(6), 'failed/integration_unavailable/1',
  'a 72-hour reminder is not retried once the 24-hour reminder is due');
select is(pg_temp.job_state(7), 'pending/-/0',
  'the due 24-hour reminder itself is untouched');
select is(pg_temp.job_state(8), 'pending/-/1',
  'a 72-hour reminder is retried while the 24-hour reminder is not yet due');
select is(pg_temp.job_state(10), 'pending/-/1',
  'a post-session message less than 24 hours late is retried');
select is(pg_temp.job_state(11), 'failed/integration_unavailable/1',
  'a post-session message more than 24 hours late is not sent late');
select is(pg_temp.job_state(12), 'failed/integration_unavailable/1',
  'a job created for another version of the rule is not retried');

select is(crm_private.requeue_recoverable_lifecycle_jobs(500), 0,
  'a second pass in the same window requeues nothing');

select * from finish();
rollback;
