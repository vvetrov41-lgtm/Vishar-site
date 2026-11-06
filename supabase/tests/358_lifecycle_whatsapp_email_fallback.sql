-- Provider failure scenarios are strictly synthetic and rolled back.
-- No Meta or Gmail request is made by the test database.
begin;
select no_plan();

create temporary table preferred_route_artist as
select id from public.artists where slug='vladimir';
grant select on preferred_route_artist to public;

insert into public.artist_integrations(
  artist_id,integration_type,provider,integration_key,
  external_account_label,is_enabled
) select a.id,'whatsapp','meta_cloud_api','vladimir-production',
  'Synthetic preferred-channel test',true from preferred_route_artist a
where not exists (
  select 1 from public.artist_integrations i
  where i.artist_id=a.id and i.integration_type='whatsapp'
    and i.provider='meta_cloud_api' and i.integration_key='vladimir-production'
);
insert into public.artist_integrations(
  artist_id,integration_type,provider,integration_key,
  external_account_label,is_enabled
) select a.id,'email','google','vladimir-preferred-fallback-test',
  'vladimir-fallback@example.test',true from preferred_route_artist a
where not exists (
  select 1 from public.artist_integrations i
  where i.artist_id=a.id and i.integration_type='email'
    and i.provider='google' and i.is_enabled
    and nullif(btrim(i.external_account_label),'') is not null
);

-- Meta approvals are simulated inside this rollback only.
update crm_private.lifecycle_whatsapp_template_registry t
set approval_status='APPROVED',provider_template_id='123456789012345',
    verified_at=now()
where t.artist_id=(select id from preferred_route_artist)
  and t.purpose<>'consultation_reminder';

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select public.service_set_lifecycle_whatsapp_delivery_enabled(
  (select id from preferred_route_artist),true)$$,
  'four tattoo templates suffice; consultation approval remains separate');
reset role;

insert into public.clients(id,full_name,email,phone,preferred_contact) values
 ('f9801111-1111-4111-8111-111111111111','WhatsApp Reject Fixture',
  'wa-reject@example.test','+447700901888','WhatsApp'),
 ('f9811111-1111-4111-8111-111111111111','WhatsApp Webhook Fixture',
  'wa-webhook@example.test','+447700901889','WhatsApp'),
 ('f9821111-1111-4111-8111-111111111111','WhatsApp Offline Fixture',
  'wa-offline@example.test','+447700901890','WhatsApp');

insert into public.projects(id,client_id,artist_id,title)
select v.pid::uuid,v.cid::uuid,a.id,'Fallback synthetic project'
from (values
 ('f9802222-2222-4222-8222-222222222222','f9801111-1111-4111-8111-111111111111'),
 ('f9812222-2222-4222-8222-222222222222','f9811111-1111-4111-8111-111111111111')
) v(pid,cid) cross join preferred_route_artist a;

insert into public.communication_conversations(
 id,artist_id,channel,integration_key,external_contact_id,client_id,
 link_state,state
) select v.id::uuid,a.id,'whatsapp','vladimir-production',
  v.contact,v.client::uuid,'linked','open'
from (values
 ('f9803333-3333-4333-8333-333333333333','447700901888','f9801111-1111-4111-8111-111111111111'),
 ('f9813333-3333-4333-8333-333333333333','447700901889','f9811111-1111-4111-8111-111111111111')
) v(id,contact,client) cross join preferred_route_artist a;

insert into public.communication_messages(
 id,conversation_id,artist_id,channel,direction,origin,status,
 message_type,body,provider_timestamp
) select v.id::uuid,v.conv::uuid,a.id,'whatsapp',
 'inbound','contact','received','text','Synthetic WhatsApp inbound',
 now()-interval '1 day'
from (values
 ('f9804444-4444-4444-8444-444444444444','f9803333-3333-4333-8333-333333333333'),
 ('f9814444-4444-4444-8444-444444444444','f9813333-3333-4333-8333-333333333333')
) v(id,conv) cross join preferred_route_artist a;

insert into public.sessions(
 id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at
) select v.sid::uuid,a.id,v.client::uuid,v.project::uuid,
  'tattoo_session','confirmed',
  date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days',
  date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days 4 hours'
from (values
 ('f9805555-5555-4555-8555-555555555555','f9801111-1111-4111-8111-111111111111','f9802222-2222-4222-8222-222222222222'),
 ('f9815555-5555-4555-8555-555555555555','f9811111-1111-4111-8111-111111111111','f9812222-2222-4222-8222-222222222222')
) v(sid,client,project) cross join preferred_route_artist a;

select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9805555-5555-4555-8555-555555555555','preferred_fallback_test'),
 'enrolled','terminal rejection fixture enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9815555-5555-4555-8555-555555555555','preferred_fallback_test'),
 'enrolled','failed webhook fixture enrolled');

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'future test jobs materialize without contacting providers');
reset role;

update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '71 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '75 hours 55 minutes'
where id='f9805555-5555-4555-8555-555555555555';
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '47 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '51 hours 55 minutes'
where id='f9815555-5555-4555-8555-555555555555';

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'two WhatsApp reminder payloads are queued with Meta approval');
reset role;

select is((select count(*)::integer from crm_private.lifecycle_whatsapp_payloads p
 where p.purpose='session_reminder_72h' and p.session_id in
 ('f9805555-5555-4555-8555-555555555555','f9815555-5555-4555-8555-555555555555')),
 2,'each separate session has one initial WhatsApp reminder');

