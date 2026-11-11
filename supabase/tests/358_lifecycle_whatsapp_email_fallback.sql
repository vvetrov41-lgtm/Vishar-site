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
    verified_at=now(),
    template_name=case t.purpose
      when 'session_reminder_72h' then 'vishar_lifecycle_reminder_72h_v3'
      when 'session_reminder_24h' then 'vishar_lifecycle_reminder_24h_v3'
      when 'post_session_aftercare' then 'vishar_lifecycle_aftercare_v2'
      when 'post_session_checkin' then 'vishar_lifecycle_checkin_v2'
      else t.template_name end
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

-- Maps stays inside the approved fourth body parameter, with no new Meta
-- placeholders. The fixtures are synthetic and the outer transaction rolls back.
select is(crm_private.lifecycle_whatsapp_location_with_map(
 'Studio A',null),'Studio A','missing Maps URL leaves the street address intact');
select is(crm_private.lifecycle_whatsapp_location_with_map(
 'Studio A','https://example.com/unsafe'),'Studio A',
 'non-Google link is not added to an appointment');
select is(crm_private.lifecycle_whatsapp_location_with_map(
 'Studio A','https://maps.app.goo.gl/fixture123'),
 E'Studio A | Google Maps: https://maps.app.goo.gl/fixture123',
 'approved Google Maps domain is appended as a single address parameter');
select is(crm_private.lifecycle_whatsapp_location_with_map(
 E'  Studio  A\nRoom\t B  ','https://maps.app.goo.gl/fixture123'),
 'Studio A Room B | Google Maps: https://maps.app.goo.gl/fixture123',
 'Meta template variables have no newlines, tabs, or repeated spaces');
select is(crm_private.lifecycle_whatsapp_location_with_map(
 'Studio A','https://maps.app.goo.gl/'||repeat('x',1010)),
 'Studio A','overlong template parameter falls back to the original address');
select is(crm_private.lifecycle_whatsapp_confirmation_url(
 'https://booking.vishartattoo.com/appointments/respond/',repeat('a',64)),
 'https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64),
 'valid booking confirmation token is converted into an owned HTTPS URL');
select is(crm_private.lifecycle_whatsapp_confirmation_url(
 'https://other.example/appointments/respond/',repeat('a',64)),
 null::text,'untrusted confirmation destination fails closed');

insert into crm_private.booking_card_artist_settings(
 artist_id,studio_name,studio_address,studio_map_url,
 client_action_base_url,appointment_start_from
) select a.id,'Label Tattoo Private',
 '16 Exhibition House, Addison Bridge Place, London W14 8XP',
 'https://maps.app.goo.gl/fixture123',
 'https://booking.vishartattoo.com/appointments/respond/',null
from preferred_route_artist a
on conflict (artist_id) do update set
 studio_name=excluded.studio_name,
 studio_address=excluded.studio_address,
 studio_map_url=excluded.studio_map_url,
 client_action_base_url=excluded.client_action_base_url,
 appointment_start_from=null;

-- The already-enrolled tattoo fixture advances into its 24-hour reminder.
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '27 hours 55 minutes'
where id='f9805555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 '24-hour WhatsApp reminder with map link queues without provider requests');
reset role;
select ok((select (p.body_parameters->>1) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9805555-5555-4555-8555-555555555555'
   and p.purpose='session_reminder_24h' limit 1),
 '24-hour first-person reminder carries session start time');
select is((select jsonb_array_length(p.body_parameters) from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9805555-5555-4555-8555-555555555555'
   and p.purpose='session_reminder_24h' limit 1),3,
 'reviewed 24-hour card has first name, time and one booking action');
select ok((select (p.body_parameters->>2) ~ '^booking_action:[0-9a-f]{64}$'
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9805555-5555-4555-8555-555555555555'
   and p.purpose='session_reminder_24h' limit 1),
 '24-hour card exposes only a single-use reschedule capability');

