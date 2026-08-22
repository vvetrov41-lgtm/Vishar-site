-- 184_gpt_appointment_actions.sql
--
-- Supabase OAuth client binding, fixed artist scope, ACL closure, idempotent
-- appointment writes and AI audit attribution.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema and fail-closed defaults
-- ---------------------------------------------------------------------------

select has_table('crm_private', 'gpt_action_clients',
  'private GPT OAuth-client bindings exist');
select has_table('crm_private', 'gpt_action_receipts',
  'private GPT idempotency receipts exist');
-- Migration 0084 added a second binding mode, so this counts what it always
-- meant: the Artist-bound production clients. The row count is still fully
-- pinned, because the assertion below names every client that is not one.
select is(
  (select count(*)::int from crm_private.gpt_action_clients
   where binding_mode = 'artist'),
  2,
  'exactly the Vladimir and Kristina logical GPT clients are seeded'
);
select is(
  (select array_agg(integration_key order by integration_key)
   from crm_private.gpt_action_clients
   where binding_mode <> 'artist'),
  array['vishar-unified-gpt'],
  'the only non-Artist-bound client is the dormant unified GPT'
);
select ok(
  (select bool_and(not is_active and oauth_client_id is null)
   from crm_private.gpt_action_clients),
  'both GPT clients are disabled and unconfigured by default'
);
select is(
  (select artist_id from crm_private.gpt_action_clients
   where integration_key = 'kristina-gpt-actions'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'Kristina GPT has a stable fixed Kristina artist binding'
);
select ok(
  not has_table_privilege('authenticated', 'crm_private.gpt_action_clients', 'SELECT'),
  'authenticated users cannot read private OAuth-client mappings directly'
);
select ok(
  not has_table_privilege('service_role', 'crm_private.gpt_action_clients', 'SELECT'),
  'service_role has no direct GPT client mapping privilege'
);
select ok(
  not has_table_privilege('authenticated', 'crm_private.gpt_action_receipts', 'SELECT'),
  'authenticated users cannot read GPT idempotency receipts directly'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.gpt_search_clients(text,integer)',
    'EXECUTE'
  ),
  'authenticated OAuth callers may use the narrow client-name lookup'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.gpt_list_appointments(timestamptz,timestamptz,integer)',
    'EXECUTE'
  ),
  'authenticated OAuth callers may list fixed-scope appointments'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)',
    'EXECUTE'
  ),
  'authenticated OAuth callers may call the protected schedule RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)',
    'EXECUTE'
  ),
  'anonymous callers cannot call GPT appointment writes'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'crm_private.require_gpt_action_context(boolean)',
    'EXECUTE'
  ),
  'the private OAuth context resolver is not a browser RPC'
);

-- ---------------------------------------------------------------------------
-- Synthetic staff, memberships, clients and appointments
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('d1011111-1111-4111-8111-111111111111', 'gpt-owner@example.test'),
  ('d1022222-2222-4222-8222-222222222222', 'gpt-kristina-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('d1011111-1111-4111-8111-111111111111',
   'gpt-owner@example.test', 'GPT Owner', 'owner', true),
  ('d1022222-2222-4222-8222-222222222222',
   'gpt-kristina-manager@example.test', 'GPT Kristina Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'd1022222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true, false, true
);

create function pg_temp.gpt_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_claims(text)
  to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('d2011111-1111-4111-8111-111111111111',
   'Vladimir GPT Client', 'vladimir-gpt-client@example.test'),
  ('d2022222-2222-4222-8222-222222222222',
   'Kristina GPT Client', 'kristina-gpt-client@example.test');

insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, notes
) values
  (
    'd3011111-1111-4111-8111-111111111111',
    null,
    'd2011111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'in_person_consultation',
    'proposed',
    '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z',
    0.50, 'Synthetic Vladimir GPT fixture'
  ),
  (
    'd3022222-2222-4222-8222-222222222222',
    null,
    'd2022222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'in_person_consultation',
    'proposed',
    '2026-10-02T10:00:00Z', '2026-10-02T10:30:00Z',
    0.50, 'Synthetic Kristina GPT fixture'
  );

-- ---------------------------------------------------------------------------
-- Owner-only client activation, with no secret stored in SQL
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.gpt_claims(
  '{"sub":"d1011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'vladimir-gpt-actions', 'oauth-vladimir-test-client', true, true
    )$$,
  'owner can bind and enable the Vladimir OAuth client id'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'kristina-gpt-actions', 'oauth-kristina-test-client', true, true
    )$$,
  'owner can bind and enable the Kristina OAuth client id'
);
reset role;

select is(
  (select count(*)::int from crm_private.gpt_action_clients where is_active),
  2,
  'both synthetic OAuth client bindings are active after owner configuration'
);
select is(
  (select count(*)::int from public.activity_log
   where event_type = 'gpt.client_configured'
     and artist_id is not null),
  2,
  'GPT client configuration audit retains its artist scope'
);

-- ---------------------------------------------------------------------------
-- OAuth claim and artist isolation
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.gpt_claims(
  '{"sub":"d1022222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select throws_ok(
  $$select * from public.gpt_list_appointments(
      '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
    )$$,
  '42501', null,
  'a normal CRM token without OAuth client_id cannot use GPT RPCs'
);

