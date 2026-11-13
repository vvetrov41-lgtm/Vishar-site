-- Rollback-only pgTAP: genuine outbound replies dismiss old alerts without
-- concealing automated messages, queued sends, newer client replies or reactions.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select has_function('crm_private', 'dismiss_reply_overdue_after_human_response',
  array[]::text[], 'the reply-overdue trigger exists');
select ok(not has_function_privilege('anon',
  'crm_private.dismiss_reply_overdue_after_human_response()', 'EXECUTE'),
  'anonymous callers cannot execute the private trigger');
select ok(not has_function_privilege('authenticated',
  'crm_private.dismiss_reply_overdue_after_human_response()', 'EXECUTE'),
  'browser sessions cannot execute the private trigger');

insert into auth.users (id,email) values
  ('ee310000-0000-4000-8000-000000000001','reply-alert-test@example.test');
insert into public.profiles (id,email,display_name,role,is_active) values
  ('ee310000-0000-4000-8000-000000000001','reply-alert-test@example.test',
   'Synthetic reply test','owner',true);

insert into public.communication_conversations
  (id,artist_id,channel,integration_key,external_contact_id) values
  ('ee310000-0000-4000-8000-000000000011','a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production','447700901111'),
  ('ee310000-0000-4000-8000-000000000012','a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production','447700901112'),
  ('ee310000-0000-4000-8000-000000000013','a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production','447700901113'),
  ('ee310000-0000-4000-8000-000000000014','a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production','447700901114');

insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,body,provider_timestamp)
select ('ee310000-0000-4000-8000-0000000000'||right(c.id::text,2))::uuid,
       c.id,c.artist_id,'whatsapp','inbound','contact','received',
       'Synthetic inbound',now()-interval '4 hours'
from public.communication_conversations c
where c.id in
  ('ee310000-0000-4000-8000-000000000011',
   'ee310000-0000-4000-8000-000000000012',
   'ee310000-0000-4000-8000-000000000013',
   'ee310000-0000-4000-8000-000000000014');

insert into public.notifications
  (id,recipient_profile_id,artist_id,notification_type,title,
   entity_type,entity_id,status,dedupe_key,created_at,delivered_at,scheduled_at)
select ('ee320000-0000-4000-8000-0000000000'||right(c.id::text,2))::uuid,
       'ee310000-0000-4000-8000-000000000001',c.artist_id,
       'client.reply_overdue','Synthetic unanswered client',
       'conversation',c.id,'delivered',
       'phase2-reply-alert:'||c.id::text,
       now()-interval '3 hours',now()-interval '3 hours',now()-interval '3 hours'
from public.communication_conversations c
where c.id in
  ('ee310000-0000-4000-8000-000000000011',
   'ee310000-0000-4000-8000-000000000012',
   'ee310000-0000-4000-8000-000000000013',
   'ee310000-0000-4000-8000-000000000014');

-- A human message accepted after an inbound message resolves the warning.
insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,body,provider_timestamp)
values
  ('ee330000-0000-4000-8000-000000000011','ee310000-0000-4000-8000-000000000011',
   'a1111111-1111-4111-8111-111111111111','whatsapp','outbound','crm','sent',
   'Synthetic artist reply',now()-interval '2 hours');
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000011'),
  'dismissed','accepted artist reply dismisses the old warning');
select ok(crm_private.unanswered_waiting_since('conversation',
  'a1111111-1111-4111-8111-111111111111',
  'ee310000-0000-4000-8000-000000000011') is null,
  'the authoritative outstanding-reply rule agrees that the client was answered');
select ok((select read_at is null from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000011'),
  'automatic dismissal never pretends the artist read the warning');

update public.communication_messages set status='delivered'
where id='ee330000-0000-4000-8000-000000000011';
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000011'),
  'dismissed','provider delivery update is idempotent');

-- Automated booking-card messages do not count as a personal answer.
insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,body,provider_timestamp)
values
  ('ee330000-0000-4000-8000-000000000012','ee310000-0000-4000-8000-000000000012',
   'a1111111-1111-4111-8111-111111111111','whatsapp','outbound','automation','sent',
   'Synthetic booking card',now()-interval '2 hours');
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000012'),
  'delivered','an automated card cannot hide an unanswered client');

-- Queued messages are not replies. A delayed acknowledgement may not hide a
-- newer actionable inbound that arrived after the outbound's event time.
insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,body,provider_timestamp)
values
  ('ee330000-0000-4000-8000-000000000013','ee310000-0000-4000-8000-000000000013',
   'a1111111-1111-4111-8111-111111111111','whatsapp','outbound','crm','queued',
   'Synthetic queued reply',now()-interval '2 hours');
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000013'),
  'delivered','a queued send cannot resolve the warning');
insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,body,provider_timestamp)
values
  ('ee340000-0000-4000-8000-000000000013','ee310000-0000-4000-8000-000000000013',
   'a1111111-1111-4111-8111-111111111111','whatsapp','inbound','contact','received',
   'Synthetic newer question',now()-interval '1 hour');
update public.communication_messages set status='sent'
where id='ee330000-0000-4000-8000-000000000013';
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000013'),
  'delivered','a later client message survives a delayed send acknowledgement');

insert into public.communication_messages
  (id,conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp)
values
  ('ee330000-0000-4000-8000-000000000014','ee310000-0000-4000-8000-000000000014',
   'a1111111-1111-4111-8111-111111111111','whatsapp','outbound','crm','sent',
   'reaction','Synthetic reaction',now()-interval '2 hours');
select is((select status::text from public.notifications
  where entity_id='ee310000-0000-4000-8000-000000000014'),
  'delivered','a nonactionable reaction is not a reply');

select * from finish();
rollback;
