-- Scheduler integration: non-anchor jobs remain pending and do not enqueue an email.
begin;
select no_plan();
create temporary table block_artist as select a.id from public.artists a join crm_private.artist_state s on s.artist_id=a.id and s.is_active where a.slug='vladimir';
grant select on block_artist to public;
insert into public.clients (id,full_name,email) values ('f9511111-1111-4111-8111-111111111111','Lifecycle block test','lifecycle-block@example.test');
insert into public.projects (id,client_id,artist_id,title) values ('f9522222-2222-4222-8222-222222222222','f9511111-1111-4111-8111-111111111111',(select id from block_artist),'Lifecycle block test');
insert into public.sessions (id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
select v.id,(select id from block_artist),'f9511111-1111-4111-8111-111111111111','f9522222-2222-4222-8222-222222222222','tattoo_session','confirmed',v.at,v.at+interval '4 hours'
from (values
 ('f9500000-0000-4000-8000-000000000001'::uuid, date_trunc('day',now())+interval '30 days 12 hours'),
 ('f9500000-0000-4000-8000-000000000002'::uuid, date_trunc('day',now())+interval '31 days 12 hours')
) v(id,at);
select is(crm_private.enrol_booked_session_in_lifecycle('f9500000-0000-4000-8000-000000000001','block_test'),'enrolled','first booked day enrolled');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select public.service_set_gmail_integration(
 (select id from block_artist),'google_gmail_block_test','block-artist@example.test',
 array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']::text[]
)$$,'synthetic Gmail route');
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'jobs materialise');
reset role;
select is((select count(*)::int from public.automation_events where entity_id='f9500000-0000-4000-8000-000000000002' and event_type='appointment.scheduled'),1,'missing future appointment is enrolled exactly once');


-- Make both 72-hour reminders due while preserving consecutive local days.
update public.sessions set start_at=start_at-interval '29 days', end_at=end_at-interval '29 days'
where project_id='f9522222-2222-4222-8222-222222222222';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'due jobs are processed');
select is((select count(*)::int from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id
 where j.session_id='f9500000-0000-4000-8000-000000000001' and j.message_purpose='session_reminder_72h'
 and m.body like '%Your appointment dates:%' and m.body like '%calculated separately for each appointment date%'),1,
 'one reminder lists the dates and the per-date cancellation window');
