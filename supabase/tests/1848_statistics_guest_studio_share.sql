-- Session-level guest studio commission overrides. Test DB only; no production data changes.
begin;
select no_plan();
select ok(to_regclass('crm_private.session_studio_fee_overrides') is not null,
  'guest overrides stored in a private table');
select is(crm_private.studio_fee_for_price(980), 180::numeric,
  'ordinary studio keeps flat £180 at £980');
select is(crm_private.studio_fee_for_price(980, null), 180::numeric,
  'no guest override keeps flat £180');
select is(crm_private.studio_fee_for_price(980, 30), 294::numeric,
  '£980 guest day at 30 percent = £294');
select is(crm_private.studio_fee_for_price(420, 30), 126::numeric,
  '£420 guest day at 30 percent = £126');
select is(crm_private.studio_fee_for_price(420, null), 126::numeric,
  'normal £420 day stays at £126');
select is(crm_private.studio_fee_for_price(0, 30), 0::numeric,
  'zero-priced guest session never creates a fee');
select is(crm_private.studio_fee_for_price(null, 30), null::numeric,
  'missing price cannot fabricate a fee');
select is(crm_private.studio_fee_for_price(980, -1), null::numeric,
  'invalid negative override is rejected');
select is((select sum(crm_private.studio_fee_for_price(price, guest_percent))
  from (values (980::numeric,30::numeric),(420::numeric,30::numeric)) v(price,guest_percent)),
  420::numeric, 'two guest days: studio £420, artist £980');
select is((select sum(crm_private.studio_fee_for_price(price, guest_percent))
  from (values (980::numeric,null::numeric),(420::numeric,null::numeric)) v(price,guest_percent)),
  306::numeric, 'two ordinary days: original studio £306');
select ok(
  pg_get_functiondef('crm_private.statistics_studio_share(uuid,timestamptz,timestamptz)'::regprocedure)
    like '%left join crm_private.session_studio_fee_overrides o on o.session_id = s.id%'
  and pg_get_functiondef('crm_private.statistics_studio_share(uuid,timestamptz,timestamptz)'::regprocedure)
    like '%studio_fee_for_price(price, fee_percent)%',
  'statistics joins exact session override and chooses fee per session'
);
select ok(
  (select bool_and(not has_table_privilege(role, 'crm_private.session_studio_fee_overrides', 'SELECT'))
     from unnest(array['anon','authenticated','service_role']) role),
  'override table is inaccessible to API roles'
);
select ok(
  (select bool_and(not has_function_privilege(role,
    'crm_private.studio_fee_for_price(numeric,numeric)', 'EXECUTE'))
     from unnest(array['anon','authenticated','service_role']) role),
  'override helper inaccessible to API roles'
);
select * from finish();
rollback;
