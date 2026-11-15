-- 392_lifecycle_stale_jobs_withdrawn.sql
--
-- Resilience: a pending client lifecycle job that is no longer current is
-- withdrawn by the scheduler tick instead of waiting indefinitely.
--   * a reminder is current only before the session starts;
--   * a post-session message is current for 48 hours after it was due,
--     measured from the last session of its consecutive block;
--   * a split block is still re-evaluated inside that window;
--   * an operator's retry (attempt_count >= 1) is left alone.
-- No provider is contacted: email rows are only queued in the outbox.

begin;
select no_plan();

create temporary table ra as select id from public.artists where slug = 'vladimir';
grant select on ra to public;

insert into public.clients (id, full_name, email) values
  ('fb011111-1111-4111-8111-111111111101', 'Stale Sleeper', 'stale-sleeper@example.test'),
  ('fb011111-1111-4111-8111-111111111102', 'Stale Split', 'stale-split@example.test'),
  ('fb011111-1111-4111-8111-111111111103', 'Stale Retro', 'stale-retro@example.test'),
  ('fb011111-1111-4111-8111-111111111104', 'Stale Ontime', 'stale-ontime@example.test'),
  ('fb011111-1111-4111-8111-111111111105', 'Stale Retry', 'stale-retry@example.test'),
  ('fb011111-1111-4111-8111-111111111106', 'Stale Series', 'stale-series@example.test');
insert into public.projects (id, client_id, artist_id, title)
select ('fb022222-2222-4222-8222-22222222210' || n)::uuid,
       ('fb011111-1111-4111-8111-11111111110' || n)::uuid, (select id from ra), 'Stale ' || n
from generate_series(1, 6) n;

-- Sessions are booked in the future, enrolled the ordinary way, and then
-- moved into the past the way time itself would move them.
create function pg_temp.book(p_id uuid, p_n int, p_day int) returns void language plpgsql as $$
begin
  insert into public.sessions (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at)
  values (p_id, (select id from ra),
          ('fb011111-1111-4111-8111-11111111110' || p_n)::uuid,
          ('fb022222-2222-4222-8222-22222222210' || p_n)::uuid,
          'tattoo_session', 'confirmed',
          date_trunc('day', now()) + make_interval(days => p_day, hours => 10),
          date_trunc('day', now()) + make_interval(days => p_day, hours => 14));
  if crm_private.enrol_booked_session_in_lifecycle(p_id, 'resilience_test') <> 'enrolled' then
    raise exception 'fixture session % was not enrolled', p_id;
  end if;
end $$;
create function pg_temp.happened(p_id uuid, p_ended_hours_ago int, p_status public.session_status) returns void
language sql as $$
  update public.sessions
  set status = p_status,
      start_at = date_trunc('hour', now()) - make_interval(hours => p_ended_hours_ago + 4),
      end_at = date_trunc('hour', now()) - make_interval(hours => p_ended_hours_ago)
  where id = p_id;
$$;
create function pg_temp.tick() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  perform * from public.service_run_automation_tick(500);
  reset role;
end $$;
create function pg_temp.sent(p_session uuid, p_purpose text) returns int language sql as $$
  select count(*)::int from public.email_messages m
  join public.automation_jobs j on j.id = m.automation_job_id
  where j.session_id = p_session and j.message_purpose = p_purpose;
$$;
create function pg_temp.job(p_session uuid, p_purpose text) returns text language sql as $$
  select j.status::text || coalesce('/' || j.last_error_category, '')
  from public.automation_jobs j
  where j.session_id = p_session and j.message_purpose = p_purpose;
$$;

select pg_temp.book('fb030000-0000-4000-8000-000000000101', 1, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000102', 1, 41);
select pg_temp.book('fb030000-0000-4000-8000-000000000201', 2, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000202', 2, 41);
select pg_temp.book('fb030000-0000-4000-8000-000000000301', 3, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000401', 4, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000501', 5, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000601', 6, 40);
select pg_temp.book('fb030000-0000-4000-8000-000000000602', 6, 41);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok($c$select public.service_set_gmail_integration((select id from ra), 'google_gmail_stale',
  'stale-artist@example.test',
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']::text[])$c$,
  'fixture: the artist has a sending mailbox');
reset role;
select lives_ok('select pg_temp.tick()', 'fixture: lifecycle jobs are materialised');
select is((select count(*)::int from public.automation_jobs
  where session_id::text like 'fb030000-0000-4000-8000-%' and status = 'pending'), 36,
  'fixture: four pending lifecycle jobs per session');

-- 1. The sleeper. A two-day block finished; the block's single check-in goes
--    out from the last day and the day-one job stays pending behind it.
select pg_temp.happened('fb030000-0000-4000-8000-000000000101', 49, 'completed');
select pg_temp.happened('fb030000-0000-4000-8000-000000000102', 25, 'completed');
select lives_ok('select pg_temp.tick()', 'sleeper: tick after the block completed');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000102', 'post_session_checkin'), 1,
  'sleeper: the block gets its one check-in, from the last completed day');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000101', 'post_session_checkin'), 'pending',
  'sleeper: the day-one check-in is kept while the series is still fresh');
-- Nineteen days pass.
select pg_temp.happened('fb030000-0000-4000-8000-000000000101', 480, 'completed');
select pg_temp.happened('fb030000-0000-4000-8000-000000000102', 456, 'completed');
select lives_ok('select pg_temp.tick()', 'sleeper: tick nineteen days later');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000101', 'post_session_checkin'),
  'cancelled/appointment_ineligible',
  'sleeper: the long-overdue day-one check-in is withdrawn instead of sleeping for good');
-- Only now the artist corrects day two to a no-show: the block splits.
select pg_temp.happened('fb030000-0000-4000-8000-000000000102', 456, 'no_show');
select lives_ok('select pg_temp.tick()', 'sleeper: tick after the late correction');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000101', 'post_session_checkin')
        + pg_temp.sent('fb030000-0000-4000-8000-000000000102', 'post_session_checkin'), 1,
  'sleeper: a correction weeks later does not send a second check-in');

