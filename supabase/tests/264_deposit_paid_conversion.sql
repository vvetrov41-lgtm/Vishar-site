-- 264_deposit_paid_conversion.sql
--
-- Creating a project from an enquiry whose deposit has been PAID.
--
-- This is the reported production defect: on Kristina's side, an enquiry that
-- reached `deposit_paid` lost the "create project" path and answered with an
-- access error. Every leg of that path is currently open at production head -
-- the `deposit_paid -> converted` transition is seeded by 0001 with
-- `owner_only = false`, and a booking manager with `manager` access on the
-- artist resolves the legacy `manage` capability - but none of it was covered.
-- 260 asserts only the `deposit_requested` row, and asserts the ROW, not that a
-- conversion actually succeeds.
--
-- So this test exercises the whole path as the operator who hit it: a
-- booking_manager, artist-scoped by membership rather than by CRM role, on
-- Kristina's artist, converting from `deposit_paid`. Any of the four things
-- that could silently re-break it - the seeded transition, its `owner_only`
-- flag, the role gate inside the legacy converter, or the artist capability
-- grant - fails this test rather than reaching an operator.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

-- A booking manager, not an owner. The reported failure was an operator who
-- manages one artist, so an owner-only test would have passed while the real
-- account stayed broken.
create function pg_temp.as_kristina_manager() returns void language sql as $$
  select pg_temp.claims('{"sub":"fc111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_kristina_manager() to authenticated, service_role;

insert into auth.users (id, email) values
  ('fc111111-1111-4111-8111-111111111111', 'deposit-paid-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fc111111-1111-4111-8111-111111111111', 'deposit-paid-manager@example.test',
   'Deposit Paid Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'fc111111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true, false, true
)
on conflict do nothing;

insert into public.clients (id, full_name, email) values
  ('fc311111-1111-4111-8111-111111111111', 'Deposit Paid Client', null);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'fc411111-1111-4111-8111-111111111111',
  'fc311111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'PENDING', 'fc511111-1111-4111-8111-111111111111', repeat('c', 64),
  'deposit_paid', 'complete', 'Deposit Paid Client',
  'deposit-paid-client@example.test', '2026-08-05', now()
);

-- ---------------------------------------------------------------------------
-- The rule the interface depends on
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1 from public.enquiry_status_transitions
    where from_status = 'deposit_paid' and to_status = 'converted'
  ),
  'a paid deposit does not close the door to a project'
);

select is(
  (select owner_only from public.enquiry_status_transitions
   where from_status = 'deposit_paid' and to_status = 'converted'),
  false,
  'the artist''s own booking manager may convert, without waiting for the owner'
);

-- ---------------------------------------------------------------------------
-- The path an operator actually walks
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_kristina_manager();

select lives_ok(
  $$select public.convert_enquiry_to_project(
      'fc411111-1111-4111-8111-111111111111',
      'Deposit paid conversion'
    )$$,
  'a booking manager converts a deposit-paid enquiry on the artist they manage'
);

select is(
  (select status::text from public.enquiries
   where id = 'fc411111-1111-4111-8111-111111111111'),
  'converted',
  'the enquiry moves to converted rather than staying stuck on deposit_paid'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = 'fc411111-1111-4111-8111-111111111111'),
  1,
  'exactly one project exists for the converted enquiry'
);

-- Conversion is idempotent on replay, so a double submit from a slow phone
-- returns the same project instead of a second one or an error.
select is(
  (
    (public.convert_enquiry_to_project(
      'fc411111-1111-4111-8111-111111111111',
      'Deposit paid conversion'
    )) ->> 'replayed'
  )::boolean,
  true,
  'converting the same enquiry twice replays the first project'
);

reset role;
select pg_temp.claims('{"role":"service_role"}');

-- ---------------------------------------------------------------------------
-- The boundary is still a boundary
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('fc611111-1111-4111-8111-111111111111', 'Other Artist Client', null);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'fc711111-1111-4111-8111-111111111111',
  'fc611111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'fc811111-1111-4111-8111-111111111111', repeat('d', 64),
  'deposit_paid', 'complete', 'Other Artist Client',
  'other-artist-client@example.test', '2026-08-05', now()
);

set local role authenticated;
select pg_temp.as_kristina_manager();

select throws_ok(
  $$select public.convert_enquiry_to_project(
      'fc711111-1111-4111-8111-111111111111',
      'Should not convert'
    )$$,
  '42501',
  'artist access is not permitted',
  'making the deposit-paid path work does not let one artist''s manager convert another artist''s enquiry'
);

reset role;

select * from finish();
rollback;
