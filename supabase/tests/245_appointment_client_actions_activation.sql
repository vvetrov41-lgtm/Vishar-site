-- 245_appointment_client_actions_activation.sql
--
-- Prove the 0100 activation from lifecycle job to branded one-tap capability.
-- Synthetic data only, one transaction, no provider API, full rollback.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_clock as
select date_trunc('hour', now()) as base_at;
grant select on t_clock to public;

insert into auth.users (id, email) values
  ('fa000000-0000-4000-8000-000000000001', 'action-activation-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa000000-0000-4000-8000-000000000001', 'action-activation-owner@example.test',
   'Action Activation Owner', 'owner', true);

create function pg_temp.as_owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}',
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

select is((select count(*)::int from t_artist), 1,
  'canonical test install has one active Vladimir artist');

-- ---------------------------------------------------------------------------
-- 1. Activation configuration
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from public.message_templates t
   where t.workspace_id = (select workspace_id from t_artist)
     and t.artist_id is null
     and t.status = 'active'
     and t.purpose in ('session_reminder_24h', 'consultation_reminder')
     and t.body like '%[[confirm_capability]]%'
     and t.body like '%[[reschedule_capability]]%'
     and t.body like '%[[cancel_capability]]%'),
  2,
  'both 24h lifecycle templates carry all three internal capability markers'
);

select is(
  (select count(*)::int
   from public.message_templates t
   where t.workspace_id = (select workspace_id from t_artist)
     and t.artist_id is null
     and t.status = 'active'
     and t.purpose = 'session_reminder_72h'
     and (t.body like '%[[confirm_capability]]%'
       or t.body like '%[[reschedule_capability]]%'
       or t.body like '%[[cancel_capability]]%')),
  0,
  'the 72h deposit reminder carries no appointment action marker'
);

select ok(
  not has_function_privilege('service_role',
    'crm_private.issue_appointment_client_actions(uuid)', 'EXECUTE'),
  'the public Worker service role still cannot mint capabilities directly'
);

select ok(
  not has_function_privilege('service_role',
    'crm_private.inject_appointment_client_actions()', 'EXECUTE'),
  'the last-mile injection function is not an exposed service RPC'
);

select ok(
  (select array_position(array_agg(t.tgname order by t.tgname),
                         'email_messages_guard_automation_job')
        < array_position(array_agg(t.tgname order by t.tgname),
                         'email_messages_inject_appointment_actions')
   from pg_trigger t
   join pg_class c on c.oid=t.tgrelid
   join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='email_messages'
     and not t.tgisinternal and t.tgtype & 2 = 2),
  'automation provenance guard runs before capability injection'
);

-- ---------------------------------------------------------------------------
-- 2. Shared synthetic client/project and Gmail gate
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('fa111111-1111-4111-8111-111111111111',
   'Action Activation Client', 'action-activation-client@example.test');
insert into public.projects (id, client_id, artist_id, title, description) values
  ('fa222222-2222-4222-8222-222222222222',
   'fa111111-1111-4111-8111-111111111111',
   (select id from t_artist),
   'Action activation tattoo project',
   'Synthetic rollback-only project');

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
  'artist has the Gmail route required by lifecycle execution'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. Tattoo 24h reminder mints exactly one three-action capability set
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_tattoo as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa111111-1111-4111-8111-111111111111',
    'tattoo_session'::public.appointment_type,
    (select base_at + interval '20 hours' from t_clock),
    (select base_at + interval '22 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    'fa222222-2222-4222-8222-222222222222',
    'Action activation tattoo appointment'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_tattoo to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

create temporary table t_tattoo_24h_job as
select id from public.automation_jobs
where session_id=(select id from t_tattoo)
  and message_purpose='session_reminder_24h';
grant select on t_tattoo_24h_job to public;

create temporary table t_tattoo_72h_job as
select id from public.automation_jobs
where session_id=(select id from t_tattoo)
  and message_purpose='session_reminder_72h';
grant select on t_tattoo_72h_job to public;

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo)),
  3,
  'tattoo execution mints exactly three tokens, proving 72h email mints none'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo)
     and consumed_at is null and invalidated_at is null),
  3,
  'all three freshly issued tattoo actions are live'
);

select ok(
  (select body ~ 'Confirm attendance:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and body ~ 'Request a reschedule:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and body ~ 'Cancel appointment:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and body not like '%[[%'
      and body not like '%{{%'
      and body like '%deposit applies to this booking%'
   from public.email_messages
   where automation_job_id=(select id from t_tattoo_24h_job)),
  'tattoo 24h approved email contains three fully rendered branded links and deposit reminder'
);

select ok(
  (select body not like '%/appointments/respond/%'
      and body not like '%[[%'
   from public.email_messages
   where automation_job_id=(select id from t_tattoo_72h_job)),
  'tattoo 72h email remains action-free'
);

create temporary table t_tattoo_link as
select substring(
  body from 'Confirm attendance:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/([0-9a-f]{64})'
) as token
from public.email_messages
where automation_job_id=(select id from t_tattoo_24h_job);
grant select on t_tattoo_link to public;

select ok((select token ~ '^[0-9a-f]{64}$' from t_tattoo_link),
  'confirm capability can be recovered only from the approved outbound body');

select is(
  (select token_hash
   from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo)
     and action='confirm_attendance'),
  encode(extensions.digest((select token from t_tattoo_link), 'sha256'), 'hex'),
  'private capability registry stores the hash matching the emailed raw token'
);

select is(
  (select count(*)::int
   from public.integration_outbox o,
        lateral jsonb_object_keys(o.payload) k
   where o.email_message_id=(
       select id from public.email_messages
       where automation_job_id=(select id from t_tattoo_24h_job))
     and o.kind='approved_email'),
  1,
  'approved-email outbox payload exposes only its single email_message_id field'
);

select is(
  (select payload ? 'email_message_id'
   from public.integration_outbox
   where email_message_id=(
       select id from public.email_messages
       where automation_job_id=(select id from t_tattoo_24h_job))),
  true,
  'approved-email outbox references the rendered email by id'
);

-- GET/readback must remain scanner-safe and not consume the emailed token.
select pg_temp.backend();
set local role service_role;
select is(
  (select action::text
   from public.service_resolve_appointment_client_action(
     (select token from t_tattoo_link))),
  'confirm_attendance',
  'emailed confirm link resolves through the existing backend boundary'
);
reset role;

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo) and consumed_at is not null),
  0,
  'GET/readback does not consume an appointment action'
);

