-- 241_client_lifecycle_golden_path.sql
--
-- A brand-new third artist, created through the platform control plane, uses
-- the same lifecycle engine and Gmail outbox as every existing artist.
--
-- The key regression is rescheduling: this test never edits automation_jobs.
-- It changes the real sessions.start_at through reschedule_appointment, runs the
-- scheduler again, and proves the already-existing job follows that domain row.
-- Everything is synthetic and rolled back; no Google API is called.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. Two fresh CRM identities. Identity provisioning itself remains a
-- trusted service boundary, exactly as in the platform golden-path test 236.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e9011111-1111-4111-8111-111111111111', 'lifecycle-admin@example.test'),
  ('e9022222-2222-4222-8222-222222222222', 'lifecycle-artist@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9011111-1111-4111-8111-111111111111', 'lifecycle-admin@example.test',
   'Lifecycle Studio Admin', 'booking_manager', true),
  ('e9022222-2222-4222-8222-222222222222', 'lifecycle-artist@example.test',
   'Lifecycle Third Artist', 'booking_manager', true);

-- One delegated organization seat lets the admin use the ordinary workspace
-- creation flow. This is bootstrap authority, not artist-specific runtime code.
insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select
  'e9011111-1111-4111-8111-111111111111',
  a.workspace_id,
  'owner', true, true, true, true
from public.artists a
where a.slug = 'vladimir';

create function pg_temp.lifecycle_admin() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"e9011111-1111-4111-8111-111111111111","role":"authenticated"}',
    true
  )::void;
$$;
create function pg_temp.lifecycle_artist() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"e9022222-2222-4222-8222-222222222222","role":"authenticated"}',
    true
  )::void;
$$;
create function pg_temp.lifecycle_backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.lifecycle_admin(), pg_temp.lifecycle_artist(),
  pg_temp.lifecycle_backend() to authenticated, service_role;

-- Fixed to the current hour, so every appointment lands on a five-minute
-- boundary regardless of when CI starts.
create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

-- ---------------------------------------------------------------------------
-- Act 1. Create and seat an artist the lifecycle engine has never seen before
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.lifecycle_admin();
set local role authenticated;

create temporary table t_workspace as
select public.create_workspace('Lifecycle Golden Studio', 'studio') as id;
create temporary table t_artist as
select public.create_artist((select id from t_workspace), 'Lifecycle Third Artist') as id;
grant select on t_workspace, t_artist to public;

select isnt((select id from t_artist), null,
  'a third artist is created through the ordinary control plane');
select isnt(
  public.seat_artist_owner(
    'e9022222-2222-4222-8222-222222222222',
    (select id from t_artist)),
  null,
  'the third artist is seated on their own book'
);
reset role;

-- ---------------------------------------------------------------------------
-- Act 2. Provider route and client fixture. Credential custody remains outside
-- Postgres; only verified safe Gmail routing metadata is created here.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_backend();
set local role service_role;

select lives_ok(
  $$select public.service_set_gmail_integration(
      (select id from t_artist),
      'google_gmail_lifecycle_third',
      'lifecycle-third@example.test',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[]
    )$$,
  'the same backend Gmail contract can bind a previously unknown artist'
);
reset role;

-- Direct fixture setup runs as the test owner. service_role itself remains
-- unable to write the client table, which the global ACL suite already pins.
insert into public.clients (id, full_name, email) values
  ('e7011111-1111-4111-8111-111111111111',
   'Lifecycle Client', 'lifecycle-client@example.test');

-- ---------------------------------------------------------------------------
-- Act 3. The artist authors reviewed copy and a disabled typed rule, then
-- explicitly activates both. No SQL table write is needed by the artist.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_artist();
set local role authenticated;

create temporary table t_template as
select public.upsert_message_template(
  (select id from t_workspace),
  'session_reminder_24h',
  'email'::public.message_template_channel,
  'Hi {{client_first_name}}, your session with {{artist_display_name}} is on {{appointment_date}} at {{appointment_time}}.',
  'en',
  'Your tattoo session tomorrow',
  (select id from t_artist)
) as id;
grant select on t_template to public;

