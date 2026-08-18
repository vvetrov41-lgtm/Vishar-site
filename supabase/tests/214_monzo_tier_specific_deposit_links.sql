-- 214_monzo_tier_specific_deposit_links.sql
-- Synthetic-only validation that closed reusable Monzo destinations are
-- selected from the immutable server-calculated payment request amount.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e8111111-1111-4111-8111-111111111111', 'tier-links-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e8111111-1111-4111-8111-111111111111', 'tier-links-owner@example.test', 'Tier Links Owner', 'owner', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('e8211111-1111-4111-8111-111111111111', 'Tier Links Client', 'tier-links-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e8311111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e8411111-1111-4111-8111-111111111111', repeat('e', 64),
  'accepted', 'complete', 'Tier Links Client', 'tier-links-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'e8511111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'e8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Tier Links Project', 'active', 'GBP'
);

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('e8611111-1111-4111-8111-111111111111', 'e8511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '40 days 10 hours', date_trunc('day', now()) + interval '40 days 11 hours'),
  ('e8622222-2222-4222-8222-222222222222', 'e8511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '41 days 10 hours', date_trunc('day', now()) + interval '41 days 13 hours'),
  ('e8633333-3333-4333-8333-333333333333', 'e8511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '42 days 10 hours', date_trunc('day', now()) + interval '42 days 15 hours'),
  ('e8644444-4444-4444-8444-444444444444', 'e8511111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'proposed', date_trunc('day', now()) + interval '43 days 10 hours', date_trunc('day', now()) + interval '43 days 17 hours');

-- Reuse the established authenticated finance RPC for the enabled provider,
-- active duration policy and the GBP 250 compatibility destination.
set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-tier-250',
      true
    )$$,
  'existing finance RPC configures the provider without exposing tier routing'
);
reset role;

-- Tier destinations model protected operational provisioning, not a browser
-- API. Fixture setup therefore uses the privileged migration/test owner.
insert into public.monzo_easy_bank_transfer_tier_urls (
  artist_id, amount, currency, payment_url
) values
  ('a1111111-1111-4111-8111-111111111111',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-tier-50'),
  ('a1111111-1111-4111-8111-111111111111', 100.00, 'GBP', 'https://monzo.com/pay/r/synthetic-tier-100'),
  ('a1111111-1111-4111-8111-111111111111', 150.00, 'GBP', 'https://monzo.com/pay/r/synthetic-tier-150'),
  ('a1111111-1111-4111-8111-111111111111', 250.00, 'GBP', 'https://monzo.com/pay/r/synthetic-tier-250');

select throws_ok(
  $$insert into public.monzo_easy_bank_transfer_tier_urls
      (artist_id, amount, currency, payment_url)
    values
      ('a1111111-1111-4111-8111-111111111111', 50.00, 'GBP',
       'https://monzo.com/pay/r/synthetic-tier-100')$$,
  '23505', null,
  'one artist cannot reuse the same Monzo destination across deposit amounts'
);

create temporary table tier_link_results (
  expected_amount numeric primary key,
  payment_request_id uuid not null,
  public_id uuid
);
grant select, insert on tier_link_results to authenticated;
grant select on tier_link_results to service_role;

set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');
insert into tier_link_results (expected_amount, payment_request_id) values
  (50.00,  (public.request_session_deposit('e8611111-1111-4111-8111-111111111111', 'e8711111-1111-4111-8111-111111111111', 'copy_link') ->> 'payment_request_id')::uuid),
  (100.00, (public.request_session_deposit('e8622222-2222-4222-8222-222222222222', 'e8722222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid),
  (150.00, (public.request_session_deposit('e8633333-3333-4333-8333-333333333333', 'e8733333-3333-4333-8333-333333333333', 'copy_link') ->> 'payment_request_id')::uuid),
  (250.00, (public.request_session_deposit('e8644444-4444-4444-8444-444444444444', 'e8744444-4444-4444-8444-444444444444', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

update tier_link_results r
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = r.payment_request_id;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect((select public_id from tier_link_results where expected_amount = 50.00)),
  'https://monzo.com/pay/r/synthetic-tier-50',
  'GBP 50 request resolves only to the GBP 50 reusable URL'
);
select is(
  public.resolve_monzo_deposit_redirect((select public_id from tier_link_results where expected_amount = 100.00)),
  'https://monzo.com/pay/r/synthetic-tier-100',
  'GBP 100 request resolves only to the GBP 100 reusable URL'
);
select is(
  public.resolve_monzo_deposit_redirect((select public_id from tier_link_results where expected_amount = 150.00)),
  'https://monzo.com/pay/r/synthetic-tier-150',
  'GBP 150 request resolves only to the GBP 150 reusable URL'
);
select is(
  public.resolve_monzo_deposit_redirect((select public_id from tier_link_results where expected_amount = 250.00)),
  'https://monzo.com/pay/r/synthetic-tier-250',
  'GBP 250 request resolves only to the GBP 250 reusable URL'
);
reset role;

select ok(
  not has_table_privilege('authenticated', 'public.monzo_easy_bank_transfer_tier_urls', 'select')
  and not has_table_privilege('authenticated', 'public.monzo_easy_bank_transfer_tier_urls', 'insert')
  and not has_table_privilege('authenticated', 'public.monzo_easy_bank_transfer_tier_urls', 'update')
  and not has_table_privilege('authenticated', 'public.monzo_easy_bank_transfer_tier_urls', 'delete')
  and not has_table_privilege('service_role', 'public.monzo_easy_bank_transfer_tier_urls', 'select'),
  'tier destination rows have no direct browser or service-role table grants'
);

select ok(
  to_regprocedure('public.configure_monzo_easy_bank_transfer_tier_urls(uuid,text,text,text,text,boolean)') is null
  and to_regprocedure('public.get_monzo_easy_bank_transfer_tier_urls(uuid)') is null,
  'tier routing adds no new public CRM configuration or read RPC'
);

select ok(
  not has_function_privilege('authenticated', 'public.resolve_monzo_deposit_redirect(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.resolve_monzo_deposit_redirect(uuid)', 'execute'),
  'existing redirect resolver remains backend-only'
);

select * from finish();
rollback;