-- ---------------------------------------------------------------------------
-- 4. Delivery replay cannot rotate capabilities behind an existing email
-- ---------------------------------------------------------------------------

create temporary table t_hashes_before as
select action, token_hash
from crm_private.appointment_client_action_tokens
where session_id=(select id from t_tattoo);
grant select on t_hashes_before to public;

update public.automation_jobs
set status='pending', completed_at=null
where id=(select id from t_tattoo_24h_job);

select pg_temp.backend();
set local role service_role;
select lives_ok(
  $$select crm_private.execute_client_lifecycle_job(
      (select id from t_tattoo_24h_job))$$,
  'replaying an already-materialised lifecycle job is safe'
);
reset role;

select set_eq(
  $$select action::text, token_hash
    from crm_private.appointment_client_action_tokens
    where session_id=(select id from t_tattoo)$$,
  $$select action::text, token_hash from t_hashes_before$$,
  'delivery replay preserves the exact capability set already embedded in the email'
);

select is(
  (select count(*)::int from public.email_messages
   where automation_job_id=(select id from t_tattoo_24h_job)),
  1,
  'delivery replay cannot duplicate the 24h email'
);

-- Mutating POST consumes exactly the chosen capability and records the response.
select pg_temp.backend();
set local role service_role;
select lives_ok(
  $$select public.service_apply_appointment_client_action(
      (select token from t_tattoo_link))$$,
  'emailed confirm capability applies through the existing mutation boundary'
);
reset role;

select is(
  (select client_response::text from public.sessions where id=(select id from t_tattoo)),
  'attendance_confirmed',
  'one-tap confirmation records attendance without changing booking status'
);
select is(
  (select status::text from public.sessions where id=(select id from t_tattoo)),
  'confirmed',
  'attendance confirmation keeps the appointment confirmed'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo) and consumed_at is not null),
  1,
  'chosen confirm token is consumed exactly once'
);
select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_tattoo) and invalidated_at is not null),
  2,
  'contradictory sibling actions are invalidated after confirmation'
);

-- ---------------------------------------------------------------------------
-- 5. Consultation 24h reminder gets actions but no deposit wording
-- ---------------------------------------------------------------------------

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_consult as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa111111-1111-4111-8111-111111111111',
    'in_person_consultation'::public.appointment_type,
    (select base_at + interval '22 hours 30 minutes' from t_clock),
    (select base_at + interval '23 hours' from t_clock),
    'confirmed'::public.session_status,
    null,
    null,
    'Action activation consultation'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_consult to public;
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_consult)),
  3,
  'consultation 24h reminder mints exactly three client actions'
);

select ok(
  (select body ~ 'Confirm attendance:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and body ~ 'Request a reschedule:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and body ~ 'Cancel appointment:[[:space:]]+https://booking\.vishartattoo\.com/appointments/respond/[0-9a-f]{64}'
      and lower(body) not like '%deposit%'
   from public.email_messages m
   join public.automation_jobs j on j.id=m.automation_job_id
   where j.session_id=(select id from t_consult)
     and j.message_purpose='consultation_reminder'),
  'consultation email has all actions and no tattoo deposit wording'
);

-- ---------------------------------------------------------------------------
-- 6. Suppressed email creates neither message nor capability
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('fa333333-3333-4333-8333-333333333333',
   'Suppressed Action Client', 'suppressed-action-client@example.test');

select pg_temp.as_owner();
set local role authenticated;
create temporary table t_suppressed as
select (
  public.schedule_appointment(
    (select id from t_artist),
    'fa333333-3333-4333-8333-333333333333',
    'video_consultation'::public.appointment_type,
    (select base_at + interval '17 hours' from t_clock),
    (select base_at + interval '17 hours 30 minutes' from t_clock),
    'confirmed'::public.session_status,
    null,
    null,
    'Suppressed action consultation'
  ) ->> 'appointment_id'
)::uuid as id;
grant select on t_suppressed to public;
select lives_ok(
  $$select public.suppress_client_communications(
      'fa333333-3333-4333-8333-333333333333',
      'email'::public.message_template_channel,
      'complained'::public.suppression_reason,
      'action_activation_test')$$,
  'client is suppressed before the 24h lifecycle job executes'
);
reset role;

select pg_temp.backend();
set local role service_role;
select pg_temp.tick();
reset role;

select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens
   where session_id=(select id from t_suppressed)),
  0,
  'suppressed lifecycle email mints no appointment capabilities'
);
select is(
  (select count(*)::int from public.email_messages m
   join public.automation_jobs j on j.id=m.automation_job_id
   where j.session_id=(select id from t_suppressed)),
  0,
  'suppressed lifecycle job creates no client email'
);

select * from finish();
rollback;
