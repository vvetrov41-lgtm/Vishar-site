-- 242_lifecycle_v1_production_activation.sql
--
-- 0097 is configuration, not machinery, so this test asserts the configuration
-- itself and then the behaviour that configuration is supposed to produce.
--
-- 241 already proves the engine works for a rule an artist writes by hand. What
-- is unproven until here is the shipped v1 ruleset: that a tattoo session gets
-- a 72-hour reminder AND a 24-hour check-in, that a consultation gets the
-- 24-hour check-in and NOT the 72-hour tattoo reminder, and that the templates
-- 0097 activates actually render from a live session instead of failing closed.
--
-- Everything below is synthetic and rolled back. No provider API is called.

begin;
select no_plan();

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- An installation owner, seated the ordinary way, drives every product RPC in
-- this test. Nothing below writes an automation row by hand.
insert into auth.users (id, email) values
  ('e8000000-0000-4000-8000-000000000001', 'activation-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e8000000-0000-4000-8000-000000000001', 'activation-owner@example.test',
   'Activation Owner', 'owner', true);

create function pg_temp.as_owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated"}',
    true)::void;
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

create temporary table t_artist as
select a.id, a.workspace_id
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';
grant select on t_artist to public;

-- ---------------------------------------------------------------------------
-- 1. The shipped configuration is what 0097 says it is
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from public.automation_rules r
   join crm_private.artist_state s on s.artist_id = r.artist_id and s.is_active
   where r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and r.message_purpose in (
       'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
     )),
  (select count(*)::int
   from public.artists a
   join crm_private.artist_state s on s.artist_id = a.id and s.is_active) * 4,
  'every active artist carries exactly the four enabled v1 lifecycle rules'
);

select set_eq(
  $$select r.condition_appointment_type::text,
           r.message_purpose,
           r.anchor_offset_minutes
    from public.automation_rules r
    where r.artist_id = (select id from t_artist)
      and r.action_type = 'send_client_message'::public.automation_action_type
      and r.is_enabled
      and r.message_purpose in (
        'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
      )$$,
  $$values
      ('tattoo_session',          'session_reminder_72h',  -4320),
      ('tattoo_session',          'session_reminder_24h',  -1440),
      ('in_person_consultation',  'consultation_reminder', -1440),
      ('video_consultation',      'consultation_reminder', -1440)$$,
  'v1 ships 72h + 24h for tattoo sessions and 24h only for both consultation types'
);

select is(
  (select count(*)::int
   from public.automation_rules r
   where r.artist_id = (select id from t_artist)
     and r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and r.condition_appointment_type <> 'tattoo_session'::public.appointment_type
     and r.anchor_offset_minutes = -4320),
  0,
  'no consultation carries a 72 hour reminder'
);

select is(
  (select count(*)::int
   from public.automation_rules r
   where r.artist_id = (select id from t_artist)
     and r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and r.message_purpose in (
       'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
     )
     and r.condition_appointment_type = 'touch_up'::public.appointment_type),
  0,
  'touch_up is deliberately unconfigured in the v1 pre-session stage'
);

select ok(
  (select bool_and(
     r.schedule_anchor = 'session_start'::public.automation_schedule_anchor
     and r.message_channel = 'email'::public.message_template_channel
     and r.trigger_event_type = 'appointment.scheduled'
     and r.message_locale = 'en')
   from public.automation_rules r
   where r.artist_id = (select id from t_artist)
     and r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and r.message_purpose in (
       'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
     )),
  'every v1 rule is a session-start, email, appointment.scheduled rule'
);

-- Service, never marketing. A marketing classification would route the send
-- through marketing consent rather than the service gate.
select is(
  (select count(*)::int
   from public.automation_rules r
   join public.message_template_purposes p on p.purpose = r.message_purpose
   where r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and p.classification <> 'service'::public.message_classification),
  0,
  'no enabled v1 rule uses a marketing purpose'
);

-- Every enabled rule can actually resolve a template. Without this an enabled
-- rule fails every job closed with template_unavailable.
select is(
  (select count(*)::int
   from public.automation_rules r
   join public.artists a on a.id = r.artist_id
   join crm_private.artist_state s on s.artist_id = r.artist_id and s.is_active
   where r.action_type = 'send_client_message'::public.automation_action_type
     and r.is_enabled
     and not exists (
       select 1 from public.message_templates m
       where m.workspace_id = a.workspace_id
         and (m.artist_id = r.artist_id or m.artist_id is null)
         and m.purpose = r.message_purpose
         and m.channel = r.message_channel
         and m.locale = r.message_locale
         and m.status = 'active'::public.message_template_status)),
  0,
  'every enabled v1 rule resolves an active template'
);

