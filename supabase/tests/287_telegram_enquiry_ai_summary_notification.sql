-- 287_telegram_enquiry_ai_summary_notification.sql
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users(id,email)
values ('f7870000-0000-4000-8000-000000000001','ai-summary-telegram@example.test');
insert into public.profiles(id,email,display_name,role,is_active)
values ('f7870000-0000-4000-8000-000000000001','ai-summary-telegram@example.test','AI Summary Telegram Artist','owner',true);
insert into public.artist_memberships(
  profile_id,artist_id,access_level,can_view_finance,can_manage_finance,
  can_manage_sessions,can_manage_integrations,is_active
) values (
  'f7870000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'artist',false,false,true,true,true
)
on conflict (profile_id,artist_id) do update
set access_level = excluded.access_level,
    can_view_finance = excluded.can_view_finance,
    can_manage_finance = excluded.can_manage_finance,
    can_manage_sessions = excluded.can_manage_sessions,
    can_manage_integrations = excluded.can_manage_integrations,
    is_active = excluded.is_active;

insert into crm_private.telegram_destinations(
  id,destination_kind,profile_id,chat_id,chat_type,safe_label,is_active,connected_by_profile_id
) values (
  'f7871000-0000-4000-8000-000000000001','profile',
  'f7870000-0000-4000-8000-000000000001','7000787','private',
  'Telegram',true,'f7870000-0000-4000-8000-000000000001'
);
insert into public.notification_preferences(profile_id,channel,is_enabled)
values ('f7870000-0000-4000-8000-000000000001','telegram',true);

update crm_private.crm_agent_config
set enabled = true
where singleton;

insert into public.clients(id,workspace_id,full_name,email)
select
  'f7872000-0000-4000-8000-000000000001',
  a.workspace_id,
  'AI Summary Client',
  'ai-summary-client@example.test'
from public.artists a
where a.id='a1111111-1111-4111-8111-111111111111';

insert into public.enquiries(
  id,client_id,idempotency_key,intake_fingerprint,status,intake_state,
  submitted_full_name,submitted_email,privacy_notice_version,privacy_acknowledged_at,
  artist_id,project_type,placement,approximate_size,idea
) values (
  'f7873000-0000-4000-8000-000000000001',
  'f7872000-0000-4000-8000-000000000001',
  'f7874000-0000-4000-8000-000000000001',
  repeat('b',64),'new','complete','AI Summary Client','ai-summary-client@example.test',
  '2026-07-29',now(),'a1111111-1111-4111-8111-111111111111',
  'Tattoo','Left forearm','20 cm','Black and grey realism half sleeve with a compass'
);
insert into public.enquiry_files(
  id,enquiry_id,ordinal,storage_path,mime_type,safe_extension,byte_size,upload_state,uploaded_at
) values (
  'f7875000-0000-4000-8000-000000000001',
  'f7873000-0000-4000-8000-000000000001',
  0,
  'clients/f7872000-0000-4000-8000-000000000001/enquiries/f7873000-0000-4000-8000-000000000001/references/f7875000-0000-4000-8000-000000000001.png',
  'image/png','png',4096,'ready',now()
);
insert into public.integration_outbox(
  id,kind,dedupe_key,status,payload,client_id,enquiry_id,artist_id,
  attempt_count,max_attempts,next_attempt_at,leased_by,leased_at,lease_expires_at
) values (
  'f7876000-0000-4000-8000-000000000001','telegram_notification',
  'telegram:enquiry_created:f7873000-0000-4000-8000-000000000001',
  'leased','{"reference_number":"ENQ-AI-SUMMARY-787","file_count":1}'::jsonb,
  'f7872000-0000-4000-8000-000000000001',
  'f7873000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  0,8,now(),'telegram-ai-summary-test',now(),now()+interval '2 minutes'
);

set local role service_role;
select is(
  (public.service_route_telegram_enquiry_notification(
    'f7876000-0000-4000-8000-000000000001','telegram-ai-summary-test'
  )->>'routed')::boolean,
  true,
  'new enquiry routes into the existing personal notification queue'
);
reset role;