select is((select status::text from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h'),'pending','non-anchor reminder is kept for potential later split');
select is((select count(*)::int from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id where j.session_id='f9500000-0000-4000-8000-000000000002' and j.message_purpose='session_reminder_72h'),0,'second-day reminder does not queue an email');
select is(crm_private.execute_client_lifecycle_job((select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h')),'pending','executor independently rejects a non-anchor even when called directly');
select ok(crm_private.lifecycle_delivery_snapshot_current((select m.id from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id where j.session_id='f9500000-0000-4000-8000-000000000001' and j.message_purpose='session_reminder_72h')),'unchanged reminder remains deliverable');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temporary table block_delivery as
select c.outbox_id from public.claim_email_outbox('lifecycle-block-suite',20,120) c
join public.email_messages m on m.id=c.email_message_id
join public.automation_jobs j on j.id=m.automation_job_id
where j.session_id='f9500000-0000-4000-8000-000000000001'
  and j.message_purpose='session_reminder_72h';
select is((select count(*)::int from block_delivery),1,'the block reminder reaches a leased Gmail outbox item');
select ok((select delivery_allowed from public.service_resolve_gmail_outbox_target(
 (select outbox_id from block_delivery),'lifecycle-block-suite')),
 'the unchanged block reminder is permitted at the provider boundary');
-- Moving the second day out of the block makes it the anchor of a new
-- block, but the old due timestamp must not trigger an early message.
update public.sessions set start_at=start_at+interval '10 days',end_at=end_at+interval '10 days'
where id='f9500000-0000-4000-8000-000000000002';
select ok(not crm_private.lifecycle_delivery_snapshot_current((select m.id from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id where j.session_id='f9500000-0000-4000-8000-000000000001' and j.message_purpose='session_reminder_72h')),'queued reminder is no longer deliverable after a block member is moved');
select ok((select not delivery_allowed from public.service_resolve_gmail_outbox_target(
 (select outbox_id from block_delivery),'lifecycle-block-suite')),
 'the leased Gmail reminder is refused after another block day moves');
select is((select configuration->>'lifecycle_email' from public.service_resolve_gmail_outbox_target(
 (select outbox_id from block_delivery),'lifecycle-block-suite')),'true',
 'the Gmail worker receives a scoped lifecycle obsolete reason');
select is((public.record_email_outbox_result(
 (select outbox_id from block_delivery),'lifecycle-block-suite',false,null,
 'gmail_lifecycle_email_obsolete')->>'status'),'dead',
 'a stale lifecycle message is terminal, without repeated provider attempts');
select is((select m.status::text from public.email_messages m join public.integration_outbox o
 on o.email_message_id=m.id where o.id=(select outbox_id from block_delivery)),
 'cancelled','the withdrawn email is recorded as cancelled rather than sent');
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h'),'eligible','moved session is a new block anchor');
select is(crm_private.execute_client_lifecycle_job((select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h')),'pending','executor refuses obsolete due time after move');
-- Both real dates have ended: only the last check-in is sent and it
-- carries the artist's approved aftercare link. The transaction rolls back.
update public.sessions set status='completed',start_at=date_trunc('day',now())-interval '3 days'+interval '12 hours',end_at=date_trunc('day',now())-interval '3 days'+interval '16 hours' where id='f9500000-0000-4000-8000-000000000001';
update public.sessions set status='completed',start_at=date_trunc('day',now())-interval '2 days'+interval '12 hours',end_at=date_trunc('day',now())-interval '2 days'+interval '16 hours' where id='f9500000-0000-4000-8000-000000000002';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'aftercare and final check-in run');
reset role;
select is((select count(*)::integer from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id
 where m.client_id='f9511111-1111-4111-8111-111111111111' and j.message_purpose='post_session_checkin'
 and j.session_id='f9500000-0000-4000-8000-000000000002' and m.body like '%https://vishartattoo.com/aftercare/%'),1,
 'final check-in includes the artist aftercare link');
select is((select count(*)::integer from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id
 where m.client_id='f9511111-1111-4111-8111-111111111111' and j.message_purpose='post_session_checkin'),1,
 'only one check-in is queued for the block');
select ok(not has_function_privilege('authenticated','crm_private.lifecycle_delivery_snapshot_current(uuid)','execute') and not has_function_privilege('service_role','crm_private.lifecycle_delivery_snapshot_current(uuid)','execute'),'delivery revalidation remains private');
update public.automation_jobs set status='failed',last_error_category='destination_unavailable'
where session_id='f9500000-0000-4000-8000-000000000002'
  and message_purpose='post_session_aftercare' and status='pending';
select is((select count(*)::int from public.notifications n where n.dedupe_key like
 'lifecycle_destination:' || (select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='post_session_aftercare')::text || ':%'),
 (select count(*)::int from crm_private.automation_notification_recipients((select id from block_artist))),
 'one unavailable destination alerts each authorized artist recipient');
update public.automation_jobs set last_error_category='destination_unavailable'
where session_id='f9500000-0000-4000-8000-000000000002'
  and message_purpose='post_session_aftercare' and status='failed';
select is((select count(*)::int from public.notifications n where n.dedupe_key like
 'lifecycle_destination:' || (select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='post_session_aftercare')::text || ':%'),
 (select count(*)::int from crm_private.automation_notification_recipients((select id from block_artist))),
 'retrying a failed job does not duplicate the alert');

-- The latest conversation can be WhatsApp even when the client has an email.
-- An email-only lifecycle rule must fail with an artist alert, not silently
-- switch the client to Gmail while utility templates are unavailable.
insert into public.clients(id,full_name,email,phone) values
 ('f9533333-3333-4333-8333-333333333333','WhatsApp lifecycle test',
  'whatsapp-lifecycle@example.test','+447700900888');
insert into public.projects(id,client_id,artist_id,title) values
 ('f9544444-4444-4444-8444-444444444444',
  'f9533333-3333-4333-8333-333333333333',(select id from block_artist),'WhatsApp lifecycle test');
insert into public.communication_conversations(
 id,artist_id,channel,integration_key,external_contact_id,client_id,link_state,state
) values ('f9555555-5555-4555-8555-555555555555',(select id from block_artist),
 'whatsapp','vladimir-production','447700900888',
 'f9533333-3333-4333-8333-333333333333','linked','open');
insert into public.communication_messages(
 id,conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp
) values ('f9566666-6666-4666-8666-666666666666',
 'f9555555-5555-4555-8555-555555555555',(select id from block_artist),
 'whatsapp','inbound','contact','received','text','Synthetic inbound',now()-interval '2 days');
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
values ('f9577777-7777-4777-8777-777777777777',(select id from block_artist),
 'f9533333-3333-4333-8333-333333333333','f9544444-4444-4444-8444-444444444444',
 'tattoo_session','confirmed',date_trunc('hour',now())+interval '30 days',date_trunc('hour',now())+interval '30 days 4 hours');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9577777-7777-4777-8777-777777777777','block_test'),'enrolled',
 'WhatsApp-conversation appointment has a scheduled event');
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'WhatsApp-conversation appointment has lifecycle jobs');
reset role;
update public.sessions set start_at=date_trunc('hour',now())+interval '48 hours',end_at=date_trunc('hour',now())+interval '52 hours'
where id='f9577777-7777-4777-8777-777777777777';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'due WhatsApp-conversation job is checked without sending Gmail');
reset role;
select is((select status::text from public.automation_jobs
 where session_id='f9577777-7777-4777-8777-777777777777'
 and message_purpose='session_reminder_72h'),'failed',
 'the email-only reminder refuses a WhatsApp-first conversation');
select is((select count(*)::int from public.email_messages
 where client_id='f9533333-3333-4333-8333-333333333333'),0,
 'a WhatsApp-first client is not silently emailed');
select cmp_ok((select count(*)::int from public.notifications n
 join public.automation_jobs j on n.dedupe_key like 'lifecycle_destination:'||j.id::text||':%'
 where j.session_id='f9577777-7777-4777-8777-777777777777'),'>',0,
 'the artist receives an actionable single-job route alert');
select * from finish();
rollback;
