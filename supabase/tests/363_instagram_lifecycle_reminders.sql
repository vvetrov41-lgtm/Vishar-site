-- Every fixture is inside this transaction. No Meta or Email request occurs.
begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

select public.service_set_instagram_integration(
 'a1111111-1111-4111-8111-111111111111','vladimir-instagram','17841400000000001',
 'vladimir.synthetic',array['instagram_business_basic','instagram_business_manage_messages']);
update crm_private.booking_card_artist_settings
set instagram_enabled=true,email_enabled=true,whatsapp_enabled=false,
    appointment_start_from=null,
    client_action_base_url='https://booking.vishartattoo.com/appointments/respond/',
    studio_name='Label Tattoo Private',
    studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP',
    studio_map_url='https://maps.app.goo.gl/fixture123'
where artist_id='a1111111-1111-4111-8111-111111111111';

insert into public.clients(id,full_name,email,phone,preferred_contact) values
 ('f98a1111-1111-4111-8111-111111111111','Instagram Open','ig-open@example.test',null,'Instagram'),
 ('f98b1111-1111-4111-8111-111111111111','Instagram Closed','ig-closed@example.test',null,'Instagram');

select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009101',
 'ig_mid_LIFECYCLE000101',now()-interval '30 minutes','text','Hi', '[]'::jsonb,null);
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009102',
 'ig_mid_LIFECYCLE000102',now()-interval '3 days','text','Hi', '[]'::jsonb,null);
update public.communication_conversations c
set client_id=v.cid::uuid,link_state='linked'
from (values
 ('900000009101','f98a1111-1111-4111-8111-111111111111'),
 ('900000009102','f98b1111-1111-4111-8111-111111111111')
) v(ext,cid)
where c.channel='instagram' and c.artist_id='a1111111-1111-4111-8111-111111111111'
  and c.external_contact_id=v.ext;

insert into public.sessions(id,artist_id,client_id,appointment_type,status,start_at,end_at)
select v.sid::uuid,'a1111111-1111-4111-8111-111111111111',v.cid::uuid,
 'tattoo_session','confirmed',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days 4 hours'
from (values
 ('f98a5555-5555-4555-8555-555555555555','f98a1111-1111-4111-8111-111111111111'),
 ('f98b5555-5555-4555-8555-555555555555','f98b1111-1111-4111-8111-111111111111')
) v(sid,cid);
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f98a5555-5555-4555-8555-555555555555','instagram_lifecycle_test'),
 'enrolled','fresh Instagram-preferred tattoo session enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f98b5555-5555-4555-8555-555555555555','instagram_lifecycle_test'),
 'enrolled','closed-window fallback session enrolled');

set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'initial future jobs prepared without contacting external providers');
reset role;
update public.sessions set
 start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '23 hours 55 minutes',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '27 hours 55 minutes'
where id IN ('f98a5555-5555-4555-8555-555555555555',
             'f98b5555-5555-4555-8555-555555555555');
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'scheduled 24h reminders select Instagram if eligible and Email otherwise');
reset role;

select is((select count(*)::integer from crm_private.lifecycle_instagram_payloads p
 where p.session_id='f98a5555-5555-4555-8555-555555555555'
 and p.purpose='session_reminder_24h'),1,
 'open Instagram window yields exactly one reminder');
select is((select count(*)::integer from crm_private.lifecycle_instagram_payloads p
 where p.session_id='f98b5555-5555-4555-8555-555555555555'),0,
 'closed Instagram window never creates a provider payload');
select is((select reason from crm_private.lifecycle_instagram_email_fallbacks f
 join public.automation_jobs j on j.id=f.job_id
 where j.session_id='f98b5555-5555-4555-8555-555555555555'
 and j.message_purpose='session_reminder_24h'),
 'instagram_unavailable','closed window is explicitly recorded for Email');
