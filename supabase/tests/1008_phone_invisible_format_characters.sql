-- 1008_phone_invisible_format_characters.sql
-- Audit M-3 follow-up: invisible format characters never block normalisation.
begin;
select no_plan();

select is(crm_private.strip_invisible_format('07911 123456' || chr(8236)), '07911 123456', 'U+202C is removed');
select is(crm_private.strip_invisible_format(chr(65279) || '+44 7911'), '+44 7911', 'a byte-order mark is removed');
select is(crm_private.strip_invisible_format('07911-123 456'), '07911-123 456', 'visible characters are untouched');

insert into public.clients (id, full_name, phone, travelling_from) values
  ('e6011111-1111-4111-8111-111111111111', 'Bidi Local', '07911 123456' || chr(8236), 'London'),
  ('e6021111-1111-4111-8111-111111111111', 'Bidi Intl', chr(8206) || '+61 412 345 678', null),
  ('e6031111-1111-4111-8111-111111111111', 'Bidi Unknown', '07922 123456' || chr(8236), null);

select results_eq(
  $$select phone, phone_normalized, phone_normalization_basis from public.clients where id = 'e6011111-1111-4111-8111-111111111111'$$,
  $$values ('+447911123456'::text, '+447911123456'::text, 'travelling_from:GB'::text)$$,
  'a pasted local number with a bidi mark converts on explicit evidence'
);
select results_eq(
  $$select phone, phone_normalized, phone_normalization_basis from public.clients where id = 'e6021111-1111-4111-8111-111111111111'$$,
  $$values ('+61 412 345 678'::text, '+61412345678'::text, null::text)$$,
  'an international number is cleaned without any country evidence'
);
select is((select phone_normalized from public.clients where id = 'e6031111-1111-4111-8111-111111111111'), null,
  'cleanup never replaces missing country evidence');
select is((select phone_input from public.clients where id = 'e6011111-1111-4111-8111-111111111111'),
  '07911 123456' || chr(8236), 'the value as entered is preserved');

select * from finish(true);
rollback;
