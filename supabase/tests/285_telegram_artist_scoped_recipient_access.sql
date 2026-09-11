-- 285_telegram_artist_scoped_recipient_access.sql
-- Regression for artist-scoped staff (for example a booking manager) who must
-- receive that artist's Telegram notifications without workspace-wide access.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users(id,email)
values ('f2850000-0000-4000-8000-000000000001','artist-scope-telegram@example.test');

insert into public.profiles(id,email,display_name,role,is_active)
values (
  'f2850000-0000-4000-8000-000000000001',
  'artist-scope-telegram@example.test',
  'Artist Scope Telegram Manager',
  'booking_manager',
  true
);

insert into public.artist_memberships(
  profile_id,artist_id,access_level,can_view_finance,can_manage_finance,
  can_manage_sessions,can_manage_integrations,is_active
) values (
  'f2850000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'manager',false,false,true,true,true
);

insert into crm_private.telegram_destinations(
  id,destination_kind,profile_id,chat_id,chat_type,safe_label,is_active,connected_by_profile_id
) values (
  'f2851000-0000-4000-8000-000000000001',
  'profile',
  'f2850000-0000-4000-8000-000000000001',
  '72850001',
  'private',
  'Telegram',
  true,
  'f2850000-0000-4000-8000-000000000001'
);

insert into public.notification_preferences(profile_id,channel,is_enabled)
values ('f2850000-0000-4000-8000-000000000001','telegram',true);

select is(
  (
    select count(*)::int
    from public.workspace_memberships wm
    join public.artists a on a.workspace_id = wm.workspace_id
    where wm.profile_id = 'f2850000-0000-4000-8000-000000000001'
      and a.id = 'a1111111-1111-4111-8111-111111111111'
      and wm.is_active
  ),
  0,
  'artist manager fixture has no workspace-wide membership'
);

select ok(
  crm_private.profile_can_receive_notification(
    'f2850000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'artist access is sufficient when workspace_id matches the artist scope'
);

select ok(
  crm_private.telegram_notification_recipient_eligible(
    'f2850000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'artist-scoped manager with Telegram enabled is an eligible recipient'
);

select ok(
  not crm_private.profile_can_receive_notification(
    'f2850000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    'f2852000-0000-4000-8000-000000000001'
  ),
  'mismatched workspace remains fail-closed'
);

select ok(
  not crm_private.profile_can_receive_notification(
    'f2850000-0000-4000-8000-000000000001',
    null,
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'workspace-only notification still requires workspace access'
);

update public.artist_memberships
set is_active = false
where profile_id='f2850000-0000-4000-8000-000000000001'
  and artist_id='a1111111-1111-4111-8111-111111111111';

select ok(
  not crm_private.telegram_notification_recipient_eligible(
    'f2850000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  ),
  'inactive artist membership remains fail-closed'
);

select * from finish();
rollback;
