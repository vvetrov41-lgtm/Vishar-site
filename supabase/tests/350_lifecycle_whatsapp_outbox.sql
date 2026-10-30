-- Synthetic WhatsApp-first client. All database writes rolled back.
-- No provider secrets or Meta network requests are used by pgTAP.
begin;
select no_plan();
create temporary table wa_lifecycle_artist as select id from public.artists
 where slug='vladimir';
grant select on wa_lifecycle_artist to public;
insert into public.clients(id,full_name,email,phone) values
 ('f9701111-1111-4111-8111-111111111111','Alex WhatsApp',
  'wa-lifecycle@example.test','+447700900888');
insert into public.projects(id,client_id,artist_id,title) values
 ('f9702222-2222-4222-8222-222222222222',
 'f9701111-1111-4111-8111-111111111111',
 (select id from wa_lifecycle_artist),'WhatsApp lifecycle integration');
-- Reuse the canonical integration; the schema permits one enabled WhatsApp
-- connection per artist. No separate fake provider account is created.
-- A clean CI database may not seed the real canonical route. Insert
-- a synthetic namespaced metadata-only route inside this rollback.
insert into public.artist_integrations(
 artist_id,integration_type,provider,integration_key,external_account_label,is_enabled)
select a.id,'whatsapp','meta_cloud_api','vladimir-production',
 'Synthetic lifecycle WhatsApp',true
from wa_lifecycle_artist a
where not exists (
 select 1 from public.artist_integrations i where i.artist_id=a.id
 and i.integration_type='whatsapp'
 and i.provider='meta_cloud_api' and i.integration_key='vladimir-production'
);
select ok(exists (
 select 1 from public.artist_integrations i
 where i.artist_id=(select id from wa_lifecycle_artist)
  and i.integration_type='whatsapp'
  and i.provider='meta_cloud_api'
  and i.integration_key='vladimir-production' and i.is_enabled
), 'canonical Vladimir WhatsApp route is present');
insert into public.communication_conversations(
 id,artist_id,channel,integration_key,external_contact_id,client_id,
 link_state,state)
select 'f9703333-3333-4333-8333-333333333333',id,
 'whatsapp','vladimir-production','447700900888',
 'f9701111-1111-4111-8111-111111111111','linked','open'
from wa_lifecycle_artist;
insert into public.communication_messages(
 id,conversation_id,artist_id,channel,direction,origin,status,
 message_type,body,provider_timestamp)
select 'f9704444-4444-4444-8444-444444444444',
 'f9703333-3333-4333-8333-333333333333',id,'whatsapp',
 'inbound','contact','received','text','Synthetic inbound',
 now()-interval '3 days' from wa_lifecycle_artist;
insert into public.sessions(
 id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
select 'f9705555-5555-4555-8555-555555555555',id,
 'f9701111-1111-4111-8111-111111111111',
 'f9702222-2222-4222-8222-222222222222',
 'tattoo_session','confirmed',
 date_trunc('hour',now())+interval '30 days',
 date_trunc('hour',now())+interval '30 days 4 hours'
from wa_lifecycle_artist;

-- Approval must come from a provider status readback, never from connecting
-- a number. This synthetic approval is transaction-local and rolled back.
update crm_private.lifecycle_whatsapp_template_registry
 set approval_status='APPROVED',provider_template_id='123456789012345',
     verified_at=now()
 where artist_id=(select id from wa_lifecycle_artist)
 and purpose='session_reminder_72h';
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9705555-5555-4555-8555-555555555555','wa_lifecycle_test'),
 'enrolled','WhatsApp-first session enrolled');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($select * from public.service_run_automation_tick(500)$,
 'initial future lifecycle jobs materialize');
reset role;
-- Preserve a valid booking at enrolment, then advance its reminder to
-- five minutes past the 72h due time before invoking the scheduler.
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '71 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '75 hours 55 minutes'
where id='f9705555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok($select * from public.service_run_automation_tick(500)$,
 'WhatsApp reminder materializes without sending an email');
