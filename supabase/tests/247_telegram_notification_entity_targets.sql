-- 247_telegram_notification_entity_targets.sql
-- The trusted Telegram lease may carry a safe CRM entity target, while the
-- browser and legacy v1 claim surface remain unchanged.

begin;
select no_plan();

select has_function('public', 'service_claim_telegram_notifications_v2',
  array['text', 'integer', 'integer'],
  'entity-aware Telegram claim exists');
select ok(not has_function_privilege('authenticated',
  'public.service_claim_telegram_notifications_v2(text,integer,integer)', 'EXECUTE'),
  'browser cannot lease entity-aware Telegram deliveries');
select ok(has_function_privilege('service_role',
  'public.service_claim_telegram_notifications_v2(text,integer,integer)', 'EXECUTE'),
  'trusted connector can lease entity-aware Telegram deliveries');
select ok(has_function_privilege('service_role',
  'public.service_claim_telegram_notifications(text,integer,integer)', 'EXECUTE'),
  'legacy v1 claim remains available for rollback');

insert into auth.users (id, email)
values ('f7010000-0000-4000-8000-000000000001', 'telegram-target@example.test');

insert into public.profiles (id, email, display_name, role, is_active)
values (
  'f7010000-0000-4000-8000-000000000001',
  'telegram-target@example.test',
  'Telegram Target Manager',
  'booking_manager',
  true
);

insert into public.artists (id, slug, display_name, timezone, default_currency, is_active)
values (
  'f7a10000-0000-4000-8000-000000000001',
  'telegram-target-artist',
  'Telegram Target Artist',
  'Europe/London',
  'GBP',
  true
);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance, can_manage_sessions,
  can_manage_integrations, is_active
) values (
  'f7010000-0000-4000-8000-000000000001',
  'f7a10000-0000-4000-8000-000000000001',
  'manager', false, false, true, false, true
);

insert into public.notification_preferences(profile_id, channel, is_enabled)
values ('f7010000-0000-4000-8000-000000000001', 'telegram', true);

insert into crm_private.telegram_destinations (
  id, destination_kind, profile_id, chat_id, chat_type, safe_label,
  connected_by_profile_id, connected_at
) values (
  'f7d10000-0000-4000-8000-000000000001',
  'profile',
  'f7010000-0000-4000-8000-000000000001',
  '700001',
  'private',
  'Telegram target test',
  'f7010000-0000-4000-8000-000000000001',
  now() - interval '1 minute'
);

insert into public.notifications (
  id, recipient_profile_id, artist_id, notification_type, title, body,
  entity_type, entity_id, priority, status, dedupe_key,
  scheduled_at, delivered_at, created_at
) values (
  'f7b10000-0000-4000-8000-000000000001',
  'f7010000-0000-4000-8000-000000000001',
  'f7a10000-0000-4000-8000-000000000001',
  'appointment.client_response',
  'Client requested reschedule',
  'Open the appointment to review the request.',
  'session',
  'f7c10000-0000-4000-8000-000000000001',
  'high',
  'delivered',
  'telegram-target-session',
  now(), now(), now()
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table claimed_target as
select *
from public.service_claim_telegram_notifications_v2('telegram-target-worker', 20, 120);
grant select on claimed_target to service_role;

select is((select count(*)::integer from claimed_target), 1,
  'v2 leases the eligible personal notification exactly once');
select is((select notification_id from claimed_target),
  'f7b10000-0000-4000-8000-000000000001'::uuid,
  'v2 preserves the notification identity');
select is((select entity_type from claimed_target), 'session',
  'v2 preserves the session entity type');
select is((select entity_id from claimed_target),
  'f7c10000-0000-4000-8000-000000000001'::uuid,
  'v2 preserves the exact session id');
select is((select chat_id from claimed_target), '700001',
  'private chat id remains backend-only lease data');

select lives_ok(
  $$select public.service_record_telegram_notification_result(
      (select delivery_id from claimed_target),
      'telegram-target-worker',
      true,
      null
    )$$,
  'entity-aware delivery uses the existing lease acknowledgement path');

reset role;
select * from finish();
rollback;
