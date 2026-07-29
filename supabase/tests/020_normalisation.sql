-- 020_normalisation.sql
--
-- Deterministic email and phone normalisation, and the generated columns that
-- make the normalised values impossible to write directly.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Email: trim and lowercase, nothing else
-- ---------------------------------------------------------------------------

select is(public.normalize_email('  Client@Example.TEST '), 'client@example.test',
          'email is trimmed and lowercased');
select is(public.normalize_email('CLIENT@EXAMPLE.TEST'), 'client@example.test',
          'uppercase email normalises to lowercase');
select is(public.normalize_email(null), null, 'null email normalises to null');
select is(public.normalize_email('   '), null, 'blank email normalises to null');

-- Plus aliases and dots are preserved. Rewriting them would merge two people
-- who genuinely have different addresses at providers that treat them as
-- distinct.
select is(public.normalize_email('Client+Tattoo@Example.test'), 'client+tattoo@example.test',
          'a plus alias is preserved');
select isnt(public.normalize_email('client+tattoo@example.test'),
            public.normalize_email('client@example.test'),
            'a plus alias is NOT collapsed onto the base address');
select is(public.normalize_email('first.last@example.test'), 'first.last@example.test',
          'dots inside the local part are preserved');
select isnt(public.normalize_email('first.last@example.test'),
            public.normalize_email('firstlast@example.test'),
            'dots are NOT stripped');

-- ---------------------------------------------------------------------------
-- Phone: conservative, and never guesses a country
-- ---------------------------------------------------------------------------

select is(public.normalize_phone('+44 7700 900123'), '+447700900123',
          'an international number keeps its country code and loses formatting');
select is(public.normalize_phone('+44 (0)20 7946 0000'), '+442079460000',
          'the standard (0) trunk indicator is removed along with spacing');
select is(public.normalize_phone('+44 (020) 7946 0000'), null,
          'an ambiguous parenthesised group is rejected rather than mis-parsed');
select is(public.normalize_phone('+0 7700 900123'), null,
          'a leading zero after + is not a valid country code and is rejected');
select is(public.normalize_phone('0044 7700 900123'), '+447700900123',
          'a 00 prefix becomes +');
select is(public.normalize_phone('+1-202-555-0143'), '+12025550143',
          'a non-UK international number normalises the same way');

select is(public.normalize_phone('07700 900123'), null,
          'a national-format number returns NULL rather than guessing a country code');
select is(public.normalize_phone('020 7946 0000'), null,
          'a national landline returns NULL rather than guessing a country code');
select is(public.normalize_phone(null), null, 'null phone normalises to null');
select is(public.normalize_phone('   '), null, 'blank phone normalises to null');
select is(public.normalize_phone('call me maybe'), null,
          'free text is rejected instead of having its letters stripped out');
select is(public.normalize_phone('+44 7700 900123 ext 4'), null,
          'a value with unexpected characters is rejected rather than partially parsed');
select is(public.normalize_phone('+123'), null, 'too few digits is rejected');
select is(public.normalize_phone('+1234567890123456789'), null,
          'more than 15 digits exceeds E.164 and is rejected');

-- Determinism: the same input always gives the same output.
select is(public.normalize_phone('+44 7700 900123'), public.normalize_phone('+447700900123'),
          'formatting differences normalise to the same value');
select is(public.normalize_email(' A@B.test'), public.normalize_email('a@b.TEST'),
          'case and whitespace differences normalise to the same value');

-- ---------------------------------------------------------------------------
-- Generated columns
-- ---------------------------------------------------------------------------

-- Direct fixture writes run as the privileged test owner. They test generated
-- columns and constraints, not an application-role table-access path.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'owner@example.test');
insert into public.profiles (id, email, role, is_active)
values ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

insert into public.clients (id, full_name, email, phone)
values ('c0000000-0000-4000-8000-000000000001', 'Norm Fixture', '  Norm@Example.TEST ', '+44 7700 900999');

select is((select email_normalized from public.clients where id = 'c0000000-0000-4000-8000-000000000001'),
          'norm@example.test', 'email_normalized is maintained by the database');
select is((select phone_normalized from public.clients where id = 'c0000000-0000-4000-8000-000000000001'),
          '+447700900999', 'phone_normalized is maintained by the database');

insert into public.clients (id, full_name, email, phone)
values ('c0000000-0000-4000-8000-000000000002', 'National Number', 'nat@example.test', '07700 900123');

select is((select phone_normalized from public.clients where id = 'c0000000-0000-4000-8000-000000000002'),
          null, 'a national-format phone leaves phone_normalized NULL, so it is never a match key');
select is((select phone from public.clients where id = 'c0000000-0000-4000-8000-000000000002'),
          '07700 900123', 'the raw phone is still stored and remains searchable');

-- A generated column cannot be written directly, so no backend bug can inject
-- a wrong match key.
select throws_ok(
  $$insert into public.clients (full_name, email, email_normalized)
    values ('Forged', 'real@example.test', 'someone.else@example.test')$$,
  '428C9', null,
  'email_normalized cannot be supplied by the caller'
);

select throws_ok(
  $$update public.clients set phone_normalized = '+440000000000'
    where id = 'c0000000-0000-4000-8000-000000000001'$$,
  '428C9', null,
  'phone_normalized cannot be overwritten by the caller'
);

select * from finish(true);
rollback;