select is((select count(*)::integer from public.email_messages m
 where m.client_id='f98b1111-1111-4111-8111-111111111111'),1,
 'closed Instagram window produces one Gmail reminder');

select ok((select p.message_text LIKE '%Google Maps: https://maps.app.goo.gl/fixture123%'
   AND p.message_text LIKE '%Confirm: https://booking.%'
   AND p.message_text LIKE '%Reschedule: https://booking.%'
   AND p.message_text LIKE '%Cancel: https://booking.%'
   AND p.confirm_payload~'^booking_action:[0-9a-f]{64}$'
   AND p.reschedule_payload~'^booking_action:[0-9a-f]{64}$'
   AND p.cancel_payload~'^booking_action:[0-9a-f]{64}$'
   AND octet_length(convert_to(p.message_text,'UTF8'))<=1000
 from crm_private.lifecycle_instagram_payloads p
 where p.session_id='f98a5555-5555-4555-8555-555555555555'
 and p.purpose='session_reminder_24h'),
 'Instagram 24h reminder has current studio map and all three actions');

-- Pre-send gate uses authoritative lease, session, conversation and inbound age.
update public.integration_outbox
 set status='leased',leased_by='ig-lifecycle-test',
 leased_at=now(),lease_expires_at=now()+interval '3 minutes'
 where dedupe_key IN (
 select 'instagram:lifecycle:'||p.automation_job_id::text
 from crm_private.lifecycle_instagram_payloads p
 where p.session_id='f98a5555-5555-4555-8555-555555555555');
select is((select r.delivery_allowed::text
 from public.integration_outbox o
 cross join lateral public.service_resolve_instagram_lifecycle_payload(o.id,'ig-lifecycle-test') r
 where o.dedupe_key LIKE 'instagram:lifecycle:%'), 'true',
 'leased current Instagram reminder is allowed before Meta window closes');

-- Expire the inbound window before provider call. No DM may leave the worker.
update public.communication_conversations set last_inbound_at=now()-interval '2 days'
where artist_id='a1111111-1111-4111-8111-111111111111'
 and external_contact_id='900000009101' and channel='instagram';
select is((select r.delivery_allowed::text
 from public.integration_outbox o
 cross join lateral public.service_resolve_instagram_lifecycle_payload(o.id,'ig-lifecycle-test') r
 where o.dedupe_key LIKE 'instagram:lifecycle:%'), 'false',
 'closed window is blocked at pre-send, not just at enqueue');

set local role service_role;
select lives_ok($$select public.record_communication_outbox_result(
  o.id,'ig-lifecycle-test',false,null,'instagram_lifecycle_window_closed')
  from public.integration_outbox o where o.dedupe_key LIKE 'instagram:lifecycle:%'$$,
 'definitively unsent Instagram reminder is recorded');
reset role;
select is((select f.reason from crm_private.lifecycle_instagram_email_fallbacks f
 join public.automation_jobs j on j.id=f.job_id
 where j.session_id='f98a5555-5555-4555-8555-555555555555'
 and j.message_purpose='session_reminder_24h'),
 'instagram_rejected','pre-send closed window releases one safe email fallback');
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'same automation job resumes on Gmail without sending another Instagram DM');
reset role;
select is((select count(*)::integer from public.email_messages
 where client_id='f98a1111-1111-4111-8111-111111111111'),1,
 'exactly one fallback Email is queued');
select is((select count(*)::integer from crm_private.lifecycle_instagram_payloads p
 where p.session_id='f98a5555-5555-4555-8555-555555555555'),1,
 'original Instagram send intent is never duplicated');
set local role service_role;
select lives_ok('select * from public.service_run_automation_tick(500)',
 'repeat ticks do not recreate Gmail or Instagram messages');
reset role;
select is((select count(*)::integer from public.email_messages
 where client_id='f98a1111-1111-4111-8111-111111111111'),1,
 'email fallback is idempotent');

select * from finish();
rollback;
