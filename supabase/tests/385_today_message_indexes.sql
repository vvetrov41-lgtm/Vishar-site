-- Regression: Today performance indexes are present and precisely bounded;
-- no messages, clients or payment records are changed by this test.
begin;
select no_plan();

select ok(exists (
  select 1 from pg_indexes
  where schemaname = 'public' and tablename = 'communication_messages'
    and indexname = 'communication_messages_today_inbound_idx'
    and indexdef like '%COALESCE(provider_timestamp, created_at)%'
    and indexdef like '%direction = %inbound%'
), 'Today latest-inbound expression index preserves the inbound-only predicate');

select ok(exists (
  select 1 from pg_indexes
  where schemaname = 'public' and tablename = 'communication_messages'
    and indexname = 'communication_messages_today_studio_idx'
    and indexdef like '%COALESCE(sent_at, provider_timestamp, created_at)%'
    and indexdef like '%origin = ANY%'
    and indexdef like '%status = ANY%'
), 'Today last-studio-reply expression index includes only sent studio messages');

select ok(has_function_privilege('authenticated','public.get_today_pulse(uuid)','execute')
  and not has_function_privilege('anon','public.get_today_pulse(uuid)','execute'),
  'Today server pulse still requires authentication');
select * from finish(true);
rollback;
