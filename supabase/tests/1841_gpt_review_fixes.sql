-- 1841_gpt_review_fixes.sql
--
-- Unified GPT v2 review fixes: file removal preparation, statistics and failed
-- deliveries reads, and Monzo reads gated by manage_finance.

begin;
select no_plan();

select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE') and p.prosecdef)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('gpt_prepare_enquiry_file_removal', 'gpt_get_statistics', 'gpt_list_failed_deliveries')),
  'new wrappers are authenticated-only definers'
);

insert into auth.users (id, email) values
  ('d1011111-1111-4111-8111-111111111111', 'gpt-fix-owner@example.test'),
  ('d1022222-2222-4222-8222-222222222222', 'gpt-fix-manager@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('d1011111-1111-4111-8111-111111111111', 'gpt-fix-owner@example.test', 'GPT Fix Owner', 'owner', true),
  ('d1022222-2222-4222-8222-222222222222', 'gpt-fix-manager@example.test', 'GPT Fix Manager', 'booking_manager', true);
insert into public.artist_memberships (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active)
values ('d1022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'manager', true, false, true, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"d1011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-fixes', true, true);
select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true);
select public.configure_gpt_full_management('vishar-unified-gpt', true, true, false);

select pg_temp.claims('{"sub":"d1011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-fixes"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');

select throws_ok($$select public.gpt_prepare_enquiry_file_removal('d1039999-9999-4999-8999-999999999999')$$, '42501', null,
  'an unknown file is refused as out of scope');
select ok(public.gpt_get_statistics(now() - interval '30 days', now()) ? 'payments',
  'the owner sees money totals in statistics');
select throws_ok($$select public.gpt_get_statistics(now() - interval '500 days', now())$$, '22023', null,
  'statistics ranges are bounded');
select is(jsonb_typeof(public.gpt_list_failed_deliveries(10)), 'array', 'failed deliveries list');
select lives_ok($$select public.gpt_list_monzo_destinations()$$, 'the owner reads Monzo destinations');

-- A manager with view_finance but not manage_finance.
select pg_temp.claims('{"sub":"d1022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-fixes"}');
select ok(public.gpt_get_statistics(now() - interval '30 days', now()) ? 'payments',
  'a manager with view_finance sees money totals');
select throws_ok($$select public.gpt_list_monzo_destinations()$$, '42501', null,
  'Monzo destinations need manage_finance, like the CRM RPC behind them');
select throws_ok($$select public.gpt_get_monzo_transfer_settings()$$, '42501', null,
  'Monzo transfer settings need manage_finance');

select * from finish();
rollback;
