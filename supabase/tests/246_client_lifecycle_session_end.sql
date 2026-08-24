-- 246_client_lifecycle_session_end.sql
--
-- Direct runtime coverage for the already-shipped `session_end` lifecycle anchor.
-- Everything is synthetic and rolled back. No provider API is called.
--
-- The +60 minute offset below is only a compact test fixture. It is NOT a
-- production timing decision for post-session messaging.

begin;
select no_plan();

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f9011111-1111-4111-8111-111111111111', 'session-end-admin@example.test'),
  ('f9022222-2222-4222-8222-222222222222', 'session-end-artist@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f9011111-1111-4111-8111-111111111111', 'session-end-admin@example.test',
   'Session End Admin', 'booking_manager', true),
  ('f9022222-2222-4222-8222-222222222222', 'session-end-artist@example.test',
   'Session End Artist', 'booking_manager', true);

-- Bootstrap organization authority through one already-seeded workspace, then
-- create a completely separate synthetic workspace and artist for this test.
insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select
  'f9011111-1111-4111-8111-111111111111',
  a.workspace_id,
  'owner', true, true, true, true
from public.artists a
where a.slug = 'vladimir';

create function pg_temp.as_admin() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"f9011111-1111-4111-8111-111111111111","role":"authenticated"}',
    true
  )::void;
$$;
create function pg_temp.as_artist() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"f9022222-2222-4222-8222-222222222222","role":"authenticated"}',
    true
  )::void;
$$;
create function pg_temp.as_backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.as_admin(), pg_temp.as_artist(), pg_temp.as_backend()
  to authenticated, service_role;

reset role;
select pg_temp.as_admin();
set local role authenticated;

create temporary table t_workspace as
select public.create_workspace('Session End Test Studio', 'studio') as id;
create temporary table t_artist as
select public.create_artist((select id from t_workspace), 'Session End Test Artist') as id;
grant select on t_workspace, t_artist to public;

select isnt(
  public.seat_artist_owner(
    'f9022222-2222-4222-8222-222222222222',
    (select id from t_artist)),
  null,
  'the synthetic artist is seated through the normal control plane'
);
reset role;

insert into public.clients (id, full_name, email) values
  ('f7011111-1111-4111-8111-111111111111',
   'Session End Client', 'session-end-client@example.test');

insert into public.projects (id, client_id, artist_id, title, description) values
  ('f6011111-1111-4111-8111-111111111111',
   'f7011111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Session-end tattoo project',
   'Rollback-only project for session-end lifecycle coverage');

-- The executor requires the ordinary Gmail route before it will materialize an
-- approved client email. This config remains inside the transaction and no
-- provider call is made by service_run_automation_tick.
select pg_temp.as_backend();
set local role service_role;
select lives_ok(
  $$select public.service_set_gmail_integration(
      (select id from t_artist),
      'google_gmail_session_end_test',
      'session-end-artist@example.test',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[]
    )$$,
  'the synthetic artist has the normal Gmail route required by lifecycle delivery'
);
reset role;

-- Author reviewed service copy and a disabled-by-default session_end rule through
-- the existing lifecycle control plane, then explicitly activate both.
select pg_temp.as_artist();
set local role authenticated;

create temporary table t_template as
select public.upsert_message_template(
  (select id from t_workspace),
  'post_session_checkin',
  'email'::public.message_template_channel,
  'Hi {{client_first_name}}, this is a lifecycle session-end test for your appointment with {{artist_display_name}}.',
  'en',
  'Session-end lifecycle test',
  (select id from t_artist)
) as id;
grant select on t_template to public;

select ok(
  public.set_message_template_active((select id from t_template), true),
  'reviewed post-session service copy is explicitly activated'
);

create temporary table t_rule as
select public.create_client_lifecycle_rule(
  (select id from t_artist),
  'Session-end runtime fixture',
  'tattoo_session'::public.appointment_type,
  'post_session_checkin',
  'session_end'::public.automation_schedule_anchor,
  60,
  'en'
) as id;
grant select on t_rule to public;

select ok(
  public.set_automation_rule_enabled((select id from t_rule), true),
  'the session-end rule is explicitly enabled for the synthetic artist'
);
reset role;