reset role;
select is((select count(*)::integer from public.email_messages
 where client_id='f9701111-1111-4111-8111-111111111111'),0,
 'WhatsApp-first client receives no silent email');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_payloads
 where artist_id=(select id from wa_lifecycle_artist)
 and purpose='session_reminder_72h'),1,
 'one Meta Utility payload is queued');
select is((select count(*)::integer from public.integration_outbox
 where client_id='f9701111-1111-4111-8111-111111111111'
 and kind='whatsapp_message'),1,
 'one durable WhatsApp outbox item exists');
select is((select j.status::text from public.automation_jobs j
 join crm_private.lifecycle_whatsapp_payloads p on p.automation_job_id=j.id
 where p.purpose='session_reminder_72h'
 and j.session_id='f9705555-5555-4555-8555-555555555555'),
 'completed','queued job recorded exactly once');
create temporary table wa_lifecycle_outbox as
 select o.id from public.integration_outbox o
 where o.client_id='f9701111-1111-4111-8111-111111111111'
 and o.kind='whatsapp_message';
grant select on wa_lifecycle_outbox to public;
set local role service_role;
select is((select count(*)::integer from public.claim_whatsapp_outbox_by_id(
 (select id from wa_lifecycle_outbox),'wa-lifecycle-worker',120)),1,
 'the existing WhatsApp worker can lease the lifecycle job');
select ok((select delivery_allowed
 from public.service_resolve_whatsapp_lifecycle_payload(
 (select id from wa_lifecycle_outbox),'wa-lifecycle-worker')),
 'current block and approved template are deliverable at provider boundary');
reset role;
select is((select jsonb_array_length(body_parameters)
 from crm_private.lifecycle_whatsapp_payloads where session_id=
 'f9705555-5555-4555-8555-555555555555' and purpose='session_reminder_72h'),
 3,'72-hour message contains name, artist and grouped dates');

update public.sessions
 set start_at=date_trunc('hour',now())+interval '96 hours',
     end_at=date_trunc('hour',now())+interval '100 hours'
 where id='f9705555-5555-4555-8555-555555555555';
set local role service_role;
select ok((select not delivery_allowed
 from public.service_resolve_whatsapp_lifecycle_payload(
 (select id from wa_lifecycle_outbox),'wa-lifecycle-worker')),
 'rescheduling invalidates the leased Meta template before send intent');
reset role;
set local role service_role;
select is((public.record_whatsapp_outbox_result(
 (select id from wa_lifecycle_outbox),'wa-lifecycle-worker',
 false,null,'whatsapp_lifecycle_obsolete')->>'status'),'dead',
 'definitively obsolete Meta template is dead-lettered before send');
reset role;
select is((select count(*)::integer from public.automation_jobs
 where session_id='f9705555-5555-4555-8555-555555555555'
 and message_purpose='session_reminder_72h'),2,
 'one new reminder revision is issued after pre-send obsolete acknowledgement');
select is((select status::text from public.automation_jobs
 where session_id='f9705555-5555-4555-8555-555555555555'
 and message_purpose='session_reminder_72h' and lifecycle_revision=2),
 'pending','replacement WhatsApp job remains pending for the new date');
select is((select status::text from public.communication_messages m
 join crm_private.lifecycle_whatsapp_payloads p on p.communication_message_id=m.id
 join public.automation_jobs j on j.id=p.automation_job_id
 where j.session_id='f9705555-5555-4555-8555-555555555555'
 and j.message_purpose='session_reminder_72h' and j.lifecycle_revision=1),
 'failed','obsolete Meta message never appears delivered');

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'repeated scheduler tick does not duplicate WhatsApp replacement');
reset role;
select is((select count(*)::integer from public.automation_jobs
 where session_id='f9705555-5555-4555-8555-555555555555'
 and message_purpose='session_reminder_72h'),2,
 'one revision per definitive obsolete response');
select * from finish();
rollback;