select ok(
  public.set_message_template_active((select id from t_template), true),
  'the artist explicitly activates reviewed reminder copy'
);

create temporary table t_rule as
select public.create_client_lifecycle_rule(
  (select id from t_artist),
  '24 hour tattoo reminder',
  'tattoo_session'::public.appointment_type,
  'session_reminder_24h',
  'session_start'::public.automation_schedule_anchor,
  -1440,
  'en'
) as id;
grant select on t_rule to public;

select ok(
  public.set_automation_rule_enabled((select id from t_rule), true),
  'the artist explicitly enables the reviewed lifecycle rule'
);

-- ---------------------------------------------------------------------------
-- Act 4. Schedule a confirmed tattoo session 48 hours away. The ordinary
-- appointment RPC produces the domain event; lifecycle code is not called.
-- ---------------------------------------------------------------------------

create temporary table t_session as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'e7011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '48 hours' from t_clock),
    (select base_at + interval '50 hours' from t_clock),
    'confirmed'::public.session_status,
    null, null,
    'Lifecycle golden-path appointment'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_session to public;
reset role;

select is(
  (select count(*)::int
   from public.automation_events e
   where e.artist_id = (select id from t_artist)
     and e.event_type = 'appointment.scheduled'
     and e.entity_id = (select id from t_session)),
  1,
  'the normal appointment activity becomes exactly one session automation event'
);

-- ---------------------------------------------------------------------------
-- Act 5. First backend tick materializes a future reminder job.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

create temporary table t_job as
select j.id
from public.automation_jobs j
where j.rule_id = (select id from t_rule)
  and j.session_id = (select id from t_session);
grant select on t_job to public;

select is(
  (select count(*)::int from t_job),
  1,
  'one lifecycle rule and one session materialize one job'
);
select is(
  (select j.scheduled_at from public.automation_jobs j
   where j.id = (select id from t_job)),
  (select s.start_at - interval '24 hours'
   from public.sessions s where s.id = (select id from t_session)),
  'the reminder schedule is derived from the authoritative appointment start'
);
select is(
  (select status::text from public.automation_jobs where id = (select id from t_job)),
  'pending',
  'the future reminder remains pending'
);

-- ---------------------------------------------------------------------------
-- Act 6. Reschedule the real appointment to 72 hours away. The test does not
-- touch automation_jobs. A tick must move the same job to start_at - 24h.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_artist();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_session),
      (select base_at + interval '72 hours' from t_clock),
      (select base_at + interval '74 hours' from t_clock))$$,
  'the artist reschedules through the ordinary appointment RPC'
);
reset role;

select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select count(*)::int from public.automation_jobs
   where rule_id = (select id from t_rule)
     and session_id = (select id from t_session)),
  1,
  'rescheduling does not create a second lifecycle job'
);
select is(
  (select id from public.automation_jobs
   where rule_id = (select id from t_rule)
     and session_id = (select id from t_session)),
  (select id from t_job),
  'the original job identity survives the reschedule'
);
select is(
  (select j.scheduled_at from public.automation_jobs j
   where j.id = (select id from t_job)),
  (select s.start_at - interval '24 hours'
   from public.sessions s where s.id = (select id from t_session)),
  'the existing pending job follows the new real appointment start'
);

-- ---------------------------------------------------------------------------
-- Act 7. Move the actual session to 23 hours away. Its reminder is now due.
-- The scheduler re-reads session status, template, suppression and Gmail route
-- before creating an approved system email and the existing Gmail outbox item.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_artist();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_session),
      (select base_at + interval '23 hours' from t_clock),
      (select base_at + interval '25 hours' from t_clock))$$,
  'the appointment itself, not the automation job, is moved inside the reminder window'
);
reset role;

