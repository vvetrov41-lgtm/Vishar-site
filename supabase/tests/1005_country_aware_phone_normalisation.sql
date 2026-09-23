-- 1005_country_aware_phone_normalisation.sql
--
-- Audit M-3: a local-format phone is converted only on explicit, agreeing,
-- structured location evidence; everything else is left exactly as entered.

begin;
select no_plan();

-- Country evidence.
select is(crm_private.country_from_location('London'), 'GB', 'a UK city is UK evidence');
select is(crm_private.country_from_location('Liverpool, United Kingdom'), 'GB', 'agreeing parts resolve');
select is(crm_private.country_from_location('australia'), 'AU', 'a country name resolves');
select is(crm_private.country_from_location('London, Ontario'), null, 'an unknown part makes the evidence ambiguous');
select is(crm_private.country_from_location('London, Sydney'), null, 'conflicting parts resolve to nothing');
select is(crm_private.country_from_location('Tokyo'), null, 'an unsupported place is not guessed');
select is(crm_private.country_from_location(null), null, 'no evidence is no country');

-- Local conversion.
select is(crm_private.normalize_local_phone('07911 123456', 'GB'), '+447911123456', 'UK + 07 mobile converts');
select is(crm_private.normalize_local_phone('0412 345 678', 'AU'), '+61412345678', 'AU + 04 mobile converts');
select is(crm_private.normalize_local_phone('07911 123456', 'AU'), null, 'a UK-shaped number under non-UK evidence is not converted');
select is(crm_private.normalize_local_phone('07911 123456', null), null, 'unknown country is not converted');
select is(crm_private.normalize_local_phone('+44 7911 123456', 'GB'), null, 'international input is left to normalize_phone');
select is(crm_private.normalize_local_phone('0791', 'GB'), null, 'a short number is not converted');

select is(crm_private.client_phone_e164('+1 415 555 0100', 'London'), '+14155550100',
  'an existing country code is authoritative over location evidence');

-- Client rows.
insert into public.clients (id, full_name, phone, travelling_from) values
  ('e3011111-1111-4111-8111-111111111111', 'UK Local', '07911 123456', 'London'),
  ('e3021111-1111-4111-8111-111111111111', 'Explicit Intl', '+44 7922 123456', 'Tokyo'),
  ('e3031111-1111-4111-8111-111111111111', 'No Evidence', '07933 123456', null),
  ('e3041111-1111-4111-8111-111111111111', 'Conflict', '07944 123456', 'London, Sydney');

select results_eq(
  $$select phone, phone_normalized, phone_input, phone_normalization_basis
    from public.clients where id = 'e3011111-1111-4111-8111-111111111111'$$,
  $$values ('+447911123456'::text, '+447911123456'::text, '07911 123456'::text, 'travelling_from:GB'::text)$$,
  'UK evidence converts the stored phone and keeps the raw value and basis'
);
select results_eq(
  $$select phone, phone_normalized, phone_input from public.clients where id = 'e3021111-1111-4111-8111-111111111111'$$,
  $$values ('+44 7922 123456'::text, '+447922123456'::text, null::text)$$,
  'an explicit +44 number is kept as entered'
);
select results_eq(
  $$select phone, phone_normalized from public.clients where id in ('e3031111-1111-4111-8111-111111111111','e3041111-1111-4111-8111-111111111111') order by id$$,
  $$values ('07933 123456'::text, null::text), ('07944 123456'::text, null::text)$$,
  'missing or conflicting evidence leaves the raw value unresolved'
);

update public.clients set phone = phone where id = 'e3011111-1111-4111-8111-111111111111';
select results_eq(
  $$select phone, phone_input from public.clients where id = 'e3011111-1111-4111-8111-111111111111'$$,
  $$values ('+447911123456'::text, '07911 123456'::text)$$,
  'repeated normalisation is a no-op'
);

update public.clients set travelling_from = 'Manchester' where id = 'e3031111-1111-4111-8111-111111111111';
select is((select phone_normalized from public.clients where id = 'e3031111-1111-4111-8111-111111111111'),
  '+447933123456', 'evidence added later converts the number');

insert into public.clients (id, full_name, phone, travelling_from) values
  ('e3051111-1111-4111-8111-111111111111', 'Duplicate', '07911 123456', 'Leeds');
select results_eq(
  $$select phone, phone_normalized from public.clients where id = 'e3051111-1111-4111-8111-111111111111'$$,
  $$values ('07911 123456'::text, null::text)$$,
  'a conversion that would duplicate another client''s number is not made'
);
select is(crm_private.client_phone_e164('07911 123456', 'Leeds'), '+447911123456',
  'intake matching resolves the same local number to the existing client');

select ok(not has_function_privilege('authenticated', 'crm_private.client_phone_e164(text,text)', 'EXECUTE'),
  'the normalisation helpers are not API-callable');

select * from finish(true);
rollback;
