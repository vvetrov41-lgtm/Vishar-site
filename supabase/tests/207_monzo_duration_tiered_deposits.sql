-- 207_monzo_duration_tiered_deposits.sql
-- Synthetic-only validation for server-owned Monzo duration deposit tiers.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('d7111111-1111-4111-8111-111111111111', 'tier-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('d7111111-1111-4111-8111-111111111111', 'tier-owner@example.test', 'Tier Test Owner', 'owner', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('d7211111-1111-4111-8111-111111111111', 'Tier Deposit Client', 'tier-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'd7311111-1111-4111-8111-111111111111',
  'd7211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'd7411111-1111-4111-8111-111111111111', repeat('d', 64),
  'accepted', 'complete', 'Tier Deposit Client', 'tier-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'd7511111-1111-4111-8111-111111111111',
  'd7211111-1111-4111-8111-111111111111',
  'd7311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Tier Deposit Project', 'active', 'GBP'
);

-- Production appointments use five-minute increments. The first valid duration
-- above each inclusive threshold is therefore 65, 185 and 305 minutes.
-- start_at/end_at remain authoritative; duration_hours is deliberately omitted.
insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('d7611111-1111-4111-8111-111111111111', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '30 days 10 hours', date_trunc('day', now()) + interval '30 days 11 hours'),
  ('d7622222-2222-4222-8222-222222222222', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '31 days 10 hours', date_trunc('day', now()) + interval '31 days 11 hours 5 minutes'),
  ('d7633333-3333-4333-8333-333333333333', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '32 days 10 hours', date_trunc('day', now()) + interval '32 days 13 hours'),
  ('d7644444-4444-4444-8444-444444444444', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '33 days 10 hours', date_trunc('day', now()) + interval '33 days 13 hours 5 minutes'),
  ('d7655555-5555-4555-8555-555555555555', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '34 days 10 hours', date_trunc('day', now()) + interval '34 days 15 hours'),
  ('d7666666-6666-4666-8666-666666666666', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '35 days 10 hours', date_trunc('day', now()) + interval '35 days 15 hours 5 minutes'),
  ('d7677777-7777-4777-8777-777777777777', 'd7511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '36 days 10 hours', date_trunc('day', now()) + interval '36 days 17 hours');

set local role authenticated;
select pg_temp.claims('{"sub":"d7111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-tiered-deposits', true
    )$$,
  'owner configures the duration-tiered synthetic Monzo route'
);

select is(
  (select deposit_mode::text from public.artist_payment_policies
   where artist_id = 'a1111111-1111-4111-8111-111111111111' and is_active),
  'per_session_fixed',
  'Monzo setup uses the versioned per-session payment-policy mode'
);
select is(
  jsonb_array_length(
    public.get_monzo_easy_bank_transfer_settings('a1111111-1111-4111-8111-111111111111') -> 'deposit_tiers'
  ),
  4,
  'the safe settings RPC exposes exactly four non-secret duration tiers'
);

create temporary table tier_results (
  session_id uuid primary key,
  result jsonb not null
);
grant select on tier_results to authenticated, service_role;

insert into tier_results values
  ('d7611111-1111-4111-8111-111111111111', public.request_session_deposit('d7611111-1111-4111-8111-111111111111', 'd7711111-1111-4111-8111-111111111111', 'copy_link')),
  ('d7622222-2222-4222-8222-222222222222', public.request_session_deposit('d7622222-2222-4222-8222-222222222222', 'd7722222-2222-4222-8222-222222222222', 'copy_link')),
  ('d7633333-3333-4333-8333-333333333333', public.request_session_deposit('d7633333-3333-4333-8333-333333333333', 'd7733333-3333-4333-8333-333333333333', 'copy_link')),
  ('d7644444-4444-4444-8444-444444444444', public.request_session_deposit('d7644444-4444-4444-8444-444444444444', 'd7744444-4444-4444-8444-444444444444', 'copy_link')),
  ('d7655555-5555-4555-8555-555555555555', public.request_session_deposit('d7655555-5555-4555-8555-555555555555', 'd7755555-5555-4555-8555-555555555555', 'copy_link')),
  ('d7666666-6666-4666-8666-666666666666', public.request_session_deposit('d7666666-6666-4666-8666-666666666666', 'd7766666-6666-4666-8666-666666666666', 'copy_link')),
  ('d7677777-7777-4777-8777-777777777777', public.request_session_deposit('d7677777-7777-4777-8777-777777777777', 'd7777777-7777-4777-8777-777777777777', 'copy_link'));

select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7611111-1111-4111-8111-111111111111'), 50::numeric,
  'exactly 60 minutes requires GBP 50');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7622222-2222-4222-8222-222222222222'), 100::numeric,
  '65 minutes, the first valid appointment duration above one hour, requires GBP 100');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7633333-3333-4333-8333-333333333333'), 100::numeric,
  'exactly 180 minutes requires GBP 100');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7644444-4444-4444-8444-444444444444'), 150::numeric,
  '185 minutes, the first valid appointment duration above three hours, requires GBP 150');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7655555-5555-4555-8555-555555555555'), 150::numeric,
  'exactly 300 minutes requires GBP 150');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7666666-6666-4666-8666-666666666666'), 250::numeric,
  '305 minutes, the first valid appointment duration above five hours, requires the GBP 250 full-day deposit');
select is((select (result ->> 'amount')::numeric from tier_results where session_id = 'd7677777-7777-4777-8777-777777777777'), 250::numeric,
  'a seven-hour session remains GBP 250');

select throws_ok(
  $$select public.create_payment_request(
      'd7811111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'd7211111-1111-4111-8111-111111111111',
      'deposit', 250.00,
      'd7511111-1111-4111-8111-111111111111',
      'd7611111-1111-4111-8111-111111111111',
      'GBP', null
    )$$,
  '22023', 'session deposit amount must match the server duration policy',
  'the lower-level payment RPC cannot override the server-calculated session tier'
);

-- Rescheduling an already-issued one-hour request into a larger tier must not
-- silently mutate or replace the immutable GBP 50 request.
reset role;
update public.sessions
set end_at = start_at + interval '2 hours'
where id = 'd7611111-1111-4111-8111-111111111111';

set local role authenticated;
select pg_temp.claims('{"sub":"d7111111-1111-4111-8111-111111111111","role":"authenticated"}');
select throws_ok(
  $$select public.request_session_deposit(
      'd7611111-1111-4111-8111-111111111111',
      'd7822222-2222-4222-8222-222222222222',
      'copy_link'
    )$$,
  '22023', 'an existing deposit request uses different payment terms',
  'a duration change never silently reprices an existing pending request'
);

select ok(
  not has_table_privilege('authenticated', 'public.artist_payment_policy_session_tiers', 'select')
  and not has_table_privilege('authenticated', 'public.artist_payment_policy_session_tiers', 'insert')
  and not has_table_privilege('authenticated', 'public.artist_payment_policy_session_tiers', 'update')
  and not has_table_privilege('authenticated', 'public.artist_payment_policy_session_tiers', 'delete'),
  'duration tier rows have no direct browser grants'
);

select * from finish();
rollback;
