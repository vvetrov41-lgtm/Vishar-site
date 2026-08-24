-- 245_appointment_client_actions_activation.sql
-- Rollback-only synthetic acceptance for 0100. No provider API is called.

begin;
select no_plan();

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('ea000000-0000-4000-8000-000000000001', 'action-activation-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('ea000000-0000-4000-8000-000000000001', 'action-activation-owner@example.test',
   'Action Activation Owner', 'owner', true);

create function pg_temp.as_owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"ea000000-0000-4000-8000-000000000001","role":"authenticated"}',
    true)::void;
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

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

create temporary table t_artist as
select a.id, a.workspace_id
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';
grant select on t_artist to public;

-- Configuration and privilege surface.
select set_eq(
  $$select variable from public.message_template_variables
    where variable in ('confirm_link','reschedule_link','cancel_link')$$,
  $$values ('confirm_link'), ('reschedule_link'), ('cancel_link')$$,
  'all three appointment action URL variables are catalogued'
);

select is(
  (select count(*)::int
   from public.message_templates t
   where t.status='active'::public.message_template_status
     and t.channel='email'::public.message_template_channel
     and t.locale='en'
     and t.purpose in ('session_reminder_24h','consultation_reminder')
     and position('{{confirm_link}}' in t.body)>0
     and position('{{reschedule_link}}' in t.body)>0
     and position('{{cancel_link}}' in t.body)>0),
  (select count(distinct a.workspace_id)::int * 2
   from public.artists a join crm_private.artist_state s on s.artist_id=a.id and s.is_active),
  'every active workspace has action-enabled 24h tattoo and consultation templates'
);

select is(
  (select count(*)::int
   from public.message_templates t
   where t.status='active'::public.message_template_status
     and t.channel='email'::public.message_template_channel
     and t.locale='en'
     and t.purpose='session_reminder_72h'
     and (position('{{confirm_link}}' in t.body)>0
          or position('{{reschedule_link}}' in t.body)>0
          or position('{{cancel_link}}' in t.body)>0)),
  0,
  '72h reminder stays action-free so same-tick overdue jobs cannot invalidate each other'
);

select ok(
  (select bool_and(t.body like '%if a deposit applies to this booking, it is non-refundable if you cancel within 72 hours of the scheduled start time.%')
   from public.message_templates t
   where t.status='active'::public.message_template_status
     and t.channel='email'::public.message_template_channel
     and t.locale='en'
     and t.purpose='session_reminder_72h'),
  '0099 conditional 72h deposit policy remains intact'
);

select is(
  (select count(*)::int from public.automation_rules r
   where r.is_enabled
     and r.action_type='send_client_message'::public.automation_action_type
     and r.condition_appointment_type <> 'tattoo_session'::public.appointment_type
     and r.anchor_offset_minutes=-4320),
  0,
  'no 72h consultation rule is introduced'
);

select ok(
  not has_function_privilege('service_role',
    'crm_private.issue_appointment_client_actions(uuid)', 'EXECUTE'),
  'service_role still cannot mint raw appointment capabilities directly'
);
select ok(
  not has_function_privilege('service_role',
    'crm_private.render_lifecycle_action_template_text(text,uuid,text,text,text)', 'EXECUTE'),
  'action-link renderer remains DB-private'
);

-- Synthetic client/project and ordinary Gmail route.
insert into public.clients (id, full_name, email) values
  ('ea011111-1111-4111-8111-111111111111',
   'Action Activation Client', 'action-activation-client@example.test');

insert into public.projects (id, client_id, artist_id, title, description) values
  ('ea022222-2222-4222-8222-222222222222',
   'ea011111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Action activation tattoo project',
   'Rollback-only project for lifecycle action testing');

select pg_temp.backend();
set local role service_role;
select lives_ok(
  $$select public.service_set_gmail_integration(
      (select id from t_artist),
      'google_gmail_action_activation',
      'action-activation-artist@example.test',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[])$$,
  'the synthetic artist has the Gmail route required by lifecycle execution'
);
reset role;