select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select status::text from public.automation_jobs where id = (select id from t_job)),
  'completed',
  'the due confirmed lifecycle job completes'
);
select is(
  (select count(*)::int from public.email_messages
   where automation_job_id = (select id from t_job)),
  1,
  'the lifecycle job creates exactly one CRM email'
);
select ok(
  (select created_by_kind = 'system'
      and created_by is null
      and approved_by is null
      and approved_at is not null
      and status = 'approved'::public.email_message_status
   from public.email_messages
   where automation_job_id = (select id from t_job)),
  'automation has explicit system approval provenance and fabricates no human approver'
);
select ok(
  (select subject = 'Your tattoo session tomorrow'
      and body like 'Hi Lifecycle,%'
      and body like '%Lifecycle Third Artist%'
      and body not like '%{{%'
   from public.email_messages
   where automation_job_id = (select id from t_job)),
  'reviewed template variables are rendered from the live third-artist session'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.kind = 'approved_email'
     and (o.payload ->> 'email_message_id')::uuid = (
       select id from public.email_messages
       where automation_job_id = (select id from t_job))),
  1,
  'the existing approved-email outbox receives exactly one delivery item'
);

-- Running the scheduler again is deliberately boring.
select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select count(*)::int from public.email_messages
   where automation_job_id = (select id from t_job)),
  1,
  'a repeated tick cannot duplicate the email'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.kind = 'approved_email'
     and o.dedupe_key = 'email:automation:' || (select id from t_job)::text),
  1,
  'and cannot duplicate the Gmail outbox item'
);

-- ---------------------------------------------------------------------------
-- Act 8. Cancellation is also read from the authoritative appointment row.
-- A second appointment materializes a job, then cancellation kills it before
-- any client email can be created.
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_artist();
set local role authenticated;
create temporary table t_cancel_session as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'e7011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '96 hours' from t_clock),
    (select base_at + interval '98 hours' from t_clock),
    'confirmed'::public.session_status,
    null, null,
    'Lifecycle cancellation fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_cancel_session to public;
reset role;

select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

create temporary table t_cancel_job as
select j.id
from public.automation_jobs j
where j.rule_id = (select id from t_rule)
  and j.session_id = (select id from t_cancel_session);
grant select on t_cancel_job to public;

select is((select count(*)::int from t_cancel_job), 1,
  'the second session also materializes exactly one lifecycle job');

select pg_temp.lifecycle_artist();
set local role authenticated;
select lives_ok(
  $$select public.set_appointment_status(
      (select id from t_cancel_session),
      'cancelled'::public.session_status)$$,
  'the artist cancels the actual appointment through its normal RPC'
);
reset role;

select pg_temp.lifecycle_backend();
set local role service_role;
select * from public.service_run_automation_tick(100);
reset role;

select is(
  (select status::text from public.automation_jobs
   where id = (select id from t_cancel_job)),
  'cancelled',
  'cancelling the appointment cancels the pending lifecycle job'
);
select is(
  (select count(*)::int from public.email_messages
   where automation_job_id = (select id from t_cancel_job)),
  0,
  'a cancelled appointment produces no lifecycle email'
);

-- ---------------------------------------------------------------------------
-- Act 9. The whole path is data-driven, not Vladimir/Kristina-driven.
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','crm_private')
     and p.proname in (
       'create_client_lifecycle_rule',
       'list_client_lifecycle_rules',
       'upsert_workspace_client_lifecycle_default',
       'list_workspace_client_lifecycle_defaults',
       'resolve_automation_scheduled_at',
       'render_lifecycle_template_text',
       'execute_client_lifecycle_job',
       'service_run_automation_tick')
     and p.prosrc ~* '(vladimir|kristina)'),
  0,
  'no lifecycle control or runtime function names a pre-existing artist'
);

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','crm_private')
     and p.proname in (
       'create_client_lifecycle_rule',
       'upsert_workspace_client_lifecycle_default',
       'resolve_automation_scheduled_at',
       'render_lifecycle_template_text',
       'execute_client_lifecycle_job')
     and p.prosrc ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  0,
  'the lifecycle path carries no hard-coded artist UUID'
);

select * from finish(true);
rollback;