-- New linked client: in-person consultation gets Maps without changing
-- the five-parameter Meta consultation template.
update crm_private.lifecycle_whatsapp_template_registry t
set approval_status='APPROVED',provider_template_id='999888777666555',verified_at=now(),
    template_name='vishar_lifecycle_consultation_v4'
where t.artist_id=(select id from preferred_route_artist)
  and t.purpose='consultation_reminder';
insert into public.clients(id,full_name,email,phone,preferred_contact)
values('f9831111-1111-4111-8111-111111111111','Consult Maps Fixture',
 'consult-maps@example.test','+447700901891','WhatsApp');
insert into public.communication_conversations(
 id,artist_id,channel,integration_key,external_contact_id,client_id,link_state,state
) select 'f9833333-3333-4333-8333-333333333333',a.id,
 'whatsapp','vladimir-production','447700901891',
 'f9831111-1111-4111-8111-111111111111','linked','open'
from preferred_route_artist a;
insert into public.sessions(
 id,artist_id,client_id,appointment_type,status,start_at,end_at
) select 'f9835555-5555-4555-8555-555555555555',a.id,
 'f9831111-1111-4111-8111-111111111111',
 'in_person_consultation','confirmed',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '9 days',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '9 days 30 minutes'
from preferred_route_artist a;
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9835555-5555-4555-8555-555555555555','maps_consultation_test'),
 'enrolled','in-person consultation enrolled with approved Meta template');
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'future consultation job is materialized without contacting Meta');
reset role;
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 5 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 35 minutes'
where id='f9835555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'in-person consultation WhatsApp reminder with Maps queued');
reset role;
select ok((select (p.body_parameters->>2) LIKE '%Google Maps: https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic'
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
 and p.purpose='consultation_reminder' limit 1),
 'first-person consultation variable three contains the configured Maps link');
select is((select jsonb_array_length(p.body_parameters) from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
 and p.purpose='consultation_reminder' limit 1),5,
 'approved consultation Meta template keeps exactly five variables');
select ok((select (p.body_parameters->>2) LIKE 'Label Tattoo Kensington, Unit B, York House, Avonmore Place%'
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
 and p.purpose='consultation_reminder' limit 1),
 'consultations use York House, not tattoo-session Exhibition House');
select is((select p.body_parameters->>2 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),
 (select crm_private.lifecycle_whatsapp_location_with_map(
   concat_ws(', ', l.studio_name,l.studio_address),l.studio_map_url)
  from crm_private.consultation_email_location() l),
 'in-person WhatsApp and Gmail consultations resolve exactly the same current studio');
select is((select position(chr(10) in p.body_parameters->>2)
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),0,
 'consultation Google Maps Meta parameter remains single line');
select ok((select
 (p.body_parameters->>3) ~ '^booking_action:[0-9a-f]{64}$'
 and (p.body_parameters->>4) ~ '^booking_action:[0-9a-f]{64}$'
 and (p.body_parameters->>3) <> (p.body_parameters->>4)
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9835555-5555-4555-8555-555555555555'
 and p.purpose='consultation_reminder' limit 1),
 'consultation confirmation and reschedule buttons have distinct one-use actions');


-- The v3 reminder uses two real one-time appointment capabilities, not
-- decorative buttons or an unrelated website URL. Synthetic records below
-- exist ONLY inside this rollback transaction.
update crm_private.lifecycle_whatsapp_template_registry
set template_name='vishar_lifecycle_consultation_v3',
    approval_status='APPROVED', provider_template_id='999888777666556',
    verified_at=now()
where artist_id=(select id from preferred_route_artist)
  and purpose='consultation_reminder';

insert into public.clients(id,full_name,email,phone,preferred_contact) values
 ('f9841111-1111-4111-8111-111111111111','Consult Button Fixture',
  'consult-buttons@example.test','+447700901892','WhatsApp');