-- A 48h-ahead tattoo executes only the already-overdue 72h job. It must mint
-- no client action capability.
select pg_temp.as_owner();
set local role authenticated;
create temporary table t_72h_session as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'ea011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '48 hours' from t_clock),
    (select base_at + interval '54 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'ea022222-2222-4222-8222-222222222222',
    '72h action-free fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_72h_session to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select status::text from public.automation_jobs
   where session_id=(select id from t_72h_session) and anchor_offset_minutes=-4320),
  'completed', 'due 72h reminder completes normally'
);
select is(
  (select status::text from public.automation_jobs
   where session_id=(select id from t_72h_session) and anchor_offset_minutes=-1440),
  'pending', '24h reminder remains pending when it is not due yet'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_72h_session)),
  0, '72h-only execution creates no appointment capability rows'
);
select ok(
  (select body not like '%/appointments/respond/%'
      and body like '%non-refundable if you cancel within 72 hours%'
   from public.email_messages
   where automation_job_id=(
     select id from public.automation_jobs
     where session_id=(select id from t_72h_session) and anchor_offset_minutes=-4320)),
  '72h email keeps deposit policy and contains no action URL'
);

-- A 20h-ahead tattoo makes both 72h and 24h jobs due on the same tick. Only the
-- 24h email may mint, so one valid three-action set survives.
select pg_temp.as_owner();
set local role authenticated;
create temporary table t_tattoo as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'ea011111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '20 hours' from t_clock),
    (select base_at + interval '26 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'ea022222-2222-4222-8222-222222222222',
    'Same-tick action fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_tattoo to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select set_eq(
  $$select anchor_offset_minutes from public.automation_jobs
    where session_id=(select id from t_tattoo)
      and status='completed'::public.automation_job_status$$,
  $$values (-4320), (-1440)$$,
  'both overdue tattoo reminders complete in the same tick'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo)
     and consumed_at is null and invalidated_at is null),
  3, 'same-tick execution leaves exactly one active three-action capability set'
);

create temporary table t_24h_message as
select m.id, m.body, m.automation_job_id
from public.email_messages m
where m.automation_job_id=(
  select j.id from public.automation_jobs j
  where j.session_id=(select id from t_tattoo) and j.anchor_offset_minutes=-1440
);
grant select on t_24h_message to public;

select ok(
  (select body not like '%{{%'
      and body like '%Confirm attendance:%'
      and body like '%Request a different time:%'
      and body like '%Cancel this appointment:%'
      and body like '%Your current appointment stays booked until we contact you and agree a new time.%'
      and body like '%non-refundable if you cancel within 72 hours%'
   from t_24h_message),
  '24h tattoo copy is fully rendered and preserves reschedule plus deposit semantics'
);
select is(
  (select ((length(body)-length(replace(body,'https://booking.vishartattoo.com/appointments/respond/','')))
           / length('https://booking.vishartattoo.com/appointments/respond/'))::int
   from t_24h_message),
  3, '24h tattoo email contains exactly three branded action links'
);

create temporary table t_links as
select
  substring(replace(body, E'\n', ' ') from 'Confirm attendance: https://booking[.]vishartattoo[.]com/appointments/respond/([0-9a-f]{64})') as confirm_token,
  substring(replace(body, E'\n', ' ') from 'Request a different time: https://booking[.]vishartattoo[.]com/appointments/respond/([0-9a-f]{64})') as reschedule_token,
  substring(replace(body, E'\n', ' ') from 'Cancel this appointment: https://booking[.]vishartattoo[.]com/appointments/respond/([0-9a-f]{64})') as cancel_token,
  body as original_body
from t_24h_message;
grant select on t_links to public;

select ok(
  (select confirm_token ~ '^[0-9a-f]{64}$'
      and reschedule_token ~ '^[0-9a-f]{64}$'
      and cancel_token ~ '^[0-9a-f]{64}$'
   from t_links),
  'all three raw capabilities appear in the outbound email with the exact 256-bit shape'
);

