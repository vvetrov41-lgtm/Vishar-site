-- Synthetic fixtures, rollback-only. No provider calls or production records.
begin;
select no_plan();

select has_function('crm_private', 'notify_missed_aftercare_jobs',
  array['integer'], 'dedicated private aftercare alert sweep exists');
select ok(
  not has_function_privilege('anon','crm_private.notify_missed_aftercare_jobs(integer)','EXECUTE')
  and not has_function_privilege('authenticated','crm_private.notify_missed_aftercare_jobs(integer)','EXECUTE')
  and not has_function_privilege('service_role','crm_private.notify_missed_aftercare_jobs(integer)','EXECUTE'),
  'no API role can directly execute the private alert helper');
select ok(
  position('crm_private.notify_missed_aftercare_jobs(p_limit)' in
    pg_get_functiondef('public.service_sweep_lifecycle_failure_alerts(integer)'::regprocedure)) > 0,
  'the existing 5-minute failure sweep invokes per-session aftercare alerts');

insert into auth.users (id,email) values
 ('f3820000-0000-4000-8000-000000000001','test-aftercare-alert@example.test');
insert into public.profiles (id,email,display_name,role,is_active) values
 ('f3820000-0000-4000-8000-000000000001','test-aftercare-alert@example.test',
  'Synthetic Aftercare Alert Recipient','owner',true)
on conflict (id) do nothing;
insert into crm_private.profile_access (profile_id,role,is_active) values
 ('f3820000-0000-4000-8000-000000000001','owner',true)
on conflict (profile_id) do update set role='owner',is_active=true;
insert into crm_private.artist_access (
 profile_id,artist_id,access_level,can_view_finance,can_manage_finance,
 can_manage_sessions,can_manage_integrations,is_active
) values (
 'f3820000-0000-4000-8000-000000000001',
 'a1111111-1111-4111-8111-111111111111',
 'artist',false,false,true,false,true
);

select ok(
 exists (select 1 from crm_private.automation_notification_recipients(
  'a1111111-1111-4111-8111-111111111111') r
  where r.profile_id='f3820000-0000-4000-8000-000000000001'),
 'the synthetic recipient is in the artist-facing notification tier');

