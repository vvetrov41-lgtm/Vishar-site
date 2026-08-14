-- 140_owner_artist_transfer.sql
--
-- Owner-only atomic artist transfer before payment, calendar, trusted-source or
-- routed integration state exists. Historical activity remains append-only in
-- its original artist scope.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('b8111111-1111-4111-8111-111111111111', 'transfer-owner@example.test'),
  ('b8222222-2222-4222-8222-222222222222', 'transfer-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('b8111111-1111-4111-8111-111111111111', 'transfer-owner@example.test',
   'Transfer Owner', 'owner', true),
  ('b8222222-2222-4222-8222-222222222222', 'transfer-manager@example.test',
   'Transfer Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('b8222222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('b8222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'manager', false, false, true, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

insert into public.clients (id, full_name, email) values
  ('b8311111-1111-4111-8111-111111111111',
   'Transfer Client', 'transfer-client@example.test'),
  ('b8322222-2222-4222-8222-222222222222',
   'Paid Transfer Client', 'paid-transfer@example.test'),
  ('b8333333-3333-4333-8333-333333333333',
   'Source Transfer Client', 'source-transfer@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at,
  assigned_to
) values
  ('b8411111-1111-4111-8111-111111111111',
   'b8311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'b8511111-1111-4111-8111-111111111111', repeat('1', 64),
   'accepted', 'complete', 'Transfer Client',
   'transfer-client@example.test', '2026-07-29', now(),
   'b8222222-2222-4222-8222-222222222222'),
  ('b8422222-2222-4222-8222-222222222222',
   'b8322222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'b8522222-2222-4222-8222-222222222222', repeat('2', 64),
   'accepted', 'complete', 'Paid Transfer Client',
   'paid-transfer@example.test', '2026-07-29', now(), null),
  ('b8433333-3333-4333-8333-333333333333',
   'b8333333-3333-4333-8333-333333333333',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'b8533333-3333-4333-8333-333333333333', repeat('3', 64),
   'reviewing', 'complete', 'Source Transfer Client',
   'source-transfer@example.test', '2026-07-29', now(), null);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values
  ('b8611111-1111-4111-8111-111111111111',
   'b8311111-1111-4111-8111-111111111111',
   'b8411111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'Transferable Project', 'active', 'GBP'),
  ('b8622222-2222-4222-8222-222222222222',
   'b8322222-2222-4222-8222-222222222222',
   'b8422222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'Paid Project', 'active', 'GBP');

insert into public.sessions (
  id, project_id, artist_id, status, start_at, end_at
) values
  ('b8711111-1111-4111-8111-111111111111',
   'b8611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'proposed', now() + interval '40 days', now() + interval '40 days 6 hours');

insert into public.follow_ups (
  id, artist_id, subject, due_at, client_id, enquiry_id, project_id,
  assigned_to, created_by
) values (
  'b8811111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Transfer follow-up', now() + interval '2 days',
  'b8311111-1111-4111-8111-111111111111',
  'b8411111-1111-4111-8111-111111111111',
  'b8611111-1111-4111-8111-111111111111',
  'b8222222-2222-4222-8222-222222222222',
  'b8111111-1111-4111-8111-111111111111'
);

insert into public.email_messages (
  id, artist_id, status, client_id, enquiry_id, project_id,
  to_email, subject, body, created_by, created_by_kind
) values (
  'b8911111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'draft',
  'b8311111-1111-4111-8111-111111111111',
  'b8411111-1111-4111-8111-111111111111',
  'b8611111-1111-4111-8111-111111111111',
  'transfer-client@example.test', 'Transfer draft', 'Synthetic body',
  'b8111111-1111-4111-8111-111111111111', 'human'
);

-- Historical activity intentionally keeps the original artist after transfer.
insert into public.activity_log (
  id, artist_id, event_type, actor_kind, actor_profile_id,
  client_id, enquiry_id, project_id, metadata
) values (
  'b8a11111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'project.reviewed', 'owner',
  'b8111111-1111-4111-8111-111111111111',
  'b8311111-1111-4111-8111-111111111111',
  'b8411111-1111-4111-8111-111111111111',
  'b8611111-1111-4111-8111-111111111111',
  '{}'::jsonb
);

-- A separate project already has ledger identity and must stay with Vladimir.
insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency, provider, provider_account_key,
  status, created_by
) values (
  'b8b11111-1111-4111-8111-111111111111',
  'b8b22222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'b8322222-2222-4222-8222-222222222222',
  'b8622222-2222-4222-8222-222222222222',
  'session_balance', 300.00, 'GBP',
  'synthetic_pay', 'vladimir_business', 'pending',
  'b8111111-1111-4111-8111-111111111111'
);

-- A trusted source is immutable provenance and also blocks reassignment.
update public.booking_sources
set allowed_origin = 'https://vladimir.example.test',
    is_active = true
where source_key = 'vladimir-website';

update public.enquiries
set booking_source_id = (
  select id from public.booking_sources where source_key = 'vladimir-website'
)
where id = 'b8433333-3333-4333-8333-333333333333';

-- ---------------------------------------------------------------------------
-- Manager denied; owner succeeds only for clean work
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims(
  '{"sub":"b8222222-2222-4222-8222-222222222222","role":"authenticated"}'
);

select throws_ok(
  $$select public.transfer_work_to_artist(
      'b8411111-1111-4111-8111-111111111111', null,
      'a2222222-2222-4222-8222-222222222222', 'workload_balance'
    )$$,
  '42501', null,
  'a shared manager cannot transfer work between artists'
);

reset role;
set local role authenticated;
select pg_temp.claims(
  '{"sub":"b8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select throws_ok(
  $$update public.projects
    set artist_id = 'a2222222-2222-4222-8222-222222222222'
    where id = 'b8611111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'even the owner cannot bypass the protected RPC with a direct table update'
);

create temporary table transfer_result as
select public.transfer_work_to_artist(
  'b8411111-1111-4111-8111-111111111111', null,
  'a2222222-2222-4222-8222-222222222222', 'workload_balance'
) as result;

select ok(
  (select (result ->> 'changed')::boolean from transfer_result),
  'the owner transfer reports a real change'
);

select is(
  (select artist_id from public.enquiries
   where id = 'b8411111-1111-4111-8111-111111111111'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the enquiry moves to Kristina'
);

select is(
  (select artist_id from public.projects
   where id = 'b8611111-1111-4111-8111-111111111111'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the linked project moves to Kristina'
);

select is(
  (select artist_id from public.sessions
   where id = 'b8711111-1111-4111-8111-111111111111'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the linked session moves to Kristina'
);

select is(
  (select artist_id from public.follow_ups
   where id = 'b8811111-1111-4111-8111-111111111111'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the linked follow-up moves to Kristina'
);

select is(
  (select assigned_to from public.follow_ups
   where id = 'b8811111-1111-4111-8111-111111111111'),
  'b8222222-2222-4222-8222-222222222222'::uuid,
  'a shared manager remains assigned because they also manage Kristina'
);

select is(
  (select artist_id from public.email_messages
   where id = 'b8911111-1111-4111-8111-111111111111'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the unsent draft moves to Kristina'
);

select is(
  (select assigned_to from public.enquiries
   where id = 'b8411111-1111-4111-8111-111111111111'),
  null::uuid,
  'the enquiry assignment is cleared for explicit reassignment'
);

select is(
  (select artist_id from public.activity_log
   where id = 'b8a11111-1111-4111-8111-111111111111'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'historical activity remains in the original Vladimir scope'
);

select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'artist.work_transferred'
     and artist_id = 'a2222222-2222-4222-8222-222222222222'
     and enquiry_id = 'b8411111-1111-4111-8111-111111111111'),
  1,
  'one owner-only transfer event is written in the new artist scope'
);

select ok(
  (select metadata ->> 'from_artist_id' =
          'a1111111-1111-4111-8111-111111111111'
      and metadata ->> 'to_artist_id' =
          'a2222222-2222-4222-8222-222222222222'
      and metadata ->> 'reason_code' = 'workload_balance'
   from public.activity_log
   where event_type = 'artist.work_transferred'
     and enquiry_id = 'b8411111-1111-4111-8111-111111111111'),
  'the transfer audit records source, destination and safe reason code'
);

select throws_ok(
  $$select public.transfer_work_to_artist(
      null, 'b8622222-2222-4222-8222-222222222222',
      'a2222222-2222-4222-8222-222222222222', 'workload_balance'
    )$$,
  '23514', null,
  'a project with a payment request cannot be moved to another business account'
);

select throws_ok(
  $$select public.transfer_work_to_artist(
      'b8433333-3333-4333-8333-333333333333', null,
      'a2222222-2222-4222-8222-222222222222', 'workload_balance'
    )$$,
  '23514', null,
  'a trusted-source enquiry cannot contradict its source-to-artist provenance'
);

create temporary table no_op_result as
select public.transfer_work_to_artist(
  'b8411111-1111-4111-8111-111111111111', null,
  'a2222222-2222-4222-8222-222222222222', 'workload_balance'
) as result;

select ok(
  not (select (result ->> 'changed')::boolean from no_op_result),
  'repeating the transfer to the current artist is an idempotent no-op'
);

select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'artist.work_transferred'
     and enquiry_id = 'b8411111-1111-4111-8111-111111111111'),
  1,
  'an exact no-op retry creates no duplicate transfer audit event'
);

select * from finish(true);
rollback;