select is(
  (select title from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  'New enquiry: AI Summary Client',
  'the Telegram notification identifies the client instead of the application number'
);
select ok(
  (select position(e.reference_number in (n.title || E'\n' || n.body)) = 0
   from public.notifications n
   join public.enquiries e on e.id=n.entity_id
   where n.entity_type='enquiry'
     and n.entity_id='f7873000-0000-4000-8000-000000000001'
     and n.notification_type='enquiry.created'),
  'the application reference is absent from both title and body'
);
select is(
  (select body from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  'New enquiry received. AI summary is being prepared.',
  'the notification stays useful while the existing AI refresh is still running'
);
select ok(
  (select scheduled_at >= now() + interval '4 minutes'
   from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  'AI-enabled intake holds the fallback briefly instead of sending a duplicate first alert'
);

set local role service_role;
select is(
  (select count(*)::int
   from public.service_claim_telegram_notifications('telegram-ai-summary-early',20,120)),
  0,
  'the held fallback is not claimable before its scheduled time'
);
reset role;

insert into public.client_ai_state(
  artist_id,workspace_id,client_id,summary,brief,missing_information,
  source_watermark,provider,model
)
select
  e.artist_id,
  a.workspace_id,
  e.client_id,
  'Client wants a black and grey realism half sleeve on the left forearm, around 20 cm, using a compass as the main subject.',
  jsonb_build_object(
    'project_summary', 'Black and grey realism half sleeve with a compass.',
    'stage', 'new_enquiry',
    'placement', 'Left forearm',
    'style', 'Black and grey realism',
    'colour', 'black_and_grey',
    'size', '20 cm',
    'cover_up_context', null,
    'constraints', jsonb_build_array(),
    'decisions_made', jsonb_build_array(),
    'open_questions', jsonb_build_array('Preferred timing'),
    'promises_to_client', jsonb_build_array(),
    'waiting_on', 'artist',
    'last_interaction', 'Client submitted a new tattoo enquiry.',
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed')
    )
  ),
  '[]'::jsonb,
  crm_private.client_ai_watermark(e.artist_id,e.client_id),
  'qwen',
  '@cf/qwen/qwen3.8-27b'
from public.enquiries e
join public.artists a on a.id=e.artist_id
where e.id='f7873000-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  1,
  'AI enrichment updates the existing notification rather than creating another one'
);
select is(
  (select body from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  E'AI summary:\nClient wants a black and grey realism half sleeve on the left forearm, around 20 cm, using a compass as the main subject.',
  'the held alert is replaced with the bounded AI enquiry summary'
);
select ok(
  (select scheduled_at <= now()
   from public.notifications
   where entity_type='enquiry'
     and entity_id='f7873000-0000-4000-8000-000000000001'
     and notification_type='enquiry.created'),
  'the AI summary releases the same alert immediately'
);

set local role service_role;
create temporary table ai_summary_delivery as
select * from public.service_claim_telegram_notifications('telegram-ai-summary-ready',20,120);
select is((select count(*)::int from ai_summary_delivery),1,
  'the enriched enquiry alert is now claimable');
select is((select entity_type from ai_summary_delivery),'enquiry',
  'Telegram delivery carries the enquiry entity type for deep-link rendering');
select is((select entity_id from ai_summary_delivery),'f7873000-0000-4000-8000-000000000001'::uuid,
  'Telegram delivery carries the exact enquiry id for the CRM deep link');
reset role;

insert into public.client_ai_next_actions(
  artist_id,workspace_id,client_id,client_ai_state_id,
  action_type,reason,priority,draft_reply,missing_information,
  source_watermark,provider,model
)
select
  st.artist_id,st.workspace_id,st.client_id,st.id,
  'request_information',
  'The artist should review the new enquiry and ask about preferred timing.',
  'normal',
  'Thanks for the details. What timing would suit you best?',
  '["preferred_timing"]'::jsonb,
  st.source_watermark,'qwen','@cf/qwen/qwen3.8-27b'
from public.client_ai_state st
where st.artist_id='a1111111-1111-4111-8111-111111111111'
  and st.client_id='f7872000-0000-4000-8000-000000000001';

select is(
  crm_private.enqueue_client_ai_notification(
    (select id from public.client_ai_next_actions
     where artist_id='a1111111-1111-4111-8111-111111111111'
       and client_id='f7872000-0000-4000-8000-000000000001')
  ),
  0,
  'the initial AI recommendation does not create a second Telegram push for the same new enquiry'
);
select is(
  (select count(*)::int from public.notifications
   where recipient_profile_id='f7870000-0000-4000-8000-000000000001'
     and notification_type='client_ai.next_action'),
  0,
  'the recipient sees one enriched new-enquiry alert, not a duplicate AI alert'
);

select * from finish();
rollback;
