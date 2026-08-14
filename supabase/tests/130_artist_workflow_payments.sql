-- 130_artist_workflow_payments.sql
--
-- Artist-aware workflow and payment RPCs. Vladimir and Kristina have separate
-- synthetic payment destinations. No caller may choose another artist's route,
-- and provider webhooks derive artist ownership from the non-secret account
-- selector rather than accepting artist_id.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Synthetic staff, memberships and artist-owned records
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a7111111-1111-4111-8111-111111111111', 'workflow-owner@example.test'),
  ('a7222222-2222-4222-8222-222222222222', 'shared-finance@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('a7111111-1111-4111-8111-111111111111', 'workflow-owner@example.test',
   'Workflow Owner', 'owner', true),
  ('a7222222-2222-4222-8222-222222222222', 'shared-finance@example.test',
   'Shared Finance Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('a7222222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('a7222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('a7311111-1111-4111-8111-111111111111',
   'Vladimir Payment Client', 'vladimir-pay@example.test'),
  ('a7322222-2222-4222-8222-222222222222',
   'Kristina Payment Client', 'kristina-pay@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('a7411111-1111-4111-8111-111111111111',
   'a7311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'a7511111-1111-4111-8111-111111111111', repeat('7', 64),
   'accepted', 'complete', 'Vladimir Payment Client',
   'vladimir-pay@example.test', '2026-07-29', now()),
  ('a7422222-2222-4222-8222-222222222222',
   'a7322222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'PENDING', 'a7522222-2222-4222-8222-222222222222', repeat('8', 64),
   'accepted', 'complete', 'Kristina Payment Client',
   'kristina-pay@example.test', '2026-07-29', now());

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values
  ('a7611111-1111-4111-8111-111111111111',
   'a7311111-1111-4111-8111-111111111111',
   'a7411111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'Vladimir Payment Project', 'active', 'GBP'),
  ('a7622222-2222-4222-8222-222222222222',
   'a7322222-2222-4222-8222-222222222222',
   'a7422222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'Kristina Payment Project', 'active', 'GBP');

insert into public.sessions (
  id, project_id, artist_id, status, start_at, end_at
) values
  ('a7711111-1111-4111-8111-111111111111',
   'a7611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'proposed', now() + interval '30 days', now() + interval '30 days 7 hours'),
  ('a7722222-2222-4222-8222-222222222222',
   'a7622222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'proposed', now() + interval '31 days', now() + interval '31 days 7 hours');

-- ---------------------------------------------------------------------------
-- Separate business-account routes
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims(
  '{"sub":"a7111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select lives_ok(
  $$select public.configure_artist_integration(
      'a1111111-1111-4111-8111-111111111111',
      'payments', 'synthetic_pay', 'vladimir_business',
      'Vladimir synthetic business account',
      '{"environment":"test"}'::jsonb, true
    )$$,
  'the owner configures Vladimir synthetic payment destination'
);

select lives_ok(
  $$select public.configure_artist_integration(
      'a2222222-2222-4222-8222-222222222222',
      'payments', 'synthetic_pay', 'kristina_business',
      'Kristina synthetic business account',
      '{"environment":"test"}'::jsonb, true
    )$$,
  'the owner configures Kristina synthetic payment destination'
);

select throws_ok(
  $$select public.configure_artist_integration(
      'a2222222-2222-4222-8222-222222222222',
      'payments', 'synthetic_pay', 'vladimir_business',
      'Forbidden shared route', '{}'::jsonb, false
    )$$,
  '23505', null,
  'the same provider/account selector cannot belong to both artists'
);

select throws_ok(
  $$select public.configure_artist_integration(
      'a1111111-1111-4111-8111-111111111111',
      'payments', 'synthetic_pay', 'vladimir_second',
      'Forbidden second enabled route', '{}'::jsonb, true
    )$$,
  '23505', null,
  'one artist cannot have two enabled payment destinations'
);

select is(
  (select count(*)::int from public.artist_integrations
   where integration_type = 'payments' and is_enabled),
  2,
  'exactly one enabled payment destination exists per artist'
);

select lives_ok(
  $$select public.create_artist_payment_policy(
      'a1111111-1111-4111-8111-111111111111',
      1, 'fixed', 150.00, null, 72, true, 'vladimir-v1'
    )$$,
  'Vladimir receives an independent deposit policy'
);

select lives_ok(
  $$select public.create_artist_payment_policy(
      'a2222222-2222-4222-8222-222222222222',
      1, 'fixed', 200.00, null, 48, false, 'kristina-v1'
    )$$,
  'Kristina receives an independent deposit policy'
);

create temporary table v_request as
select public.create_payment_request(
  'a7811111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'a7311111-1111-4111-8111-111111111111',
  'deposit', 150.00,
  'a7611111-1111-4111-8111-111111111111',
  null, 'GBP', null
) as result;
grant select on v_request to authenticated, service_role;

select is(
  (select result ->> 'provider_account_key' from v_request),
  'vladimir_business',
  'Vladimir deposit resolves only to Vladimir business account'
);

select ok(
  not (select (result ->> 'replayed')::boolean from v_request),
  'the first Vladimir payment request is not a replay'
);

create temporary table v_replay as
select public.create_payment_request(
  'a7811111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'a7311111-1111-4111-8111-111111111111',
  'deposit', 150.00,
  'a7611111-1111-4111-8111-111111111111',
  null, 'GBP', null
) as result;

select ok(
  (select (result ->> 'replayed')::boolean from v_replay),
  'a retry returns the original Vladimir request without changing its route'
);

reset role;

-- The shared manager has Kristina finance authority but no Vladimir finance.
set local role authenticated;
select pg_temp.claims(
  '{"sub":"a7222222-2222-4222-8222-222222222222","role":"authenticated"}'
);

select throws_ok(
  $$select public.create_payment_request(
      'a7899999-9999-4999-8999-999999999999',
      'a1111111-1111-4111-8111-111111111111',
      'a7311111-1111-4111-8111-111111111111',
      'session_balance', 150.00,
      'a7611111-1111-4111-8111-111111111111',
      'a7711111-1111-4111-8111-111111111111', 'GBP', null
    )$$,
  '42501', null,
  'Kristina finance permission does not permit creating Vladimir payments'
);

create temporary table k_request as
select public.create_payment_request(
  'a7822222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'a7322222-2222-4222-8222-222222222222',
  'deposit', 200.00,
  'a7622222-2222-4222-8222-222222222222',
  null, 'GBP', null
) as result;
grant select on k_request to authenticated, service_role;

select is(
  (select result ->> 'provider_account_key' from k_request),
  'kristina_business',
  'Kristina deposit resolves only to Kristina business account'
);

select is(
  (select provider_account_key
   from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from k_request)),
  'kristina_business',
  'the stored Kristina request keeps Kristina route as immutable identity'
);

create temporary table manual_payment as
select public.record_manual_payment(
  (select (result ->> 'payment_request_id')::uuid from k_request),
  'a7911111-1111-4111-8111-111111111111',
  200.00,
  '2026-08-03T07:00:00Z'::timestamptz,
  'bank_transfer_received'
) as result;

select is(
  (select status::text
   from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from k_request)),
  'paid',
  'a full manual payment marks the Kristina request paid from the ledger'
);

select lives_ok(
  format(
    $$select public.record_manual_refund(%L, %L, 50.00, false,
              '2026-08-03T08:00:00Z'::timestamptz, 'partial_client_refund')$$,
    (select result ->> 'payment_request_id' from k_request),
    'a7922222-2222-4222-8222-222222222222'
  ),
  'Kristina finance manager may record a partial refund'
);

select is(
  (select status::text
   from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from k_request)),
  'partially_paid',
  'the partial refund returns the request to partially_paid'
);

reset role;

-- ---------------------------------------------------------------------------
-- Provider webhook routing derives the artist from the account selector
-- ---------------------------------------------------------------------------

create temporary table webhook_result (result jsonb);
grant insert, select on webhook_result to service_role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

insert into webhook_result
select public.register_payment_webhook_event(
  'synthetic_pay', 'kristina_business', 'evt_kristina_001', repeat('a', 64)
);

select is(
  (select result ->> 'artist_id' from webhook_result),
  'a2222222-2222-4222-8222-222222222222',
  'Kristina account selector resolves the webhook to Kristina without artist input'
);

select throws_ok(
  format(
    $$select public.record_provider_payment(%L, %L, %L,
              'txn_cross_artist', 50.00, true,
              '2026-08-03T09:00:00Z'::timestamptz)$$,
    (select result ->> 'payment_webhook_event_id' from webhook_result),
    (select result ->> 'payment_request_id' from v_request),
    'a7933333-3333-4333-8333-333333333333'
  ),
  '23514', null,
  'a Kristina webhook cannot be applied to Vladimir payment request'
);

select lives_ok(
  format(
    $$select public.record_provider_payment(%L, %L, %L,
              'txn_kristina_001', 50.00, true,
              '2026-08-03T09:00:00Z'::timestamptz)$$,
    (select result ->> 'payment_webhook_event_id' from webhook_result),
    (select result ->> 'payment_request_id' from k_request),
    'a7944444-4444-4444-8444-444444444444'
  ),
  'the matching Kristina webhook settles only Kristina request'
);

reset role;

select is(
  (select status::text
   from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from k_request)),
  'paid',
  'the matching provider payment restores the Kristina request to paid'
);

select is(
  (select count(*)::int
   from public.payment_transactions
   where payment_request_id =
         (select (result ->> 'payment_request_id')::uuid from k_request)
     and artist_id = 'a2222222-2222-4222-8222-222222222222'),
  3,
  'Kristina ledger contains manual payment, refund and provider payment only'
);

select is(
  (select count(*)::int
   from public.payment_transactions
   where payment_request_id =
         (select (result ->> 'payment_request_id')::uuid from v_request)),
  0,
  'the rejected cross-artist webhook created no Vladimir transaction'
);

-- ---------------------------------------------------------------------------
-- Trusted booking source selects Kristina; browser attribution cannot override
-- ---------------------------------------------------------------------------

update public.booking_sources
set allowed_origin = 'https://kristina.example.test',
    is_active = true
where source_key = 'kristina-website';

create temporary table trusted_intake (result jsonb);
grant insert, select on trusted_intake to service_role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

insert into trusted_intake
select public.create_trusted_enquiry_intake(
  'kristina-website',
  'https://kristina.example.test',
  'booking-v1',
  'a7955555-5555-4555-8555-555555555555',
  jsonb_build_object(
    'full_name', 'Trusted Kristina Client',
    'email', 'trusted-kristina@example.test'
  ),
  jsonb_build_object(
    'idea', 'Synthetic trusted intake',
    'source', 'vladimir-website',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  jsonb_build_array(
    jsonb_build_object(
      'mime_type', 'image/png',
      'safe_extension', 'png',
      'byte_size', 1024
    )
  )
);

select is(
  (select result ->> 'artist_id' from trusted_intake),
  'a2222222-2222-4222-8222-222222222222',
  'server source routing assigns the trusted intake to Kristina'
);

reset role;

select is(
  (select e.artist_id
   from public.enquiries e
   where e.id = (select (result ->> 'enquiry_id')::uuid from trusted_intake)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'browser attribution text cannot override the trusted artist assignment'
);

select is(
  (select s.source_key
   from public.enquiries e
   join public.booking_sources s on s.id = e.booking_source_id
   where e.id = (select (result ->> 'enquiry_id')::uuid from trusted_intake)),
  'kristina-website',
  'the enquiry stores the exact trusted booking source'
);

select is(
  (select count(*)::int
   from public.artist_integrations
   where integration_type = 'payments'
     and configuration ?| array[
       'token', 'secret', 'api_key', 'password', 'chat_id', 'account_number'
     ]),
  0,
  'payment route metadata contains no credential or bank-detail keys'
);

select * from finish(true);
rollback;
