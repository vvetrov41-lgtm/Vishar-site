-- Rollback-only synthetic verification. Marking a personal conversation closes
-- only earlier unread reply alerts for that artist/conversation, not other
-- notices, already-read messages, future alerts or another conversation.
begin;
select no_plan();

select has_function('crm_private',
  'dismiss_personal_conversation_reply_alerts', array[]::text[],
  'private personal-conversation dismissal trigger exists');
select ok(not has_function_privilege('anon',
  'crm_private.dismiss_personal_conversation_reply_alerts()', 'EXECUTE'),
  'anonymous users cannot call private dismissal function');
select ok(not has_function_privilege('authenticated',
  'crm_private.dismiss_personal_conversation_reply_alerts()', 'EXECUTE'),
  'browser users cannot call private dismissal function');

insert into auth.users (id,email) values
 ('c8410000-0000-4000-8000-000000000001', 'personal-notice-384@example.test');
insert into public.profiles (id,email,display_name,role,is_active) values
 ('c8410000-0000-4000-8000-000000000001', 'personal-notice-384@example.test',
  'Synthetic personal notice tester','owner',true);

insert into public.communication_conversations
 (id,artist_id,channel,integration_key,external_contact_id)
values
 ('c8410000-0000-4000-8000-000000000011',
  'a1111111-1111-4111-8111-111111111111','instagram',
  'vladimir-production','synthetic-personal-notice-384-1'),
 ('c8410000-0000-4000-8000-000000000012',
  'a1111111-1111-4111-8111-111111111111','instagram',
  'vladimir-production','synthetic-personal-notice-384-2');

insert into public.notifications
 (id,recipient_profile_id,artist_id,notification_type,title,
  entity_type,entity_id,status,dedupe_key,created_at,scheduled_at,delivered_at,read_at)
values
 -- Two earlier unread reply alerts must be dismissed.
 ('c8420000-0000-4000-8000-000000000001',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'client.reply_overdue','Synthetic delayed personal reply',
  'conversation','c8410000-0000-4000-8000-000000000011',
  'delivered','p384-reply-old-delivered', now()-interval '3 hours',
  now()-interval '3 hours', now()-interval '3 hours', null),
 ('c8420000-0000-4000-8000-000000000002',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'client.reply_overdue','Synthetic pending personal reply',
  'conversation','c8410000-0000-4000-8000-000000000011',
  'pending','p384-reply-old-pending', now()-interval '2 hours',
  now()-interval '2 hours', null, null),
 -- Different notification type must survive personal marking.
 ('c8420000-0000-4000-8000-000000000003',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'system.alert','Synthetic unrelated alert',
  'conversation','c8410000-0000-4000-8000-000000000011',
  'delivered','p384-other-alert', now()-interval '3 hours',
  now()-interval '3 hours', now()-interval '3 hours', null),
 -- Already-read alerts retain their original history.
 ('c8420000-0000-4000-8000-000000000004',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'client.reply_overdue','Synthetic previously read reply',
  'conversation','c8410000-0000-4000-8000-000000000011',
  'delivered','p384-already-read', now()-interval '3 hours',
  now()-interval '3 hours', now()-interval '3 hours', now()-interval '90 minutes'),
 -- Never dismiss an alert for an unrelated conversation.
 ('c8420000-0000-4000-8000-000000000005',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'client.reply_overdue','Synthetic other conversation',
  'conversation','c8410000-0000-4000-8000-000000000012',
  'delivered','p384-other-convo', now()-interval '3 hours',
  now()-interval '3 hours', now()-interval '3 hours', null),
 -- This intentionally future-dated alert demonstrates timestamp protection:
 -- it must not be dismissed by a personal flag set earlier.
 ('c8420000-0000-4000-8000-000000000006',
  'c8410000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'client.reply_overdue','Synthetic future notice',
  'conversation','c8410000-0000-4000-8000-000000000011',
  'delivered','p384-future-notice',now()+interval '2 hours',
  now()+interval '2 hours',now()+interval '2 hours',null);

-- CRM RPC set_conversation_not_crm() updates not_crm_at on this row; the
-- trigger operates on that exact field and on any otherwise authorized update.
update public.communication_conversations
set not_crm_at=now()-interval '30 minutes'
where id='c8410000-0000-4000-8000-000000000011';

select is((select count(*)::int from public.notifications
 where id in ('c8420000-0000-4000-8000-000000000001',
              'c8420000-0000-4000-8000-000000000002')
   and status='dismissed'),2,
 'marking personal dismisses older delivered and pending reply alerts');
select is((select status::text from public.notifications
 where id='c8420000-0000-4000-8000-000000000003'),
 'delivered','non-reply alerts are unaffected');
select is((select status::text from public.notifications
 where id='c8420000-0000-4000-8000-000000000004'),
 'delivered','already read reply alerts retain their status');
select is((select status::text from public.notifications
 where id='c8420000-0000-4000-8000-000000000005'),
 'delivered','other conversations are unaffected');
select is((select status::text from public.notifications
 where id='c8420000-0000-4000-8000-000000000006'),
 'delivered','notices newer than the personal decision are preserved');
select ok((select read_at is null from public.notifications
 where id='c8420000-0000-4000-8000-000000000001'),
 'dismissal never fabricates an operator read receipt');

-- The toggle off does not restore old alerts or delete historical records.
update public.communication_conversations set not_crm_at=null
where id='c8410000-0000-4000-8000-000000000011';
select is((select status::text from public.notifications
 where id='c8420000-0000-4000-8000-000000000001'),
 'dismissed','unmarking personal does not resurrect stale notification');

select * from finish();
rollback;
