-- Studio-share formula is session-by-session, not a percent of a period total.
-- No production customer data is written; pgTAP uses the test DB transaction.
begin;
select no_plan();

select is(crm_private.studio_fee_for_price(0), 0::numeric, 'zero price => zero fee');
select is(crm_private.studio_fee_for_price(420), 126::numeric, '£420 => 30% (£126)');
select is(crm_private.studio_fee_for_price(599.99), 180::numeric, '£599.99 rounds to £180.00');
-- Numeric rounds to pennies; boundary values below are explicit.
select is(crm_private.studio_fee_for_price(600), 180::numeric, '£600 => £180');
select is(crm_private.studio_fee_for_price(600.01), 180::numeric, 'above £600 => fixed £180');
select is(crm_private.studio_fee_for_price(980), 180::numeric, '£980 => fixed £180');
select is(crm_private.studio_fee_for_price(null), null::numeric, 'missing price cannot be guessed');
select is(crm_private.studio_fee_for_price(-1), null::numeric, 'invalid price cannot become negative fee');
select is(
  (select sum(crm_private.studio_fee_for_price(price)) from (values (980::numeric),(420::numeric)) v(price)),
  306::numeric,
  '£980 and £420 fees are £180 + £126, not 30% of £1,400'
);
select ok(
  pg_get_functiondef('crm_private.statistics_core(uuid,timestamptz,timestamptz,timestamptz,boolean)'::regprocedure)
    like '%crm_private.statistics_studio_share(p_artist_id, p_from, p_to)%',
  'CRM and GPT still share the single authorized statistics_core'
);
select ok(
  (select bool_and(not has_function_privilege(role, p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join unnest(array['anon', 'authenticated', 'service_role']) role
     where n.nspname = 'crm_private'
       and p.proname in ('studio_fee_for_price', 'statistics_studio_share')),
  'new private helpers are inaccessible to API roles'
);
select * from finish();
rollback;