-- Schedule an already-finished time window through the ordinary appointment RPC.
-- schedule_appointment validates ordering and availability but deliberately does
-- not require the appointment to be in the future, which lets a rollback-only
-- test exercise a due session_end job without sleeping or faking database time.
select pg_temp.as_artist();
set local role authenticated;
create temporary table t_session as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'f7011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at - interval '8 hours' from t_clock),
    (select base_at - interval '2 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'f6011111-1111-4111-8111-111111111111',
    'Session-end runtime fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_session to public;
reset role;

-- First tick materializes a job that is already due by time, but the session is
-- still only confirmed. A post-session send must therefore remain pending.
select pg_temp.as_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

create temporary table t_job as
select j.id
from public.automation_jobs j
where j.rule_id = (select id from t_rule)
  and j.session_id = (select id from t_session);
grant select on t_job to public;

select is((select count(*)::int from t_job), 1,
  'one session-end rule and one appointment materialize exactly one job');
select is(
  (select j.scheduled_at from public.automation_jobs j where j.id = (select id from t_job)),
  (select s.end_at + interval '60 minutes' from public.sessions s where s.id = (select id from t_session)),
  'the job schedule is derived from authoritative session end_at');
select is(
  (select status::text from public.automation_jobs where id = (select id from t_job)),
  'pending',
  'a due session-end job stays pending while the appointment is only confirmed'
);
select is(
  (select count(*)::int from public.email_messages where automation_job_id = (select id from t_job)),
  0,
  'confirmed is not enough to create a post-session email'
);

-- Mark the same authoritative appointment completed through the normal product
-- RPC. The next heartbeat may now execute the already-due session_end job.
select pg_temp.as_artist();
set local role authenticated;
select lives_ok(
  $$select public.set_appointment_status(
      (select id from t_session),
      'completed'::public.session_status)$$,
  'the appointment is completed through its ordinary lifecycle RPC'
);
reset role;

select pg_temp.as_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select status::text from public.automation_jobs where id = (select id from t_job)),
  'completed',
  'the due session-end job completes only after the appointment is completed'
);
select is(
  (select count(*)::int from public.email_messages where automation_job_id = (select id from t_job)),
  1,
  'completion creates exactly one CRM email'
);
select ok(
  (select created_by_kind = 'system'
      and created_by is null
      and approved_by is null
      and approved_at is not null
      and status = 'approved'::public.email_message_status
      and template_key = 'post_session_checkin'
   from public.email_messages where automation_job_id = (select id from t_job)),
  'the session-end email uses the existing lifecycle system-approval provenance'
);
select ok(
  (select subject = 'Session-end lifecycle test'
      and body like 'Hi Session,%'
      and body like '%Session End Test Artist%'
      and body not like '%{{%'
   from public.email_messages where automation_job_id = (select id from t_job)),
  'the service template renders from the authoritative completed session'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.kind = 'approved_email'
     and o.dedupe_key = 'email:automation:' || (select id from t_job)::text),
  1,
  'the completed session reaches the existing approved-email Gmail outbox exactly once'
);

select pg_temp.as_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select count(*)::int from public.email_messages where automation_job_id = (select id from t_job)),
  1,
  'repeated heartbeats cannot duplicate the session-end email'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.dedupe_key = 'email:automation:' || (select id from t_job)::text),
  1,
  'repeated heartbeats cannot duplicate the Gmail outbox item'
);

-- A second due appointment proves terminal no-show state withdraws the pending
-- post-session job instead of sending anything.
select pg_temp.as_artist();
set local role authenticated;
create temporary table t_no_show_session as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'f7011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at - interval '16 hours' from t_clock),
    (select base_at - interval '10 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'f6011111-1111-4111-8111-111111111111',
    'Session-end no-show fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_no_show_session to public;
reset role;

select pg_temp.as_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

create temporary table t_no_show_job as
select j.id
from public.automation_jobs j
where j.rule_id = (select id from t_rule)
  and j.session_id = (select id from t_no_show_session);
grant select on t_no_show_job to public;

select is(
  (select status::text from public.automation_jobs where id = (select id from t_no_show_job)),
  'pending',
  'the due second job is pending before the terminal status is known'
);

select pg_temp.as_artist();
set local role authenticated;
select lives_ok(
  $$select public.set_appointment_status(
      (select id from t_no_show_session),
      'no_show'::public.session_status)$$,
  'the second appointment is marked no-show through the normal lifecycle RPC'
);
reset role;

select pg_temp.as_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select status::text from public.automation_jobs where id = (select id from t_no_show_job)),
  'cancelled',
  'a no-show withdraws the pending session-end job'
);
select is(
  (select count(*)::int from public.email_messages where automation_job_id = (select id from t_no_show_job)),
  0,
  'a no-show produces no post-session email'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.dedupe_key = 'email:automation:' || (select id from t_no_show_job)::text),
  0,
  'a no-show produces no Gmail outbox item'
);

select * from finish(true);
rollback;
