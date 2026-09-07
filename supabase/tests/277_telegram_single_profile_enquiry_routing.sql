-- 277_telegram_single_profile_enquiry_routing.sql
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(has_function_privilege('service_role',
  'public.service_route_telegram_enquiry_notification(uuid,text)', 'EXECUTE'),
  'backend may route a leased enquiry into personal notifications');
select ok(not has_function_privilege('authenticated',
  'public.service_route_telegram_enquiry_notification(uuid,text)', 'EXECUTE'),
  'browser cannot route Telegram enquiry jobs');
select ok(has_function_privilege('service_role',
  'public.service_recover_telegram_enquiry_outbox(uuid)', 'EXECUTE'),
  'backend has the bounded dead-job recovery primitive');
select ok(not has_function_privilege('authenticated',
  'public.service_recover_telegram_enquiry_outbox(uuid)', 'EXECUTE'),
  'browser cannot recover dead Telegram jobs');

insert into auth.users(id,email)
values ('f7770000-0000-4000-8000-000000000001','single-telegram@example.test');
insert into public.profiles(id,email,display_name,role,is_active)
values ('f7770000-0000-4000-8000-000000000001','single-telegram@example.test','Single Telegram Artist','artist',true);
insert into public.artist_memberships(
  profile_id,artist_id,access_level,can_view_finance,can_manage_finance,
  can_manage_sessions,can_manage_integrations,is_active
) values (
  'f7770000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'artist',false,false,true,true,true
);
insert into crm_private.telegram_destinations(
  id,destination_kind,profile_id,chat_id,chat_type,safe_label,is_active,connected_by_profile_id
) values (
  'f7771000-0000-4000-8000-000000000001','profile',
  'f7770000-0000-4000-8000-000000000001','7000001','private',
  'Telegram',true,'f7770000-0000-4000-8000-000000000001'
);
insert into public.notification_preferences(profile_id,channel,is_enabled)
values ('f7770000-0000-4000-8000-000000000001','telegram',true);

insert into public.clients(id,full_name,email,email_normalized)
values ('f7772000-0000-4000-8000-000000000001','Test Client','single-client@example.test','single-client@example.test');
insert into public.enquiries(
  id,client_id,idempotency_key,intake_fingerprint,status,intake_state,
  submitted_full_name,submitted_email,privacy_notice_version,privacy_acknowledged_at,
  artist_id
) values (
  'f7773000-0000-4000-8000-000000000001',
  'f7772000-0000-4000-8000-000000000001',
  'f7774000-0000-4000-8000-000000000001',
  repeat('a',64),'new','complete','Test Client','single-client@example.test',
  '2026-07-29',now(),'a1111111-1111-4111-8111-111111111111'
);
insert into public.enquiry_files(
  id,enquiry_id,ordinal,storage_path,mime_type,safe_extension,byte_size,upload_state,uploaded_at
) values (
  'f7775000-0000-4000-8000-000000000001',
  'f7773000-0000-4000-8000-000000000001',
  0,
  'clients/f7772000-0000-4000-8000-000000000001/enquiries/f7773000-0000-4000-8000-000000000001/references/f7775000-0000-4000-8000-000000000001.png',
  'image/png','png',4096,'ready',now()
);
insert into public.integration_outbox(
  id,kind,dedupe_key,status,payload,client_id,enquiry_id,artist_id,
  attempt_count,max_attempts,next_attempt_at,leased_by,leased_at,lease_expires_at
) values (
  'f7776000-0000-4000-8000-000000000001','telegram_notification',
  'telegram:enquiry_created:f7773000-0000-4000-8000-000000000001',
  'leased','{"reference_number":"ENQ-2026-7777","file_count":1}'::jsonb,
  'f7772000-0000-4000-8000-000000000001',
  'f7773000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  0,8,now(),'telegram-test-worker',now(),now()+interval '2 minutes'
);

set local role service_role;
select is(
  (public.service_route_telegram_enquiry_notification(
    'f7776000-0000-4000-8000-000000000001','telegram-test-worker'
  )->>'routed')::boolean,
  true,
  'leased enquiry routes to the artist profile notification'
);
select is(
  (select count(*)::int from public.notifications
   where entity_id='f7773000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  1,
  'routing creates exactly one personal notification'
);
select is(
  (public.service_route_telegram_enquiry_notification(
    'f7776000-0000-4000-8000-000000000001','telegram-test-worker'
  )->>'notification_count')::int,
  1,
  'routing replay is idempotent'
);

create temporary table single_delivery as
select * from public.service_claim_telegram_notifications('telegram-personal-test',20,120);
select is((select count(*)::int from single_delivery),1,
  'the existing personal queue claims the enquiry notification');
select lives_ok(
  $$select public.service_record_telegram_notification_result(
    (select delivery_id from single_delivery),'telegram-personal-test',true,null)$$,
  'the personal queue records provider success'
);
reset role;
select is(
  (select status from crm_private.telegram_notification_deliveries
   where notification_id=(select id from public.notifications
     where entity_id='f7773000-0000-4000-8000-000000000001')),
  'succeeded',
  'delivery readback reaches succeeded'
);
select ok(
  (select last_success_at is not null from crm_private.telegram_destinations
   where id='f7771000-0000-4000-8000-000000000001'),
  'profile destination records last_success_at'
);

insert into public.integration_outbox(
  id,kind,dedupe_key,status,payload,client_id,enquiry_id,artist_id,
  attempt_count,max_attempts,next_attempt_at,last_error_code
) values (
  'f7776000-0000-4000-8000-000000000002','telegram_notification',
  'telegram:enquiry_created:f7773000-0000-4000-8000-000000000002',
  'dead','{}'::jsonb,
  'f7772000-0000-4000-8000-000000000001',
  'f7773000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  8,8,now(),'telegram_destination_unavailable'
);
set local role service_role;
select is(
  (public.service_recover_telegram_enquiry_outbox(
    'f7776000-0000-4000-8000-000000000002'
  )->>'recovered')::boolean,
  false,
  'recovery refuses a job whose enquiry already has delivery evidence'
);
reset role;
select is(
  (select status from public.integration_outbox
   where id='f7776000-0000-4000-8000-000000000002'),
  'dead',
  'unsafe recovery leaves the dead job unchanged'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f7770000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok(
  $$select public.service_recover_telegram_enquiry_outbox(
    'f7776000-0000-4000-8000-000000000002')$$,
  '42501',null,
  'authenticated user cannot run operator recovery'
);

select * from finish();
rollback;