insert into public.clients(id,full_name,email)
select ('f3821000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
 'Synthetic Aftercare Client '||n, 'aftercare-'||n||'@example.test'
from generate_series(1,6) n;

insert into public.projects(id,client_id,artist_id,title)
select ('f3822000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
('f3821000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'a1111111-1111-4111-8111-111111111111',
'Synthetic Aftercare Project '||n
from generate_series(1,6) n;

insert into public.sessions(
  id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at
) select ('f3823000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'a1111111-1111-4111-8111-111111111111',
('f3821000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
('f3822000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'tattoo_session','completed',
now()-(case when n=4 then interval '6 days 4 hours' else interval '4 hours' end),
now()-(case when n=4 then interval '6 days 2 hours' else interval '2 hours' end)
from generate_series(1,6) n;

insert into public.automation_rules(
 id,artist_id,name,trigger_event_type,action_type,action_title,action_priority,
 schedule_anchor,anchor_offset_minutes,condition_appointment_type,
 message_purpose,message_channel,message_locale,is_enabled
) values (
'f3824000-0000-4000-8000-000000000001',
'a1111111-1111-4111-8111-111111111111',
'Rollback-only aftercare alert rule','appointment.scheduled',
'send_client_message','Synthetic Aftercare','normal',
'session_end',60,'tattoo_session',
'post_session_aftercare','email','en',true
);

insert into public.automation_events(
 id,activity_id,artist_id,event_type,entity_kind,entity_id,occurred_at
) select
('f3825000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
('f3826000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'a1111111-1111-4111-8111-111111111111',
'appointment.scheduled','session',
('f3823000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
now()
from generate_series(1,6) n;

insert into public.automation_jobs(
 id,rule_id,rule_version,event_id,artist_id,action_type,action_title,action_priority,
 scheduled_at,status,last_error_category,
 schedule_anchor,anchor_offset_minutes,condition_appointment_type,
 message_purpose,message_channel,message_locale,session_id
) select
('f3827000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'f3824000-0000-4000-8000-000000000001',1,
('f3825000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid,
'a1111111-1111-4111-8111-111111111111',
'send_client_message','Synthetic Aftercare','normal',
case when n=3 then now()-interval '10 minutes'
     when n=4 then now()-interval '6 days 1 hour'
     else now()-interval '1 hour' end,
case when n=1 then 'failed'::public.automation_job_status
     when n=5 then 'completed'::public.automation_job_status
     else 'pending'::public.automation_job_status end,
case when n=1 then 'destination_unavailable' else null end,
'session_end',60,'tattoo_session',
'post_session_aftercare','email','en',
('f3823000-0000-4000-8000-0000000000'||lpad(n::text,2,'0'))::uuid
from generate_series(1,6) n;

-- Job six already has an email snapshot: its provider status is uncertain.
-- It must never prompt an operator to send a second copy.
insert into public.email_messages(
 status,artist_id,automation_job_id,client_id,project_id,to_email,
 subject,body,created_by_kind,approved_at
) values (
 'approved','a1111111-1111-4111-8111-111111111111',
 'f3827000-0000-4000-8000-000000000006',
 'f3821000-0000-4000-8000-000000000006',
 'f3822000-0000-4000-8000-000000000006',
 'aftercare-6@example.test','Synthetic aftercare','No provider call',
 'system',now()
);

select is(
 (select crm_private.lifecycle_block_disposition(id) from public.automation_jobs
  where id='f3827000-0000-4000-8000-000000000002'),
 'eligible', 'a pending first-day aftercare job is eligible but has missed its due time');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok('select public.service_sweep_lifecycle_failure_alerts(100)',
  'normal backend sweep materializes only artist-facing alerts');
reset role;

select is(
 (select count(*)::int from public.notifications
  where notification_type='automation.aftercare_needs_attention'
   and recipient_profile_id='f3820000-0000-4000-8000-000000000001'
   and entity_id in (
     'f3823000-0000-4000-8000-000000000001'::uuid,
     'f3823000-0000-4000-8000-000000000002'::uuid
   )), 2,
 'both one-off missed aftercare cases are visible to the artist');
select is(
 (select count(*)::int from public.notifications
  where notification_type='automation.aftercare_needs_attention'
    and recipient_profile_id='f3820000-0000-4000-8000-000000000001'
    and entity_id in (
      'f3823000-0000-4000-8000-000000000003'::uuid,
      'f3823000-0000-4000-8000-000000000004'::uuid,
      'f3823000-0000-4000-8000-000000000005'::uuid,
      'f3823000-0000-4000-8000-000000000006'::uuid
    )), 0,
 'not-yet-due, historical, completed and uncertain-send jobs do not trigger alerts');
select ok(
 (select bool_and(body not like '%example.test%' and body not like '%Synthetic Aftercare Client%')
  from public.notifications
  where notification_type='automation.aftercare_needs_attention'
    and recipient_profile_id='f3820000-0000-4000-8000-000000000001'),
 'notifications do not disclose client names, contact details or message contents');

set local role service_role;
select lives_ok('select public.service_sweep_lifecycle_failure_alerts(100)',
  'repeat sweeps are safe and idempotent');
reset role;
select is(
 (select count(*)::int from public.notifications
  where notification_type='automation.aftercare_needs_attention'
    and recipient_profile_id='f3820000-0000-4000-8000-000000000001'),
 2, 'no repeat alerts for unchanged jobs');
select is(
 (select count(*)::int from public.automation_jobs
  where id::text like 'f3827000-%' and status='completed'),
 1, 'alerting never executes or changes aftercare jobs');
select is(
 (select count(*)::int from public.integration_outbox o
  join public.clients c on c.id=o.client_id
  where c.id::text like 'f3821000-%'),
 0, 'alerting did not enqueue a client-facing provider message');
select * from finish();
rollback;