create temporary table preferred_fallback_jobs as
select j.id AS job_id,j.session_id,o.id AS outbox_id
from public.automation_jobs j
join crm_private.lifecycle_whatsapp_payloads p on p.automation_job_id=j.id
join public.integration_outbox o on o.communication_message_id=p.communication_message_id
where j.session_id in ('f9805555-5555-4555-8555-555555555555',
                        'f9815555-5555-4555-8555-555555555555')
 and j.message_purpose='session_reminder_72h';
grant select on preferred_fallback_jobs to public;

-- Definite Graph HTTP rejection. Exhaust retries inside transaction only.
update public.integration_outbox set max_attempts=1
where id=(select outbox_id from preferred_fallback_jobs
          where session_id='f9805555-5555-4555-8555-555555555555');
set local role service_role;
select is((select count(*)::integer from public.claim_whatsapp_outbox_by_id(
 (select outbox_id from preferred_fallback_jobs where
  session_id='f9805555-5555-4555-8555-555555555555'), 'wa-fallback-worker',120)),
 1,'terminal Graph rejection job claimed');
select is((public.record_whatsapp_outbox_result(
 (select outbox_id from preferred_fallback_jobs where
  session_id='f9805555-5555-4555-8555-555555555555'),
 'wa-fallback-worker',false,null,'whatsapp_rejected')->>'status'),'dead',
 'definite Graph refusal recorded as terminal');
reset role;

select is((select reason from crm_private.lifecycle_email_fallbacks
 where job_id=(select job_id from preferred_fallback_jobs where
   session_id='f9805555-5555-4555-8555-555555555555')),
 'whatsapp_rejected','Meta denial authorizes one email fallback');
select is((select status::text from public.automation_jobs
 where id=(select job_id from preferred_fallback_jobs where
   session_id='f9805555-5555-4555-8555-555555555555')),
 'pending','same job is made pending for exactly one Email delivery');

-- Meta accepts send and later reports final FAILED, not delivered or read.
set local role service_role;
select is((select count(*)::integer from public.claim_whatsapp_outbox_by_id(
 (select outbox_id from preferred_fallback_jobs where
  session_id='f9815555-5555-4555-8555-555555555555'), 'wa-webhook-worker',120)),
 1,'accepted WhatsApp message leased');
select is((public.record_whatsapp_outbox_result(
 (select outbox_id from preferred_fallback_jobs where
  session_id='f9815555-5555-4555-8555-555555555555'),
 'wa-webhook-worker',true,'wamid.SYNTHETICWEBHOOK1',null)->>'status'),
 'succeeded','Meta accepted the synthetic message');
select is((public.record_whatsapp_message_status(
 (select id from preferred_route_artist),'vladimir-production',
 'wamid.SYNTHETICWEBHOOK1','failed',now())->>'status'),
 'failed','Meta signed delivery-failed status reaches CRM');
reset role;

select is((select reason from crm_private.lifecycle_email_fallbacks
 where job_id=(select job_id from preferred_fallback_jobs where
   session_id='f9815555-5555-4555-8555-555555555555')),
 'whatsapp_provider_failed','confirmed delivery failure authorizes Email');

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'requeued fallback jobs create Gmail outbox, not another WhatsApp send');
reset role;

select is((select count(*)::integer from public.email_messages m
 where m.client_id in ('f9801111-1111-4111-8111-111111111111',
                        'f9811111-1111-4111-8111-111111111111')),
 2,'one automated fallback email per failed WhatsApp');
select is((select count(*)::integer from public.integration_outbox o
 where o.kind='approved_email' and o.client_id in
 ('f9801111-1111-4111-8111-111111111111',
  'f9811111-1111-4111-8111-111111111111')),
 2,'each fallback is durably queued through Gmail outbox');
select ok((select bool_and(crm_private.lifecycle_delivery_snapshot_current(m.id))
 from public.email_messages m
 where m.client_id in ('f9801111-1111-4111-8111-111111111111',
                        'f9811111-1111-4111-8111-111111111111')),
 'pre-send snapshot allows authorized Email fallback without a new WhatsApp job');

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'repeated ticks preserve deduplication');
reset role;
select is((select count(*)::integer from public.email_messages m
 where m.client_id in ('f9801111-1111-4111-8111-111111111111',
                        'f9811111-1111-4111-8111-111111111111')),
 2,'no duplicate Gmail messages');

-- Absent linked WhatsApp conversation: prefer a verified Email reminder.
insert into public.sessions(
 id,artist_id,client_id,appointment_type,status,start_at,end_at
) select 'f9825555-5555-4555-8555-555555555555',a.id,
 'f9821111-1111-4111-8111-111111111111',
 'video_consultation','confirmed',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '7 days',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '7 days 30 minutes'
from preferred_route_artist a;
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9825555-5555-4555-8555-555555555555','preferred_fallback_test'),
 'enrolled','WhatsApp-unavailable video consultation enrolled sufficiently early');
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'initial future consultation reminder job materializes');
reset role;
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '24 hours 25 minutes'
where id='f9825555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'unsupported consultation WhatsApp route sends via fallback Gmail');
reset role;
select is((select reason from crm_private.lifecycle_email_fallbacks f
 join public.automation_jobs j on j.id=f.job_id where j.session_id=
 'f9825555-5555-4555-8555-555555555555'
 and j.message_purpose='consultation_reminder'),
 'whatsapp_unavailable','preflight records why Gmail was used');
select is((select count(*)::integer from public.email_messages m
 where m.client_id='f9821111-1111-4111-8111-111111111111'),1,
 'one video consultation reminder is queued via Gmail');

select * from finish();
rollback;