insert into public.communication_conversations(
 id,artist_id,channel,integration_key,external_contact_id,client_id,link_state,state
) select 'f9843333-3333-4333-8333-333333333333',a.id,
 'whatsapp','vladimir-production','447700901892',
 'f9841111-1111-4111-8111-111111111111','linked','open'
from preferred_route_artist a;
insert into public.sessions(
 id,artist_id,client_id,appointment_type,status,start_at,end_at
) select 'f9845555-5555-4555-8555-555555555555',a.id,
 'f9841111-1111-4111-8111-111111111111',
 'in_person_consultation','confirmed',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '9 days',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '9 days 30 minutes'
from preferred_route_artist a;
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9845555-5555-4555-8555-555555555555','v3_consultation_button_fixture'),
 'enrolled','v3 consultation enrolled without a real provider send');
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'future v3 consultation job materializes');
reset role;
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 5 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 35 minutes'
where id='f9845555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'v3 consultation reminder queues its card and capabilities');
reset role;

select is((select p.template_name from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9845555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),
 'vishar_lifecycle_consultation_v3','actual outgoing template identity is v3');
select is((select jsonb_array_length(p.body_parameters)
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9845555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),5,
 'three body variables and two private button tokens are stored');
select is((select p.body_parameters->>0 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9845555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),'Consult',
 'first body variable is the client name, not the artist introduction');
select ok((select p.body_parameters->>2 like '%Google Maps: https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6%'
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9845555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),
 'third visible parameter contains the current studio map');
select ok((select
 (p.body_parameters->>3) ~ '^booking_action:[0-9a-f]{64}'
 and (p.body_parameters->>4) ~ '^booking_action:[0-9a-f]{64}'
 and char_length(p.body_parameters->>3)=79
 and char_length(p.body_parameters->>4)=79
 and (p.body_parameters->>3) <> (p.body_parameters->>4)
 from crm_private.lifecycle_whatsapp_payloads p
 where p.session_id='f9845555-5555-4555-8555-555555555555'
   and p.purpose='consultation_reminder' limit 1),
 'both buttons carry unique valid one-use booking action payloads');

create temporary table v3_button_fixture as
select p.body_parameters->>3 as confirm_payload,
       p.body_parameters->>4 as reschedule_payload
from crm_private.lifecycle_whatsapp_payloads p
where p.session_id='f9845555-5555-4555-8555-555555555555'
  and p.purpose='consultation_reminder';
grant select on v3_button_fixture to public;
select is((select count(*)::integer
 from crm_private.appointment_client_action_tokens t
 cross join v3_button_fixture f
 where t.session_id='f9845555-5555-4555-8555-555555555555'
   and t.action='confirm_attendance'
   and t.token_hash=encode(extensions.digest(substring(f.confirm_payload from 16),'sha256'),'hex')),
 1,'confirm quick reply resolves to a real appointment capability');
select is((select count(*)::integer
 from crm_private.appointment_client_action_tokens t
 cross join v3_button_fixture f
 where t.session_id='f9845555-5555-4555-8555-555555555555'
   and t.action='request_reschedule'
   and t.token_hash=encode(extensions.digest(substring(f.reschedule_payload from 16),'sha256'),'hex')),
 1,'reschedule quick reply resolves to a real appointment capability');

set local role service_role;
select is((select (public.service_apply_whatsapp_booking_card_action(
 (select id from preferred_route_artist),
 'vladimir-production','447700901892','wamid.SYNTHETICV3CONFIRM001',
 now(),f.confirm_payload)->>'applied')::boolean from v3_button_fixture f),
 true,'signed v3 WhatsApp button changes attendance via existing webhook RPC');
reset role;
select is((select client_response::text from public.sessions
 where id='f9845555-5555-4555-8555-555555555555'),
 'attendance_confirmed','quick reply actually records client confirmation');

select * from finish();
rollback;
