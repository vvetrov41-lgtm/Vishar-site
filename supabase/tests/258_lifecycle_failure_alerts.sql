begin;
select no_plan();

-- Shared fixture from 250_lifecycle_execution_history.sql.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'f5100000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000000'::uuid,
  'authenticated', 'authenticated', 'history-reader@example.test',
  crypt('history-reader-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

-- Use a non-owner profile so installation-owner bootstrap triggers do not
-- silently grant access to the foreign synthetic artist. The history RPC must
-- prove its own exact artist capability boundary.
insert into public.profiles (id, email, display_name, role, is_active)
values (
  'f5100000-0000-4000-8000-000000000001'::uuid,
  'history-reader@example.test', 'History Reader', 'booking_manager', true
);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active)
values
  ('f5200000-0000-4000-8000-000000000001'::uuid, 'history-home', 'History Home', 'studio', true),
  ('f5200000-0000-4000-8000-000000000002'::uuid, 'history-foreign', 'History Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, timezone, default_currency, is_active)
values
  ('f5300000-0000-4000-8000-000000000001'::uuid, 'f5200000-0000-4000-8000-000000000001'::uuid, 'history-home-artist', 'History Home Artist', 'Europe/London', 'GBP', true),
  ('f5300000-0000-4000-8000-000000000002'::uuid, 'f5200000-0000-4000-8000-000000000002'::uuid, 'history-foreign-artist', 'History Foreign Artist', 'Europe/London', 'GBP', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'f5100000-0000-4000-8000-000000000001'::uuid,
  'f5300000-0000-4000-8000-000000000001'::uuid,
  'artist', false, false, false, false, true, 'explicit'
);

insert into public.clients (id, full_name, email)
values
  ('f5400000-0000-4000-8000-000000000001'::uuid, 'History Client', 'history-client@example.test'),
  ('f5400000-0000-4000-8000-000000000002'::uuid, 'Foreign History Client', 'foreign-history@example.test');

insert into public.projects (id, client_id, artist_id, title, status)
values
  ('f5500000-0000-4000-8000-000000000001'::uuid, 'f5400000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'History Project', 'active'),
  ('f5500000-0000-4000-8000-000000000002'::uuid, 'f5400000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'Foreign History Project', 'active');

insert into public.sessions (
  id, artist_id, client_id, project_id, appointment_type, start_at, end_at, status
) values
  ('f5600000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'f5400000-0000-4000-8000-000000000001'::uuid, 'f5500000-0000-4000-8000-000000000001'::uuid, 'tattoo_session', '2026-09-01 10:00:00+00', '2026-09-01 17:00:00+00', 'confirmed'),
  ('f5600000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'f5400000-0000-4000-8000-000000000002'::uuid, 'f5500000-0000-4000-8000-000000000002'::uuid, 'tattoo_session', '2026-09-01 10:00:00+00', '2026-09-01 17:00:00+00', 'confirmed');

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  action_type, action_title, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale, is_enabled
) values
  ('f5700000-0000-4000-8000-000000000001'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'History Rule', 'appointment.scheduled',
   'send_client_message', 'History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false),
  ('f5700000-0000-4000-8000-000000000003'::uuid, 'f5300000-0000-4000-8000-000000000001'::uuid, 'Suppressed History Rule', 'appointment.scheduled',
   'send_client_message', 'Suppressed History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false),
  ('f5700000-0000-4000-8000-000000000002'::uuid, 'f5300000-0000-4000-8000-000000000002'::uuid, 'Foreign History Rule', 'appointment.scheduled',
   'send_client_message', 'Foreign History Rule', 'normal',
   'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en', false);


create function pg_temp.alert_job(p_artist uuid, p_status text, p_age interval default interval '0')
returns uuid language plpgsql as $$
declare
  v_job uuid := gen_random_uuid(); v_event uuid := gen_random_uuid();
  v_session public.sessions%rowtype; v_rule uuid;
begin
  select * into v_session from public.sessions where artist_id=p_artist order by id limit 1;
  select id into v_rule from public.automation_rules where artist_id=p_artist order by id limit 1;
  -- Lifecycle jobs are unique per rule/session. Each distinct failure needs
  -- its own appointment, rather than bypassing the production dedupe index.
  v_session.id := gen_random_uuid();
  insert into public.sessions (
    id,artist_id,client_id,project_id,appointment_type,start_at,end_at,status
  ) values (
    v_session.id,p_artist,v_session.client_id,v_session.project_id,
    v_session.appointment_type,v_session.start_at,v_session.end_at,v_session.status
  );
  insert into public.automation_events (id,activity_id,artist_id,event_type,entity_kind,entity_id,occurred_at)
  values(v_event,gen_random_uuid(),p_artist,'appointment.scheduled','session',v_session.id,now()-p_age);
  insert into public.automation_jobs (
    id,rule_id,rule_version,event_id,artist_id,action_type,action_title,action_priority,
    scheduled_at,status,attempt_count,schedule_anchor,anchor_offset_minutes,
    condition_appointment_type,message_purpose,message_channel,message_locale,session_id,
    updated_at,completed_at,last_error_category
  ) values (
    v_job,v_rule,1,v_event,p_artist,'send_client_message','Secret client name must not escape','normal',
    now()-p_age,p_status::public.automation_job_status,1,'session_start',-1440,
    'tattoo_session','session_reminder_24h','email','en',v_session.id,
    now()-p_age,case when p_status='completed' then now()-p_age end,'unknown'
  );
  return v_job;
end;
$$;
create function pg_temp.alert_email(p_status text, p_outbox_status text default null, p_age interval default interval '0')
returns uuid language plpgsql as $$
declare
  v_artist uuid := 'f5300000-0000-4000-8000-000000000001';
  v_job uuid := pg_temp.alert_job(v_artist,'completed',p_age);
  v_email uuid := gen_random_uuid(); v_session public.sessions%rowtype;
begin
  select s.* into v_session from public.sessions s
  join public.automation_jobs j on j.session_id=s.id where j.id=v_job;
  insert into public.email_messages (
    id,artist_id,automation_job_id,client_id,enquiry_id,project_id,to_email,subject,body,
    created_by_kind,status,approved_at,sent_at,updated_at
  ) values (
    v_email,v_artist,v_job,v_session.client_id,v_session.enquiry_id,v_session.project_id,
    'private-recipient@example.test','Private subject','Private message body','system',
    p_status::public.email_message_status,now()-p_age,
    case when p_status='sent' then now()-p_age end,now()-p_age
  );
  if p_outbox_status is not null then
    insert into public.integration_outbox (
      kind,dedupe_key,artist_id,email_message_id,client_id,project_id,session_id,
      status,attempt_count,updated_at
    ) values ('approved_email','alerttest:'||v_email::text,v_artist,v_email,v_session.client_id,
      v_session.project_id,v_session.id,p_outbox_status::public.outbox_status,8,now()-p_age);
  end if;
  return v_email;
end;
$$;

select ok(has_function_privilege('service_role','public.service_sweep_lifecycle_failure_alerts(integer)','EXECUTE')
  and not has_function_privilege('anon','public.service_sweep_lifecycle_failure_alerts(integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.service_sweep_lifecycle_failure_alerts(integer)','EXECUTE'),
  'only backend can call the alert sweep');
select ok((select prosecdef and 'search_path=pg_catalog, public, crm_private'=any(proconfig)
  from pg_proc where oid='public.service_sweep_lifecycle_failure_alerts(integer)'::regprocedure),
  'alert sweep pins its definer search path');
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
select throws_ok('select public.service_sweep_lifecycle_failure_alerts(100)','42501',
  'lifecycle failure alerts are backend-only','backend JWT is required even with SQL execute privilege');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select throws_ok('select public.service_sweep_lifecycle_failure_alerts(101)','22023',
  'alert limit must be between 1 and 100','oversized batch is rejected');
select throws_ok('select public.service_sweep_lifecycle_failure_alerts(null)','22023',
  'alert limit must be between 1 and 100','null batch is rejected');
select is(public.service_sweep_lifecycle_failure_alerts(),0,'healthy state creates no alert');
reset role;

select pg_temp.alert_job('f5300000-0000-4000-8000-000000000001','failed') from generate_series(1,2);
select pg_temp.alert_job('f5300000-0000-4000-8000-000000000002','failed') from generate_series(1,3);
select pg_temp.alert_job('f5300000-0000-4000-8000-000000000001','failed',interval '2 days');
select pg_temp.alert_job('f5300000-0000-4000-8000-000000000001','cancelled') from generate_series(1,3);
select is(public.service_sweep_lifecycle_failure_alerts(),0,
  'two failures, old failures, cancellations and foreign artists cannot combine');
select pg_temp.alert_job('f5300000-0000-4000-8000-000000000001','failed');
insert into public.automation_kill_switches(scope_kind,scope_id,is_enabled)
values('artist','f5300000-0000-4000-8000-000000000001',false);
select is(public.service_sweep_lifecycle_failure_alerts(),0,'artist kill switch stops alerts');
delete from public.automation_kill_switches where scope_kind='artist' and scope_id='f5300000-0000-4000-8000-000000000001';
insert into public.automation_kill_switches(scope_kind,scope_id,is_enabled)
values('workspace','f5200000-0000-4000-8000-000000000001',false);
select is(public.service_sweep_lifecycle_failure_alerts(),0,'workspace kill switch stops alerts');
delete from public.automation_kill_switches where scope_kind='workspace' and scope_id='f5200000-0000-4000-8000-000000000001';
insert into public.automation_kill_switches(scope_kind,scope_id,is_enabled) values('global',null,false)
on conflict(scope_kind,scope_id) do update set is_enabled=false;
select is(public.service_sweep_lifecycle_failure_alerts(),0,'global kill switch stops alerts');
delete from public.automation_kill_switches where scope_kind='global';
update crm_private.artist_state set is_active=false where artist_id='f5300000-0000-4000-8000-000000000001';
select is(public.service_sweep_lifecycle_failure_alerts(),0,'inactive artist is skipped');
update crm_private.artist_state set is_active=true where artist_id='f5300000-0000-4000-8000-000000000001';
update public.artist_memberships set access_level='read_only'
where profile_id='f5100000-0000-4000-8000-000000000001';
select is(public.service_sweep_lifecycle_failure_alerts(),0,'read-only membership is not an alert recipient');
update public.artist_memberships set access_level='artist'
where profile_id='f5100000-0000-4000-8000-000000000001';
update crm_private.profile_access set is_active=false where profile_id='f5100000-0000-4000-8000-000000000001';
select is(public.service_sweep_lifecycle_failure_alerts(),0,'inactive recipient is skipped');
update crm_private.profile_access set is_active=true where profile_id='f5100000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.service_sweep_lifecycle_failure_alerts(),1,'three distinct failures create one alert');
select is(public.service_sweep_lifecycle_failure_alerts(),0,'same-day retries create no duplicate');
reset role;
select ok((select bool_and(priority='high' and status='delivered' and entity_id is null and entity_type is null
  and recipient_profile_id='f5100000-0000-4000-8000-000000000001'
  and artist_id='f5300000-0000-4000-8000-000000000001')
  from public.notifications where notification_type='automation.lifecycle_execution_failed'),
  'alert has a current recipient, exact artist, high priority and no client entity');
select ok((select bool_and(title not like '%Secret%' and body not like '%Private%' and body not like '%@%'
  and body not like '%History Client%') from public.notifications where notification_type like 'automation.lifecycle_%'),
  'alert copy contains no client, message, address or raw error');
select is((select count(*)::int from public.email_messages),0,'execution alert creates no client mail');
select is((select count(*)::int from public.integration_outbox),0,'execution alert creates no provider outbox work');

update public.notifications set dedupe_key=replace(dedupe_key,to_char(now() at time zone 'UTC','YYYY-MM-DD'),
  to_char((now() at time zone 'UTC')-interval '1 day','YYYY-MM-DD'))
where notification_type='automation.lifecycle_execution_failed';
select is(public.service_sweep_lifecycle_failure_alerts(1),1,'previous UTC day does not suppress new daily alert');
insert into public.artist_memberships(profile_id,artist_id,access_level,is_active,grant_source)
values('f5100000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000002','artist',true,'explicit');
select is(public.service_sweep_lifecycle_failure_alerts(1),1,'bounded sweep advances past already-notified artist');

select pg_temp.alert_email('sent','failed') from generate_series(1,3);
select pg_temp.alert_email('cancelled','failed') from generate_series(1,3);
select pg_temp.alert_email('queued','failed',interval '2 days') from generate_series(1,3);
select pg_temp.alert_email('failed');
select pg_temp.alert_email('queued','dead');
select is(public.service_sweep_lifecycle_failure_alerts(),0,
  'two delivery failures, old attempts, recovered sends and cancelled mail do not alert');
select pg_temp.alert_email('queued','failed');
select is(public.service_sweep_lifecycle_failure_alerts(),1,'three distinct delivery failures alert on completed jobs');
select is(public.service_sweep_lifecycle_failure_alerts(),0,'delivery category deduplicates independently');
select is((select count(*)::int from public.email_messages),12,'sweep preserves source emails');

update public.artist_memberships set is_active=false
where profile_id='f5100000-0000-4000-8000-000000000001' and artist_id='f5300000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims','{"sub":"f5100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*)::int from public.list_notifications(null,100)
  where artist_id='f5300000-0000-4000-8000-000000000002'),0,'revoked artist alerts are hidden');
select is((select count(*)::int from public.list_notifications(null,100)
  where notification_type='automation.lifecycle_delivery_failed'),1,'authorized recipient sees delivery alert');
reset role;
select * from finish();
rollback;
