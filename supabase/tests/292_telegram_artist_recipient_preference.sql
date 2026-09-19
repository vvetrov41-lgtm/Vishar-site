-- 292_telegram_artist_recipient_preference.sql
-- Administrative owner access must not duplicate another artist's operational
-- Telegram alerts when that artist has their own eligible recipient.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users(id,email) values
  ('f2920000-0000-4000-8000-000000000001','preferred-manager@example.test'),
  ('f2920000-0000-4000-8000-000000000002','fallback-owner@example.test'),
  ('f2920000-0000-4000-8000-000000000003','readonly-observer@example.test');

insert into public.profiles(id,email,display_name,role,is_active) values
  ('f2920000-0000-4000-8000-000000000001','preferred-manager@example.test','Preferred Artist Recipient','booking_manager',true),
  ('f2920000-0000-4000-8000-000000000002','fallback-owner@example.test','Administrative Owner','owner',true),
  ('f2920000-0000-4000-8000-000000000003','readonly-observer@example.test','Read Only Observer','read_only',true);

insert into public.artist_memberships(
  profile_id,artist_id,access_level,can_view_finance,can_manage_finance,
  can_manage_sessions,can_manage_integrations,is_active
) values
  ('f2920000-0000-4000-8000-000000000001','a1111111-1111-4111-8111-111111111111','manager',false,false,true,true,true),
  ('f2920000-0000-4000-8000-000000000002','a1111111-1111-4111-8111-111111111111','owner',true,true,true,true,true),
  ('f2920000-0000-4000-8000-000000000003','a1111111-1111-4111-8111-111111111111','read_only',false,false,false,false,true);

insert into crm_private.telegram_destinations(
  id,destination_kind,profile_id,chat_id,chat_type,safe_label,is_active,connected_by_profile_id
) values
  ('f2921000-0000-4000-8000-000000000001','profile','f2920000-0000-4000-8000-000000000001','72920001','private','Telegram',true,'f2920000-0000-4000-8000-000000000001'),
  ('f2921000-0000-4000-8000-000000000002','profile','f2920000-0000-4000-8000-000000000002','72920002','private','Telegram',true,'f2920000-0000-4000-8000-000000000002'),
  ('f2921000-0000-4000-8000-000000000003','profile','f2920000-0000-4000-8000-000000000003','72920003','private','Telegram',true,'f2920000-0000-4000-8000-000000000003');

insert into public.notification_preferences(profile_id,channel,is_enabled) values
  ('f2920000-0000-4000-8000-000000000001','telegram',true),
  ('f2920000-0000-4000-8000-000000000002','telegram',true),
  ('f2920000-0000-4000-8000-000000000003','telegram',true);

select ok(
  crm_private.telegram_notification_recipient_eligible(
    'f2920000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'artist-facing manager remains eligible'
);

select ok(
  not crm_private.telegram_notification_recipient_eligible(
    'f2920000-0000-4000-8000-000000000002',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'administrative owner is suppressed while an eligible artist-facing recipient exists'
);

select ok(
  not crm_private.telegram_notification_recipient_eligible(
    'f2920000-0000-4000-8000-000000000003',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'read-only membership never receives operational Telegram notifications'
);

update crm_private.telegram_destinations
set is_active=false
where profile_id='f2920000-0000-4000-8000-000000000001'
  and destination_kind='profile';

select ok(
  crm_private.telegram_notification_recipient_eligible(
    'f2920000-0000-4000-8000-000000000002',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'owner becomes the safe fallback when no artist-facing Telegram recipient is available'
);

select * from finish();
rollback;