create temporary table t_action_tokens as
select 'confirm_attendance'::text as action, confirm_token as token from t_links
union all select 'request_reschedule', reschedule_token from t_links
union all select 'cancel', cancel_token from t_links;
grant select on t_action_tokens to public;

select is(
  (select count(*)::int
   from t_action_tokens x
   join crm_private.appointment_client_action_tokens t
     on t.session_id=(select id from t_tattoo)
    and t.action::text=x.action
    and t.token_hash=extensions.encode(extensions.digest(x.token,'sha256'),'hex')),
  3, 'private registry stores the SHA-256 digest for each email capability'
);
select ok(
  (select bool_and(o.payload::text not like '%' || x.token || '%')
   from public.integration_outbox o cross join t_action_tokens x
   where o.email_message_id=(select id from t_24h_message)),
  'approved-email outbox metadata does not copy raw appointment capabilities'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select action::text from public.service_resolve_appointment_client_action(
    (select token from t_action_tokens where action='confirm_attendance'))),
  'confirm_attendance', 'email confirm token resolves to confirm attendance'
);
select is(
  (select action::text from public.service_resolve_appointment_client_action(
    (select token from t_action_tokens where action='request_reschedule'))),
  'request_reschedule', 'email reschedule token resolves to request reschedule'
);
select is(
  (select action::text from public.service_resolve_appointment_client_action(
    (select token from t_action_tokens where action='cancel'))),
  'cancel', 'email cancel token resolves to cancel'
);
select is(
  crm_private.execute_client_lifecycle_job((select automation_job_id from t_24h_message)),
  'skipped', 'completed lifecycle job is idempotently skipped on replay'
);
reset role;

select is(
  (select body from public.email_messages where id=(select id from t_24h_message)),
  (select original_body from t_links),
  'lifecycle replay preserves the exact action URLs already stored in the email'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo)
     and consumed_at is null and invalidated_at is null),
  3, 'lifecycle replay does not rotate the existing capability set'
);

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.reschedule_appointment(
      (select id from t_tattoo),
      (select base_at + interval '8 days' from t_clock),
      (select base_at + interval '8 days 6 hours' from t_clock))$$,
  'ordinary reschedule changes the authoritative appointment version'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.service_resolve_appointment_client_action(
      (select token from t_action_tokens where action='confirm_attendance'))$$,
  '42501', null,
  'an action URL from the previous appointment version becomes stale after reschedule'
);
reset role;

-- Consultation 24h gets the same three actions.
select pg_temp.as_owner();
set local role authenticated;
create temporary table t_consult as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'ea011111-1111-4111-8111-111111111111',
    'in_person_consultation'::public.appointment_type,
    (select base_at + interval '14 hours' from t_clock),
    (select base_at + interval '14 hours 30 minutes' from t_clock),
    'confirmed'::public.session_status,
    null,
    null,
    'Consultation action fixture'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_consult to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int from public.automation_jobs
   where session_id=(select id from t_consult)
     and message_purpose='consultation_reminder'
     and status='completed'::public.automation_job_status),
  1, '24h consultation reminder executes once'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_consult)
     and consumed_at is null and invalidated_at is null),
  3, 'consultation reminder mints exactly three active capabilities'
);
select ok(
  (select body not like '%{{%'
      and ((length(body)-length(replace(body,'https://booking.vishartattoo.com/appointments/respond/','')))
           / length('https://booking.vishartattoo.com/appointments/respond/'))::int = 3
      and body like '%Your current appointment stays booked until we contact you and agree a new time.%'
   from public.email_messages
   where automation_job_id=(
     select id from public.automation_jobs
     where session_id=(select id from t_consult)
       and message_purpose='consultation_reminder')),
  'consultation email renders three branded links with request-only reschedule wording'
);

select * from finish();
rollback;
