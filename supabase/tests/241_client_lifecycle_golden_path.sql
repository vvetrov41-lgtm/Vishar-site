-- 241_client_lifecycle_golden_path.sql
--
-- A brand-new third artist, created through the ordinary platform control
-- plane, uses the same lifecycle engine and Gmail outbox as existing artists.
-- Everything is synthetic and rolled back; no external provider API is called.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Identities and helpers
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

-- Bootstrap organization authority through an existing delegated workspace.
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

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

-- ---------------------------------------------------------------------------
-- Create and seat an artist the lifecycle engine has never seen before
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
-- Provider route plus local client/project fixtures
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
  'the normal backend Gmail contract accepts the new artist'
);
reset role;

-- Direct fixture setup runs only as the pgTAP database owner. Product actors
-- continue to use bounded RPCs below.
insert into public.clients (id, full_name, email) values
  ('e7011111-1111-4111-8111-111111111111',
   'Lifecycle Client', 'lifecycle-client@example.test');

insert into public.projects (id, client_id, artist_id, title, description) values
  ('e6011111-1111-4111-8111-111111111111',
   'e7011111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Lifecycle tattoo project',
   'Synthetic project required by the tattoo-session domain invariant');

-- ---------------------------------------------------------------------------
-- Artist authors reviewed copy and explicitly enables a typed reminder rule
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
-- Schedule a real project-linked tattoo session 48 hours away
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
    null,
    'e6011111-1111-4111-8111-111111111111',
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
  'the normal appointment activity becomes exactly one automation event'
);

-- ---------------------------------------------------------------------------
-- First tick materializes a future reminder job
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

select is((select count(*)::int from t_job), 1,
  'one lifecycle rule and one session materialize one job');
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
-- Reschedule the domain appointment. The test never edits automation_jobs.
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
  'the existing pending job follows the new appointment start'
);

-- ---------------------------------------------------------------------------
-- Move the real session inside the reminder window and execute it
-- ---------------------------------------------------------------------------

select pg_temp.lifecycle_artist();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_session),
      (select base_at + interval '23 hours' from t_clock),
      (select base_at + interval '25 hours' from t_clock))$$,
  'the appointment itself is moved inside the reminder window'
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
  'automation records system approval provenance without a fake human approver'
);
select ok(
  (select subject = 'Your tattoo session tomorrow'
      and body like 'Hi Lifecycle,%'
      and body like '%Lifecycle Third Artist%'
      and body not like '%{{%'
   from public.email_messages
   where automation_job_id = (select id from t_job)),
  'reviewed template variables render from the live third-artist session'
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

-- A repeated scheduler tick must remain idempotent.
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
  'a repeated tick cannot duplicate the Gmail outbox item'
);

-- ---------------------------------------------------------------------------
-- Cancellation is also derived from the authoritative appointment row
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
    null,
    'e6011111-1111-4111-8111-111111111111',
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
-- No artist-specific special case exists in the lifecycle path
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