-- The renderer fails closed on any variable it cannot always resolve, so a
-- template naming one would make every send fail. Assert absence directly.
select is(
  (select count(*)::int
   from public.message_templates m
   where m.workspace_id = (select workspace_id from t_artist)
     and m.status = 'active'::public.message_template_status
     and m.purpose in ('session_reminder_72h', 'session_reminder_24h', 'consultation_reminder')
     and (coalesce(m.body, '') || coalesce(m.subject, ''))
         ~ '\{\{(booking_link|deposit_amount|enquiry_reference)\}\}'),
  0,
  'no shipped template names a variable the renderer cannot always resolve'
);

-- ---------------------------------------------------------------------------
-- 2. Fixtures: one client, one project, on the real seeded artist
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('e8011111-1111-4111-8111-111111111111',
   'Activation Client', 'activation-client@example.test');

insert into public.projects (id, client_id, artist_id, title, description) values
  ('e8022222-2222-4222-8222-222222222222',
   'e8011111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Activation tattoo project',
   'Synthetic project required by the tattoo-session domain invariant');

create function pg_temp.backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.backend() to authenticated, service_role;

create function pg_temp.tick() returns void language plpgsql as $$
begin
  perform * from public.service_run_automation_tick(200);
end;
$$;
grant execute on function pg_temp.tick() to service_role;

-- The renderer needs an email route on the artist for the send gate.
select pg_temp.backend();
set local role service_role;
select lives_ok(
  $$select public.service_set_gmail_integration(
      (select id from t_artist),
      'google_gmail_activation',
      'activation-artist@example.test',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[])$$,
  'the artist has the enabled Gmail route the send gate requires'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. A tattoo session materialises BOTH reminders
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_tattoo as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'e8011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '10 days' from t_clock),
    (select base_at + interval '10 days 6 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'e8022222-2222-4222-8222-222222222222',
    'Activation tattoo appointment'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_tattoo to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select set_eq(
  $$select j.message_purpose, j.anchor_offset_minutes
    from public.automation_jobs j
    where j.session_id = (select id from t_tattoo)
      and j.message_purpose in (
        'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
      )$$,
  $$values ('session_reminder_72h', -4320), ('session_reminder_24h', -1440)$$,
  'a tattoo session materialises exactly the 72 hour and 24 hour reminders'
);

select is(
  (select count(*)::int from public.automation_jobs j
   where j.session_id = (select id from t_tattoo)
     and j.message_purpose = 'consultation_reminder'),
  0,
  'a tattoo session does not materialise the consultation reminder'
);

select ok(
  (select bool_and(
     j.scheduled_at = s.start_at + make_interval(mins => j.anchor_offset_minutes)
     and j.status = 'pending'::public.automation_job_status)
   from public.automation_jobs j
   join public.sessions s on s.id = j.session_id
   where j.session_id = (select id from t_tattoo)
     and j.message_purpose in (
       'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
     )),
  'both reminders are anchored to the authoritative appointment start'
);

-- ---------------------------------------------------------------------------
-- 4. A consultation materialises the 24 hour check-in and no 72 hour reminder
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_consult as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'e8011111-1111-4111-8111-111111111111',
    'in_person_consultation'::public.appointment_type,
    (select base_at + interval '12 days' from t_clock),
    (select base_at + interval '12 days' + interval '30 minutes' from t_clock),
    'confirmed'::public.session_status,
    null,
    null,
    'Activation consultation appointment'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_consult to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select set_eq(
  $$select j.message_purpose, j.anchor_offset_minutes
    from public.automation_jobs j
    where j.session_id = (select id from t_consult)$$,
  $$values ('consultation_reminder', -1440)$$,
  'a consultation materialises only the 24 hour check-in'
);

select is(
  (select count(*)::int from public.automation_jobs j
   where j.session_id = (select id from t_consult)
     and (j.anchor_offset_minutes = -4320
          or j.message_purpose in ('session_reminder_72h', 'session_reminder_24h'))),
  0,
  'a consultation never materialises a 72 hour tattoo reminder'
);

-- ---------------------------------------------------------------------------
-- 5. Reschedule moves both pending jobs and creates no duplicate
-- ---------------------------------------------------------------------------

create temporary table t_tattoo_jobs as
select j.id, j.anchor_offset_minutes
from public.automation_jobs j
where j.session_id = (select id from t_tattoo);
grant select on t_tattoo_jobs to public;

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_tattoo),
      (select base_at + interval '20 days' from t_clock),
      (select base_at + interval '20 days 6 hours' from t_clock))$$,
  'the appointment is rescheduled through its ordinary RPC'
);
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select set_eq(
  $$select id from public.automation_jobs
    where session_id = (select id from t_tattoo)$$,
  $$select id from t_tattoo_jobs$$,
  'rescheduling moves the existing jobs instead of creating new ones'
);

