-- 1012_instagram_webhook_subscription_health.sql
--
-- Instagram DM ingestion repair: subscription state is recorded per route,
-- the maintenance list returns only enabled Instagram Login routes, and
-- delivery evidence is counts-only, bounded, and owner-readable only.
-- Everything is synthetic and rolled back.

begin;
select no_plan();

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key, is_enabled, configuration
) values
  ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login', 'vladimir-igtest-enabled', true,
   '{"instagram_user_id": "17841400000000101", "username": "enabled_test"}'::jsonb),
  ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login', 'vladimir-igtest-disabled', false,
   '{"instagram_user_id": "17841400000000102", "username": "disabled_test"}'::jsonb);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

select set_eq(
  $$select integration_key, instagram_user_id, webhook_subscription_checked_at is null
    from public.service_list_instagram_maintenance_targets()
    where integration_key like 'vladimir-igtest-%'$$,
  $$values ('vladimir-igtest-enabled', '17841400000000101', true)$$,
  'only enabled Instagram Login routes are maintained, starting unchecked');

select lives_ok(
  $$select public.service_record_instagram_webhook_subscription(
      'a1111111-1111-4111-8111-111111111111', 'vladimir-igtest-enabled',
      array['message_reactions','messages','messaging_seen'], null)$$,
  'a successful subscription readback is recorded');

select results_eq(
  $$select webhook_subscription_error is null, webhook_subscription_checked_at > now() - interval '1 minute'
    from public.service_list_instagram_maintenance_targets()
    where integration_key = 'vladimir-igtest-enabled'$$,
  $$values (true, true)$$,
  'the maintenance list reports the check time and no error');

select lives_ok(
  $$select public.service_record_instagram_webhook_subscription(
      'a1111111-1111-4111-8111-111111111111', 'vladimir-igtest-enabled',
      array[]::text[], 'instagram_subscription_permission_denied')$$,
  'a failed subscription is recorded with its code');

select is(
  (select webhook_subscription_error from public.service_list_instagram_maintenance_targets()
   where integration_key = 'vladimir-igtest-enabled'),
  'instagram_subscription_permission_denied',
  'the error code is visible to the next maintenance pass');

select throws_ok(
  $$select public.service_record_instagram_webhook_subscription(
      'a1111111-1111-4111-8111-111111111111', 'vladimir-igtest-missing', array['messages'], null)$$,
  '23503', null, 'an unknown route is refused');
select throws_ok(
  $$select public.service_record_instagram_webhook_subscription(
      'a1111111-1111-4111-8111-111111111111', 'vladimir-igtest-enabled', array['Bad Field'], null)$$,
  '22023', null, 'a malformed field name is refused');

select lives_ok(
  $$select public.service_record_instagram_webhook_delivery('{"accepted": 1, "inbound": 2}'::jsonb)$$,
  'delivery counts are recorded');
select lives_ok(
  $$select public.service_record_instagram_webhook_delivery('{"accepted": 1, "unrouted": 1, "read": 0}'::jsonb)$$,
  'counts accumulate in the same hour and zeros are skipped');
select lives_ok(
  $$select public.service_record_instagram_webhook_delivery('{"recipient_alias": 1, "skipped_cross_account": 0}'::jsonb)$$,
  'skip reasons and the recipient alias are recordable outcomes');
select throws_ok(
  $$select public.service_record_instagram_webhook_delivery('{"sender_id": 1}'::jsonb)$$,
  '22023', null, 'an unknown outcome key is refused, so nothing identifying can be stored');
select throws_ok(
  $$select public.service_record_instagram_webhook_delivery('{"accepted": 5000}'::jsonb)$$,
  '22023', null, 'counts are bounded');
reset role;

select set_eq(
  $$select outcome, count from crm_private.instagram_webhook_delivery_counters
    where bucket_hour = date_trunc('hour', now())$$,
  $$values ('accepted', 2::bigint), ('inbound', 2::bigint), ('unrouted', 1::bigint), ('recipient_alias', 1::bigint)$$,
  'hourly counters hold only outcome counts');

select ok(
  not has_function_privilege('anon', 'public.service_record_instagram_webhook_delivery(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.service_record_instagram_webhook_delivery(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.service_record_instagram_webhook_subscription(uuid,text,text[],text)', 'execute')
  and not has_function_privilege('authenticated', 'public.service_list_instagram_maintenance_targets()', 'execute')
  and not has_table_privilege('authenticated', 'crm_private.instagram_webhook_delivery_counters', 'select'),
  'the write surface and raw counters are backend-only');

-- A non-owner session cannot read delivery health.
insert into auth.users (id, email) values ('fd000000-0000-4000-8000-000000000001', 'ig-health-staff@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fd000000-0000-4000-8000-000000000001', 'ig-health-staff@example.test', 'Staff', 'booking_manager', true);
select set_config('request.jwt.claims', '{"sub":"fd000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.get_instagram_webhook_health(24)$$, '42501', null,
  'only the owner reads Instagram delivery health');
reset role;

select * from finish();
rollback;
