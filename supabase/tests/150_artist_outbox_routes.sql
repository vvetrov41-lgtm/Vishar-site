-- 150_artist_outbox_routes.sql
-- Synthetic route tests; no provider is contacted.
begin;
select no_plan();

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
('d1111111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',
 'telegram','telegram','vladimir-telegram','Synthetic Vladimir notifications',
 '{"locale":"en-GB"}'::jsonb,true),
('d2222222-2222-4222-8222-222222222222','a2222222-2222-4222-8222-222222222222',
 'telegram','telegram','kristina-telegram','Synthetic Kristina notifications',
 '{"locale":"en-GB"}'::jsonb,true),
('d3333333-3333-4333-8333-333333333333','a1111111-1111-4111-8111-111111111111',
 'email','unconfigured','vladimir-email-disabled','Synthetic disabled email',
 '{}'::jsonb,false);

insert into public.integration_outbox (id,artist_id,kind,dedupe_key,payload) values
('0b0b0b0b-0000-4000-8000-000000000101','a1111111-1111-4111-8111-111111111111',
 'telegram_notification','telegram:route-test:00000000-0000-4000-8000-000000000101',
 '{"enquiry_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}'::jsonb),
('0b0b0b0b-0000-4000-8000-000000000102','a2222222-2222-4222-8222-222222222222',
 'telegram_notification','telegram:route-test:00000000-0000-4000-8000-000000000102','{}'::jsonb),
('0b0b0b0b-0000-4000-8000-000000000103','a2222222-2222-4222-8222-222222222222',
 'transactional_email','email:route-test:00000000-0000-4000-8000-000000000103','{}'::jsonb),
('0b0b0b0b-0000-4000-8000-000000000104','a1111111-1111-4111-8111-111111111111',
 'reconciliation','reconciliation:route-test:00000000-0000-4000-8000-000000000104','{}'::jsonb);

select has_function('public','resolve_outbox_route',array['uuid'],'route resolver exists');
select ok(has_function_privilege('service_role','public.resolve_outbox_route(uuid)','EXECUTE'),
 'service_role may resolve one route');
select ok(not has_function_privilege('anon','public.resolve_outbox_route(uuid)','EXECUTE'),
 'anon cannot resolve routes');
select ok(not has_function_privilege('authenticated','public.resolve_outbox_route(uuid)','EXECUTE'),
 'CRM sessions cannot resolve routes');
select ok(
  (select i.indisunique
   from pg_index i
   where i.indexrelid =
     'public.artist_integrations_one_enabled_type_idx'::regclass),
  'one enabled route per artist and type'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is((select artist_id from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000101')),
 'a1111111-1111-4111-8111-111111111111'::uuid,'route keeps event-time artist');
select is((select integration_type::text from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000101')),
 'telegram','kind selects Telegram');
select is((select integration_key from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000101')),
 'vladimir-telegram','Vladimir gets his route');
select is((select integration_key from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000102')),
 'kristina-telegram','Kristina gets her route');
select isnt((select integration_key from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000102')),
 'vladimir-telegram','no other-artist fallback');
select is((select configuration from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000101')),
 '{"locale":"en-GB"}'::jsonb,'safe configuration crosses boundary');
select throws_ok($$select * from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000103')$$,
 '22023',null,'missing artist email route fails closed');
select throws_ok($$select * from public.resolve_outbox_route('0b0b0b0b-0000-4000-8000-000000000104')$$,
 '22023',null,'reconciliation has no provider route');
select throws_ok($$select * from public.resolve_outbox_route('99999999-9999-4999-8999-999999999999')$$,
 '22023',null,'unknown outbox reveals nothing');
select throws_ok($$select * from public.resolve_outbox_route(null)$$,
 '22023',null,'null outbox fails closed');
reset role;

select throws_ok($$insert into public.artist_integrations
 (artist_id,integration_type,provider,integration_key,configuration,is_enabled)
 values ('a1111111-1111-4111-8111-111111111111','telegram','telegram',
 'vladimir-telegram-second','{}'::jsonb,true)$$,'23505',null,
 'second enabled route for one artist/type is rejected');
select lives_ok($$insert into public.artist_integrations
 (artist_id,integration_type,provider,integration_key,configuration,is_enabled)
 values ('a1111111-1111-4111-8111-111111111111','telegram','telegram',
 'vladimir-telegram-disabled','{}'::jsonb,false)$$,
 'disabled rotation alternative is allowed');
select is((select count(*)::int from pg_proc p
 join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='resolve_outbox_route'),1,
 'only one narrow overload exists');
select * from finish(true);
rollback;