select ok(
  (select bool_and(
     j.scheduled_at = s.start_at + make_interval(mins => j.anchor_offset_minutes))
   from public.automation_jobs j
   join public.sessions s on s.id = j.session_id
   where j.session_id = (select id from t_tattoo)
     and j.message_purpose in (
       'session_reminder_72h', 'session_reminder_24h', 'consultation_reminder'
     )),
  'both reminders followed the appointment to its new start'
);

-- ---------------------------------------------------------------------------
-- 6. A due reminder executes onto the existing approved-email outbox
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_tattoo),
      (select base_at + interval '20 hours' from t_clock),
      (select base_at + interval '26 hours' from t_clock))$$,
  'the appointment moves inside the 24 hour window'
);
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

create temporary table t_due as
select id from public.automation_jobs
where session_id = (select id from t_tattoo)
  and anchor_offset_minutes = -1440;
grant select on t_due to public;

select is(
  (select status::text from public.automation_jobs where id = (select id from t_due)),
  'completed',
  'the due 24 hour reminder completes'
);
select is(
  (select status::text from public.automation_jobs
   where session_id = (select id from t_tattoo) and anchor_offset_minutes = -4320),
  'completed',
  'the 72 hour reminder, also past due at this start, completes on the same tick'
);

select ok(
  (select created_by_kind = 'system'
      and created_by is null
      and approved_by is null
      and approved_at is not null
      and status = 'approved'::public.email_message_status
      and template_key = 'session_reminder_24h'
   from public.email_messages where automation_job_id = (select id from t_due)),
  'the shipped 24 hour reminder records lifecycle system-approval provenance'
);

select ok(
  (select subject = 'Tomorrow: your tattoo appointment with Vladimir'
      and body like 'Hi Activation,%'
      and body like '%Vladimir%'
      and body not like '%{{%'
   from public.email_messages where automation_job_id = (select id from t_due)),
  'the shipped v1 copy renders fully from the live session'
);

select is(
  (select count(*)::int from public.integration_outbox o
   where o.kind = 'approved_email'
     and o.dedupe_key = 'email:automation:' || (select id from t_due)::text),
  1,
  'the reminder reaches the existing approved-email outbox exactly once'
);

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int from public.integration_outbox o
   where o.kind = 'approved_email'
     and o.dedupe_key = 'email:automation:' || (select id from t_due)::text),
  1,
  'a repeated tick cannot duplicate the delivery item'
);

-- ---------------------------------------------------------------------------
-- 7. Cancellation withdraws pending lifecycle work
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.set_appointment_status(
      (select id from t_consult), 'cancelled'::public.session_status)$$,
  'the consultation is cancelled through its ordinary RPC'
);
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select status::text from public.automation_jobs
   where session_id = (select id from t_consult)),
  'cancelled',
  'cancelling the appointment cancels its pending lifecycle work'
);
select is(
  (select last_error_category from public.automation_jobs
   where session_id = (select id from t_consult)),
  'appointment_ineligible',
  'the cancellation reason is recorded rather than inferred'
);
select is(
  (select count(*)::int from public.email_messages m
   join public.automation_jobs j on j.id = m.automation_job_id
   where j.session_id = (select id from t_consult)),
  0,
  'a cancelled appointment never produces a client email'
);

-- ---------------------------------------------------------------------------
-- 8. Suppression blocks delivery fail-closed
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('e8033333-3333-4333-8333-333333333333',
   'Suppressed Client', 'suppressed-client@example.test');
insert into public.projects (id, client_id, artist_id, title, description) values
  ('e8044444-4444-4444-8444-444444444444',
   'e8033333-3333-4333-8333-333333333333',
   (select id from t_artist),
   'Suppressed tattoo project',
   'Synthetic project for the suppression gate');

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_suppressed as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'e8033333-3333-4333-8333-333333333333',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '20 hours' from t_clock),
    (select base_at + interval '26 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'e8044444-4444-4444-8444-444444444444',
    'Suppressed activation appointment'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_suppressed to public;
reset role;

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.suppress_client_communications(
      'e8033333-3333-4333-8333-333333333333',
      'email'::public.message_template_channel,
      'complained'::public.suppression_reason,
      'activation_test')$$,
  'the client is suppressed for email before the reminder becomes due'
);
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int from public.automation_jobs
   where session_id = (select id from t_suppressed)
     and status = 'cancelled'::public.automation_job_status
     and last_error_category = 'client_blocked'),
  2,
  'both due reminders for a suppressed client are cancelled, not sent'
);
select is(
  (select count(*)::int from public.email_messages m
   join public.automation_jobs j on j.id = m.automation_job_id
   where j.session_id = (select id from t_suppressed)),
  0,
  'suppression fails closed: no email row is created at all'
);
select is(
  (select count(*)::int from public.integration_outbox o
   join public.automation_jobs j
     on o.dedupe_key = 'email:automation:' || j.id::text
   where j.session_id = (select id from t_suppressed)),
  0,
  'suppression fails closed: nothing reaches the delivery outbox'
);

select finish();
rollback;