select pg_temp.gpt_claims(
  '{"sub":"d1022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-kristina-test-client"}'
);
select is(
  (select count(*)::int from public.gpt_list_appointments(
    '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
  )),
  1,
  'Kristina GPT lists only Kristina appointments'
);
select is(
  (select appointment_id from public.gpt_list_appointments(
    '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
  )),
  'd3022222-2222-4222-8222-222222222222'::uuid,
  'Kristina GPT cannot receive the Vladimir appointment'
);
select is(
  (select count(*)::int from public.gpt_get_appointment(
    'd3011111-1111-4111-8111-111111111111'
  )),
  0,
  'a Vladimir appointment is absent from Kristina GPT detail lookup'
);
select is(
  (select count(*)::int from public.gpt_search_clients('GPT Client', 20)),
  1,
  'Kristina GPT client-name search is fixed to Kristina client relationships'
);
select is(
  (select client_id from public.gpt_search_clients('GPT Client', 20)),
  'd2022222-2222-4222-8222-222222222222'::uuid,
  'Kristina GPT client search returns only the Kristina client id'
);
select throws_ok(
  $$select public.gpt_schedule_appointment(
      'd4011111-1111-4111-8111-111111111111',
      'd2011111-1111-4111-8111-111111111111',
      'in_person_consultation',
      '2026-10-03T09:00:00Z', '2026-10-03T09:30:00Z',
      'proposed', null, null, 'Cross-artist attempt'
    )$$,
  '42501', null,
  'Kristina GPT cannot schedule against a Vladimir-only client'
);

create temporary table gpt_schedule_result as
select public.gpt_schedule_appointment(
  'd4022222-2222-4222-8222-222222222222',
  'd2022222-2222-4222-8222-222222222222',
  'in_person_consultation',
  '2026-10-03T10:00:00Z', '2026-10-03T10:30:00Z',
  'proposed', null, null, 'Synthetic Kristina GPT appointment'
) as result;
grant select on gpt_schedule_result to authenticated, service_role;

select is(
  (select result ->> 'idempotent_replay' from gpt_schedule_result),
  'false',
  'the first GPT schedule call is not reported as a replay'
);
select is(
  (select artist_id from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid from gpt_schedule_result)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the created appointment inherits Kristina from OAuth client binding'
);
select is(
  (select public.gpt_schedule_appointment(
    'd4022222-2222-4222-8222-222222222222',
    'd2022222-2222-4222-8222-222222222222',
    'in_person_consultation',
    '2026-10-03T10:00:00Z', '2026-10-03T10:30:00Z',
    'proposed', null, null, 'Synthetic Kristina GPT appointment'
  ) ->> 'idempotent_replay'),
  'true',
  'an exact request_id retry returns the stored result as an idempotent replay'
);
select throws_ok(
  $$select public.gpt_schedule_appointment(
      'd4022222-2222-4222-8222-222222222222',
      'd2022222-2222-4222-8222-222222222222',
      'in_person_consultation',
      '2026-10-03T11:00:00Z', '2026-10-03T11:30:00Z',
      'proposed', null, null, 'Different payload'
    )$$,
  '22023', null,
  'one request_id cannot be reused for a different GPT action payload'
);
reset role;

select is(
  (select length(request_hash) from crm_private.gpt_action_receipts
   where request_id = 'd4022222-2222-4222-8222-222222222222'),
  64,
  'GPT idempotency receipts use SHA-256 hashes'
);
select is(
  (select count(*)::int from public.activity_log
   where event_type = 'appointment.ai_scheduled'
     and actor_kind = 'ai'
     and actor_profile_id = 'd1022222-2222-4222-8222-222222222222'
     and artist_id = 'a2222222-2222-4222-8222-222222222222'),
  1,
  'AI schedule audit records both authenticated human and Kristina artist scope'
);

-- Even an owner with access to both artists remains fixed to the Kristina OAuth
-- client scope. Conversely, Kristina cannot use the Vladimir OAuth client.
set local role authenticated;
select pg_temp.gpt_claims(
  '{"sub":"d1011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-test-client"}'
);
select is(
  (select count(*)::int from public.gpt_list_appointments(
    '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
  )),
  2,
  'owner using Kristina GPT still receives only Kristina appointments'
);
select is(
  (select count(*)::int from public.gpt_get_appointment(
    'd3011111-1111-4111-8111-111111111111'
  )),
  0,
  'owner cannot switch Kristina GPT to Vladimir by broad owner membership'
);

select pg_temp.gpt_claims(
  '{"sub":"d1022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-vladimir-test-client"}'
);
select throws_ok(
  $$select * from public.gpt_list_appointments(
      '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
    )$$,
  '42501', null,
  'Kristina user cannot use the Vladimir GPT OAuth client'
);
reset role;

-- Owner can downgrade one GPT to read-only without changing the human role.
set local role authenticated;
select pg_temp.gpt_claims(
  '{"sub":"d1011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'kristina-gpt-actions', 'oauth-kristina-test-client', true, false
    )$$,
  'owner can downgrade Kristina GPT to read-only'
);

select pg_temp.gpt_claims(
  '{"sub":"d1022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-kristina-test-client"}'
);
select lives_ok(
  $$select * from public.gpt_list_appointments(
      '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', 20
    )$$,
  'read-only Kristina GPT can still list Kristina appointments'
);
select throws_ok(
  $$select public.gpt_schedule_appointment(
      'd4033333-3333-4333-8333-333333333333',
      'd2022222-2222-4222-8222-222222222222',
      'in_person_consultation',
      '2026-10-03T12:00:00Z', '2026-10-03T12:30:00Z',
      'proposed', null, null, 'Read-only attempt'
    )$$,
  '42501', null,
  'read-only Kristina GPT cannot create appointments'
);
reset role;

select * from finish();
rollback;
