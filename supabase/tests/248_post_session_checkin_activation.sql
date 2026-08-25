-- 248_post_session_checkin_activation.sql
--
-- 0103 is reviewed configuration on the existing lifecycle runtime. This test
-- proves the exact approved configuration and exercises the previously
-- unconfigured touch_up path through the existing approved_email outbox.
-- Everything is synthetic and rolled back. No provider API is called.

begin;
select no_plan();

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_artist as
select a.id, a.workspace_id
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';
grant select on t_artist to public;

-- ---------------------------------------------------------------------------
-- 1. Exact approved scope and copy
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from public.automation_rules r
   where r.message_purpose = 'post_session_checkin'),
  (select count(*)::int
   from public.artists a
   join crm_private.artist_state s on s.artist_id = a.id and s.is_active) * 2,
  'activation creates exactly two post-session rules per active artist'
);

select set_eq(
  $$select r.condition_appointment_type::text,
           r.schedule_anchor::text,
           r.anchor_offset_minutes,
           r.message_locale
    from public.automation_rules r
    where r.artist_id = (select id from t_artist)
      and r.message_purpose = 'post_session_checkin'
      and r.is_enabled$$,
  $$values
      ('tattoo_session', 'session_end', 1440, 'en'),
      ('touch_up',       'session_end', 1440, 'en')$$,
  'only tattoo sessions and touch-ups are enabled 24 hours after session end in English'
);

select is(
  (select count(*)::int
   from public.automation_rules r
   where r.message_purpose = 'post_session_checkin'
     and r.condition_appointment_type in (
       'in_person_consultation'::public.appointment_type,
       'video_consultation'::public.appointment_type
     )),
  0,
  'neither consultation appointment type is enrolled'
);

select is(
  (select count(*)::int
   from public.automation_rules r
   where r.message_purpose = 'post_session_checkin'
     and (
       not r.is_enabled
       or r.action_type <> 'send_client_message'::public.automation_action_type
       or r.trigger_event_type <> 'appointment.scheduled'
       or r.condition_from_status is not null
       or r.condition_to_status is not null
       or r.delay_minutes <> 0
       or r.schedule_anchor <> 'session_end'::public.automation_schedule_anchor
       or r.anchor_offset_minutes <> 1440
       or r.message_channel <> 'email'::public.message_template_channel
       or r.message_locale <> 'en'
       or r.action_body is not null
     )),
  0,
  'no additional or malformed post-session lifecycle stage is activated'
);

select is(
  (select p.classification::text
   from public.message_template_purposes p
   where p.purpose = 'post_session_checkin'),
  'service',
  'post-session check-in remains a service purpose'
);

select is(
  (select count(*)::int
   from public.message_templates t
   where t.purpose = 'post_session_checkin'
     and t.status = 'active'::public.message_template_status),
  (select count(distinct a.workspace_id)::int
   from public.artists a
   join crm_private.artist_state s on s.artist_id = a.id and s.is_active),
  'activation creates one active template per active workspace'
);

select is(
  (select t.subject
   from public.message_templates t
   where t.workspace_id = (select workspace_id from t_artist)
     and t.artist_id is null
     and t.purpose = 'post_session_checkin'
     and t.channel = 'email'::public.message_template_channel
     and t.locale = 'en'
     and t.status = 'active'::public.message_template_status),
  'How is your tattoo feeling today?',
  'the approved English subject is exact'
);

select is(
  (select t.body
   from public.message_templates t
   where t.workspace_id = (select workspace_id from t_artist)
     and t.artist_id is null
     and t.purpose = 'post_session_checkin'
     and t.channel = 'email'::public.message_template_channel
     and t.locale = 'en'
     and t.status = 'active'::public.message_template_status),
  E'Hi {{client_first_name}},\n\nJust checking in after your tattoo session with {{artist_display_name}} yesterday.\n\nHow are you feeling, and how is the tattoo doing so far?\n\nPlease keep following the aftercare instructions you were given. If you have any questions or anything you are unsure about during the healing process, just reply to this email and let us know.\n\nThere is no need to reply if everything is going well.\n\nTake care,\n{{artist_display_name}}',
  'the approved English body is exact'
);

select ok(
  not has_table_privilege('authenticated', 'public.message_templates', 'select')
  and not has_table_privilege('anon', 'public.message_templates', 'select'),
  'activation does not widen direct browser reads of message_templates'
);

select ok(
  not has_function_privilege(
    'authenticated', 'public.service_run_automation_tick(integer)', 'EXECUTE')
  and has_function_privilege(
    'service_role', 'public.service_run_automation_tick(integer)', 'EXECUTE')
  and not has_function_privilege(
    'service_role', 'crm_private.execute_client_lifecycle_job(uuid)', 'EXECUTE'),
  'the scheduler and private executor keep their existing backend boundaries'
);

-- ---------------------------------------------------------------------------
-- 2. Synthetic actor, client and Gmail route
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('fa000000-0000-4000-8000-000000000001', 'post-session-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa000000-0000-4000-8000-000000000001', 'post-session-owner@example.test',
   'Post-session Owner', 'owner', true);

create function pg_temp.as_owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}',
    true)::void;
$$;
create function pg_temp.as_backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
create function pg_temp.tick() returns void language plpgsql as $$
begin
  perform * from public.service_run_automation_tick(200);
