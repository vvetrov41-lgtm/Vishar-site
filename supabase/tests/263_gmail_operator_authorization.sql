-- 263_gmail_operator_authorization.sql
--
-- The Gmail Worker may read live provider history for a CRM operator only
-- after mapping the operator's Supabase session to an active profile and exact
-- artist membership. Provider credentials and raw Gmail thread ids remain
-- backend-only.

begin;
select no_plan();

select has_function(
  'public',
  'service_authorize_gmail_operator',
  array['uuid', 'uuid'],
  'Gmail operator authorization RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.service_authorize_gmail_operator(uuid,uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot query Gmail operator authorization'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.service_authorize_gmail_operator(uuid,uuid)',
    'EXECUTE'
  ),
  'browser sessions cannot call the backend Gmail operator authorization RPC directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.service_authorize_gmail_operator(uuid,uuid)',
    'EXECUTE'
  ),
  'service_role receives only the narrow Gmail operator authorization RPC'
);

insert into auth.users (id, email) values
  ('96300000-0000-4000-8000-000000000001', 'gmail-operator-owner@example.test'),
  ('96300000-0000-4000-8000-000000000002', 'gmail-operator-manager@example.test'),
  ('96300000-0000-4000-8000-000000000003', 'gmail-operator-readonly@example.test'),
  ('96300000-0000-4000-8000-000000000004', 'gmail-operator-disabled@example.test'),
  ('96300000-0000-4000-8000-000000000005', 'gmail-operator-membership-disabled@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('96300000-0000-4000-8000-000000000001', 'gmail-operator-owner@example.test', 'Gmail Operator Owner', 'owner', true),
  ('96300000-0000-4000-8000-000000000002', 'gmail-operator-manager@example.test', 'Gmail Operator Manager', 'booking_manager', true),
  ('96300000-0000-4000-8000-000000000003', 'gmail-operator-readonly@example.test', 'Gmail Operator Read Only', 'read_only', true),
  ('96300000-0000-4000-8000-000000000004', 'gmail-operator-disabled@example.test', 'Gmail Operator Disabled', 'booking_manager', false),
  ('96300000-0000-4000-8000-000000000005', 'gmail-operator-membership-disabled@example.test', 'Gmail Operator Membership Disabled', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('96300000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('96300000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('96300000-0000-4000-8000-000000000003', 'a1111111-1111-4111-8111-111111111111', 'read_only', false, false, false, false, true),
  ('96300000-0000-4000-8000-000000000004', 'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('96300000-0000-4000-8000-000000000005', 'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, false);

insert into public.clients (id, full_name, email) values
  ('96310000-0000-4000-8000-000000000001', 'Gmail Vladimir Client', 'gmail-vladimir-client@example.test'),
  ('96310000-0000-4000-8000-000000000002', 'Gmail Kristina Client', 'gmail-kristina-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  (
    '96320000-0000-4000-8000-000000000001',
    '96310000-0000-4000-8000-000000000001',
    'a1111111-1111-4111-8111-111111111111',
    'PENDING', '96330000-0000-4000-8000-000000000001', repeat('3', 64),
    'accepted', 'complete', 'Gmail Vladimir Client',
    'gmail-vladimir-client@example.test', '2026-08-05', now()
  ),
  (
    '96320000-0000-4000-8000-000000000002',
    '96310000-0000-4000-8000-000000000002',
    'a2222222-2222-4222-8222-222222222222',
    'PENDING', '96330000-0000-4000-8000-000000000002', repeat('4', 64),
    'accepted', 'complete', 'Gmail Kristina Client',
    'gmail-kristina-client@example.test', '2026-08-05', now()
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select artist_id from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000001',
    '96320000-0000-4000-8000-000000000001'
  )),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'owner receives only the enquiry artist id for an artist they manage'
);
select is(
  (select enquiry_id from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000001',
    '96320000-0000-4000-8000-000000000001'
  )),
  '96320000-0000-4000-8000-000000000001'::uuid,
  'operator authorization preserves the exact enquiry id'
);
select is(
  (select client_id from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000002',
    '96320000-0000-4000-8000-000000000001'
  )),
  '96310000-0000-4000-8000-000000000001'::uuid,
  'active booking manager receives only the enquiry client id for its artist'
);

select throws_ok(
  $$select * from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000002',
    '96320000-0000-4000-8000-000000000002'
  )$$,
  '42501',
  'profile cannot read Gmail for this artist',
  'booking manager cannot cross into another artist Gmail scope'
);
select throws_ok(
  $$select * from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000003',
    '96320000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  'profile cannot read Gmail for this artist',
  'read-only membership does not gain live Gmail visibility beyond the existing email boundary'
);
select throws_ok(
  $$select * from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000004',
    '96320000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  'profile cannot read Gmail for this artist',
  'inactive CRM profile is rejected even when its artist membership remains active'
);
select throws_ok(
  $$select * from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000005',
    '96320000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  'profile cannot read Gmail for this artist',
  'inactive artist membership immediately removes live Gmail access'
);
select throws_ok(
  $$select * from public.service_authorize_gmail_operator(
    '96300000-0000-4000-8000-000000000001',
    '96320000-0000-4000-8000-000000000099'
  )$$,
  '22023',
  'Gmail CRM target is unavailable',
  'missing enquiry is rejected without leaking any provider state'
);

reset role;
select * from finish();
rollback;