-- 2. A split inside the window is still re-evaluated: day two is a no-show
--    while the day-one check-in is only a few hours overdue.
select pg_temp.happened('fb030000-0000-4000-8000-000000000201', 30, 'completed');
select pg_temp.happened('fb030000-0000-4000-8000-000000000202', 6, 'completed');
select lives_ok('select pg_temp.tick()', 'split: tick with both days completed');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000201', 'post_session_checkin'), 'pending',
  'split: the day-one check-in stays pending while it is still current');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000201', 'post_session_checkin')
        + pg_temp.sent('fb030000-0000-4000-8000-000000000202', 'post_session_checkin'), 0,
  'split: nothing is sent before the block check-in is due');
select pg_temp.happened('fb030000-0000-4000-8000-000000000202', 6, 'no_show');
select lives_ok('select pg_temp.tick()', 'split: tick after day two became a no-show');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000201', 'post_session_checkin'), 1,
  'split: the check-in follows the last session that actually happened');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000202', 'post_session_checkin'), 0,
  'split: the no-show day sends nothing');

-- 3. A session that stayed "confirmed" and is completed ten days later.
select pg_temp.happened('fb030000-0000-4000-8000-000000000301', 240, 'confirmed');
select lives_ok('select pg_temp.tick()', 'retro: tick with the session long past and never completed');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000301', 'session_reminder_24h'),
  'cancelled/appointment_ineligible', 'retro: a reminder is withdrawn once the session has started');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000301', 'session_reminder_72h'),
  'cancelled/appointment_ineligible', 'retro: the earlier reminder is withdrawn as well');
select pg_temp.happened('fb030000-0000-4000-8000-000000000301', 240, 'completed');
select lives_ok('select pg_temp.tick()', 'retro: tick after the retroactive completion');
select is((select count(*)::int from public.email_messages m
  join public.automation_jobs j on j.id = m.automation_job_id
  where j.session_id = 'fb030000-0000-4000-8000-000000000301'), 0,
  'retro: completing an old session sends nothing to the client');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000301', 'post_session_aftercare'),
  'cancelled/appointment_ineligible', 'retro: ten-day-old aftercare is withdrawn');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000301', 'post_session_checkin'),
  'cancelled/appointment_ineligible', 'retro: nine-day-old check-in is withdrawn');

-- 4. The ordinary path is untouched.
select pg_temp.happened('fb030000-0000-4000-8000-000000000401', 1, 'completed');
select lives_ok('select pg_temp.tick()', 'on time: tick an hour after the session');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000401', 'post_session_aftercare'), 1,
  'on time: aftercare is sent');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000401', 'post_session_checkin'), 'pending',
  'on time: the check-in waits for its hour');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000401', 'post_session_checkin'), 0,
  'on time: the check-in is not sent early');

-- 5. An operator's explicit retry of a failed job is their decision.
select pg_temp.happened('fb030000-0000-4000-8000-000000000501', 240, 'completed');
update public.automation_jobs
set attempt_count = 1
where session_id = 'fb030000-0000-4000-8000-000000000501'
  and message_purpose = 'post_session_aftercare';
select lives_ok('select pg_temp.tick()', 'retry: tick with a re-queued, already attempted job');
select isnt(pg_temp.job('fb030000-0000-4000-8000-000000000501', 'post_session_aftercare'),
  'cancelled/appointment_ineligible', 'retry: an attempted job is not withdrawn as stale');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000501', 'post_session_checkin'),
  'cancelled/appointment_ineligible', 'retry: its never-attempted sibling still is');

-- 6. A series is judged by its last session. Both days are entered as
--    completed at once; day one ended more than 48 hours ago, day two an hour
--    ago. The client was tattooed an hour ago, so the block's one aftercare
--    guide (carried by the first day's job) is still current.
select pg_temp.happened('fb030000-0000-4000-8000-000000000601', 49, 'completed');
select pg_temp.happened('fb030000-0000-4000-8000-000000000602', 1, 'completed');
select lives_ok('select pg_temp.tick()', 'series: tick an hour after the last day');
select is(pg_temp.sent('fb030000-0000-4000-8000-000000000601', 'post_session_aftercare')
        + pg_temp.sent('fb030000-0000-4000-8000-000000000602', 'post_session_aftercare'), 1,
  'series: the block still gets its one aftercare guide');
select is(pg_temp.job('fb030000-0000-4000-8000-000000000602', 'post_session_checkin'), 'pending',
  'series: the block check-in waits for its hour');

select * from finish(true);
rollback;