end;
$$;
grant execute on function pg_temp.as_owner(), pg_temp.as_backend()
  to authenticated, service_role;
grant execute on function pg_temp.tick() to service_role;

insert into public.clients (id, full_name, email) values
  ('fa111111-1111-4111-8111-111111111111',
   'Activation Client', 'post-session-client@example.test');
insert into public.projects (id, client_id, artist_id, title, description) values
  ('fa222222-2222-4222-8222-222222222222',
   'fa111111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Post-session touch-up project',
   'Rollback-only project for the approved post-session activation');

select pg_temp.as_backend();
set local role service_role;
select lives_ok(
  $$select public.service_set_gmail_integration(
      (select id from t_artist),
      'google_gmail_post_session_activation',
      'post-session-artist@example.test',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[])$$,
  'the existing Gmail integration surface supplies the delivery route'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. touch_up materialises from authoritative session_end and waits for completed
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_touch_up as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa111111-1111-4111-8111-111111111111',
    'touch_up'::public.appointment_type,
    (select base_at - interval '52 hours' from t_clock),
    (select base_at - interval '48 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'fa222222-2222-4222-8222-222222222222',
    'Approved post-session touch-up fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_touch_up to public;
reset role;

select pg_temp.as_backend();
set local role service_role;
select pg_temp.tick();
reset role;

create temporary table t_job as
select j.id
from public.automation_jobs j
where j.session_id = (select id from t_touch_up)
  and j.message_purpose = 'post_session_checkin';
grant select on t_job to public;

select is((select count(*)::int from t_job), 1,
  'one touch-up and one matching rule materialise one post-session job');
select is(
  (select j.scheduled_at
   from public.automation_jobs j where j.id = (select id from t_job)),
  (select s.end_at + interval '24 hours'
   from public.sessions s where s.id = (select id from t_touch_up)),
  'due_at is exactly 24 hours after authoritative session end_at'
);
select is(
  (select j.status::text
   from public.automation_jobs j where j.id = (select id from t_job)),
  'pending',
  'a time-due touch-up remains pending while it is only confirmed'
);
select is(
  (select count(*)::int
   from public.email_messages m where m.automation_job_id = (select id from t_job)),
  0,
  'confirmed is not enough to send the post-session email'
);

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.set_appointment_status(
      (select id from t_touch_up), 'completed'::public.session_status)$$,
  'the touch-up is completed through the normal appointment lifecycle RPC'
);
reset role;

select pg_temp.as_backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select j.status::text
   from public.automation_jobs j where j.id = (select id from t_job)),
  'completed',
  'the due post-session job completes only after the touch-up is completed'
);
select ok(
  (select m.created_by_kind = 'system'
      and m.created_by is null
      and m.approved_by is null
      and m.approved_at is not null
      and m.status = 'approved'::public.email_message_status
      and m.template_key = 'post_session_checkin'
   from public.email_messages m where m.automation_job_id = (select id from t_job)),
  'delivery preserves lifecycle system-approved provenance'
);
select is(
  (select m.subject
   from public.email_messages m where m.automation_job_id = (select id from t_job)),
  'How is your tattoo feeling today?',
  'the approved subject reaches the CRM email'
);
select is(
  (select m.body
   from public.email_messages m where m.automation_job_id = (select id from t_job)),
  E'Hi Activation,\n\nJust checking in after your tattoo session with Vladimir yesterday.\n\nHow are you feeling, and how is the tattoo doing so far?\n\nPlease keep following the aftercare instructions you were given. If you have any questions or anything you are unsure about during the healing process, just reply to this email and let us know.\n\nThere is no need to reply if everything is going well.\n\nTake care,\nVladimir',
  'the approved body renders only authoritative client and artist variables'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.kind = 'approved_email'
     and o.dedupe_key = 'email:automation:' || (select id from t_job)::text),
  1,
  'the completed touch-up reaches the existing approved_email outbox once'
);

select pg_temp.as_backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int
   from public.email_messages m where m.automation_job_id = (select id from t_job)),
  1,
  'repeated ticks do not duplicate the post-session CRM email'
);
select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.dedupe_key = 'email:automation:' || (select id from t_job)::text),
  1,
  'repeated ticks do not duplicate the Gmail outbox item'
);

-- ---------------------------------------------------------------------------
-- 4. Both consultation types remain outside this stage at materialisation
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_consultations as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa111111-1111-4111-8111-111111111111',
    'in_person_consultation'::public.appointment_type,
    (select base_at + interval '10 days' from t_clock),
    (select base_at + interval '10 days 30 minutes' from t_clock),
    'confirmed'::public.session_status,
    null, null, 'Excluded in-person consultation'
  ) ->> 'appointment_id'
)::uuid as id
union all
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa111111-1111-4111-8111-111111111111',
    'video_consultation'::public.appointment_type,
    (select base_at + interval '11 days' from t_clock),
    (select base_at + interval '11 days 30 minutes' from t_clock),
    'confirmed'::public.session_status,
    null, null, 'Excluded video consultation'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_consultations to public;
reset role;

select pg_temp.as_backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int
   from public.automation_jobs j
   where j.session_id in (select id from t_consultations)
     and j.message_purpose = 'post_session_checkin'),
  0,
  'neither consultation type materialises a post-session check-in job'
);

select * from finish(true);
rollback;
