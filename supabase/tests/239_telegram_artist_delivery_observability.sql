-- 239_telegram_artist_delivery_observability.sql
-- Shared-bot Artist delivery reuses the existing backend acknowledgement RPC,
-- but records non-secret destination health only while the same Worker owns a
-- leased Telegram outbox row for that Artist.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(not has_function_privilege('authenticated',
  'public.service_record_telegram_notification_result(uuid,text,boolean,text)', 'EXECUTE'),
  'browser cannot acknowledge Telegram registry delivery');
select ok(has_function_privilege('service_role',
  'public.service_record_telegram_notification_result(uuid,text,boolean,text)', 'EXECUTE'),
  'trusted Telegram Worker keeps the existing acknowledgement privilege');

insert into public.artists (id, slug, display_name, timezone, default_currency, is_active) values
  ('f9a10000-0000-4000-8000-000000000001', 'telegram-observe-a', 'Telegram Observe A', 'Europe/London', 'GBP', true),
  ('f9a10000-0000-4000-8000-000000000002', 'telegram-observe-b', 'Telegram Observe B', 'Europe/London', 'GBP', true);

insert into crm_private.telegram_destinations (
  id, destination_kind, artist_id, chat_id, chat_type, safe_label, is_active
) values
  ('f9d10000-0000-4000-8000-000000000001', 'artist', 'f9a10000-0000-4000-8000-000000000001', '-100900001', 'supergroup', 'Shared Telegram group', true),
  ('f9d10000-0000-4000-8000-000000000002', 'artist', 'f9a10000-0000-4000-8000-000000000002', '-100900002', 'supergroup', 'Shared Telegram group', true);

insert into public.integration_outbox (
  id, kind, dedupe_key, status, payload, artist_id,
  attempt_count, max_attempts, next_attempt_at,
  leased_by, leased_at, lease_expires_at
) values
  ('f9b10000-0000-4000-8000-000000000001', 'telegram_notification',
   'telegram:observe-a', 'leased', '{}'::jsonb, 'f9a10000-0000-4000-8000-000000000001',
   0, 8, now(), 'telegram-observe-worker', now(), now() + interval '2 minutes'),
  ('f9b10000-0000-4000-8000-000000000002', 'telegram_notification',
   'telegram:observe-b', 'leased', '{}'::jsonb, 'f9a10000-0000-4000-8000-000000000002',
   0, 8, now(), 'telegram-observe-worker-b', now(), now() + interval '2 minutes');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000001',
    'telegram-observe-worker', true, null)$$,
  '42501', null,
  'authenticated caller cannot forge Artist registry success evidence');

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000002',
    'telegram-observe-worker', true, null)$$,
  '42501', null,
  'Worker cannot acknowledge another Artist destination without that Artist lease');

select throws_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000001',
    'another-worker', true, null)$$,
  '42501', null,
  'Worker cannot acknowledge an Artist destination without its own lease');

select throws_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000001',
    'telegram-observe-worker', false, 'Bad Error')$$,
  '22023', null,
  'failed evidence accepts only safe machine error codes');

select lives_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000001',
    'telegram-observe-worker', true, null)$$,
  'matching leased registry send records success');

reset role;
select ok(
  (select last_success_at is not null
   from crm_private.telegram_destinations
   where id='f9d10000-0000-4000-8000-000000000001'),
  'registry success advances Artist destination last_success_at');
select ok(
  (select last_error_at is null
   from crm_private.telegram_destinations
   where id='f9d10000-0000-4000-8000-000000000001'),
  'registry success does not manufacture an error timestamp');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.service_record_telegram_notification_result(
    'f9d10000-0000-4000-8000-000000000002',
    'telegram-observe-worker-b', false, 'telegram_rejected')$$,
  'matching leased registry failure records health evidence');

reset role;
select ok(
  (select last_error_at is not null
   from crm_private.telegram_destinations
   where id='f9d10000-0000-4000-8000-000000000002'),
  'registry failure advances Artist destination last_error_at');
select ok(
  (select last_success_at is null
   from crm_private.telegram_destinations
   where id='f9d10000-0000-4000-8000-000000000002'),
  'registry failure does not claim a success');

select * from finish();
rollback;
