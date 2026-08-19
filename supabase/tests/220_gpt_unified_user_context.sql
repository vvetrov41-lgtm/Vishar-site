-- 220_gpt_unified_user_context.sql
--
-- Synthetic-only proof for the unified, user-centric production GPT identity.
-- The shared OAuth client identifies the GPT application. Artist authority is
-- derived from the authenticated CRM profile, an active membership, the
-- server-side active context and the per-artist capability policy.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.unified_gpt_claims(p_claims text)
returns void language sql as $$
  select set_config('request.jwt.claims', p_claims, true)::void;
$$;
grant execute on function pg_temp.unified_gpt_claims(text)
  to anon, authenticated, service_role;

insert into auth.users (id, email) values
  ('69000000-0000-4000-8000-000000000001', 'unified-owner@example.test'),
  ('69000000-0000-4000-8000-000000000002', 'unified-two@example.test'),
  ('69000000-0000-4000-8000-000000000003', 'unified-one@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('69000000-0000-4000-8000-000000000001', 'unified-owner@example.test', 'Unified Owner', 'owner', true),
  ('69000000-0000-4000-8000-000000000002', 'unified-two@example.test', 'Unified Two Artist User', 'booking_manager', true),
  ('69000000-0000-4000-8000-000000000003', 'unified-one@example.test', 'Unified One Artist User', 'booking_manager', true);

insert into public.artists (
  id, slug, display_name, timezone, default_currency, booking_reference_prefix, is_active
) values (
  'a3333333-3333-4333-8333-333333333333', 'unavailable-artist',
  'Unavailable Artist', 'Europe/London', 'GBP', 'UA', true
);

insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance,
  can_manage_finance, can_manage_sessions, can_manage_integrations, is_active
) values
  ('69000000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'manager', true, true, true, true, true),
  ('69000000-0000-4000-8000-000000000002', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, true, true),
  ('69000000-0000-4000-8000-000000000003', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, true, true);

insert into public.clients (id, full_name, email) values
  ('69100000-0000-4000-8000-000000000001', 'Unified Vladimir Client', 'unified-v@example.test'),
  ('69100000-0000-4000-8000-000000000002', 'Unified Kristina Client', 'unified-k@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('69200000-0000-4000-8000-000000000001',
   '69100000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', '69300000-0000-4000-8000-000000000001', repeat('1', 64),
   'accepted', 'complete', 'Unified Vladimir Client', 'unified-v@example.test',
   '2026-08-19', now()),
  ('69200000-0000-4000-8000-000000000002',
   '69100000-0000-4000-8000-000000000002',
   'a2222222-2222-4222-8222-222222222222',
   'PENDING', '69300000-0000-4000-8000-000000000002', repeat('2', 64),
   'accepted', 'complete', 'Unified Kristina Client', 'unified-k@example.test',
   '2026-08-19', now());

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values
  ('69400000-0000-4000-8000-000000000001',
   '69100000-0000-4000-8000-000000000001',
   '69200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111', 'Unified Vladimir Project', 'active', 'GBP'),
  ('69400000-0000-4000-8000-000000000002',
   '69100000-0000-4000-8000-000000000002',
   '69200000-0000-4000-8000-000000000002',
   'a2222222-2222-4222-8222-222222222222', 'Unified Kristina Project', 'active', 'GBP');

insert into public.sessions (
  id, project_id, artist_id, client_id, enquiry_id, appointment_type,
  status, start_at, end_at
) values
  ('69500000-0000-4000-8000-000000000001',
   '69400000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   '69100000-0000-4000-8000-000000000001',
   '69200000-0000-4000-8000-000000000001', 'tattoo_session', 'proposed',
   date_trunc('day', now()) + interval '40 days 10 hours',
   date_trunc('day', now()) + interval '40 days 12 hours'),
  ('69500000-0000-4000-8000-000000000002',
   '69400000-0000-4000-8000-000000000002',
   'a2222222-2222-4222-8222-222222222222',
   '69100000-0000-4000-8000-000000000002',
   '69200000-0000-4000-8000-000000000002', 'tattoo_session', 'proposed',
   date_trunc('day', now()) + interval '41 days 10 hours',
   date_trunc('day', now()) + interval '41 days 12 hours');

set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000001","role":"authenticated"}'
);

select lives_ok(
  $$select public.configure_gpt_oauth_application(
      'vishar-unified-gpt', 'oauth-unified-0069', true
    )$$,
  'owner activates one shared GPT OAuth application'
);

select lives_ok(
  $$select public.configure_gpt_artist_policy(
      'a1111111-1111-4111-8111-111111111111',
      true, true, true, true, true, true, true
    )$$,
  'owner enables the Vladimir policy for every GPT domain'
);
select lives_ok(
  $$select public.configure_gpt_artist_policy(
      'a2222222-2222-4222-8222-222222222222',
      true, true, true, true, true, true, true
    )$$,
  'owner enables the Kristina policy for every GPT domain'
);
select lives_ok(
  $$select public.configure_gpt_artist_policy(
      'a3333333-3333-4333-8333-333333333333',
      true, true, true, true, true, true, true
    )$$,
  'owner may configure a third artist without creating another GPT application'
);

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-unified-vladimir-220', true
    )$$,
  'synthetic Vladimir Monzo route is configured'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-unified-kristina-220', true
    )$$,
  'synthetic Kristina Monzo route is configured'
);

reset role;
select pg_temp.unified_gpt_claims('{"role":"service_role"}');
set local role service_role;

create temporary table unified_vladimir_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_unified_220_v', 'tx_unified_220_v', 50.00, 'GBP', now()
) as result;
grant select on unified_vladimir_candidate to authenticated;

create temporary table unified_kristina_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a2222222222242228222222222222222',
  'evt_unified_220_k', 'tx_unified_220_k', 75.00, 'GBP', now()
) as result;
grant select on unified_kristina_candidate to authenticated;

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000002","role":"authenticated","client_id":"oauth-unified-0069"}'
);

select is(
  (select count(*)::integer from public.gpt_list_accessible_artists()),
  2,
  'a user with two memberships lists exactly those two artists'
);
select ok(
  (select bool_and(
      to_jsonb(a) ?& array['artist_key','display_name','is_active']
      and not (to_jsonb(a) ?| array[
        'artist_id','profile_id','oauth_client_id','integration_key',
        'provider','configuration','capabilities'
      ])
    ) from public.gpt_list_accessible_artists() a),
  'accessible-artist output contains no internal ids, providers or capabilities'
);
select is(
  public.gpt_get_artist_context() ->> 'selection_required',
  'true',
  'a multi-artist user must select context only when none is active'
);
select throws_ok(
  $$select * from public.gpt_list_enquiries(null, null, null, 20)$$,
  '42501', 'active artist context is required',
  'business actions fail closed before a multi-artist context is selected'
);
select throws_ok(
  $$select public.gpt_set_active_artist('unavailable-artist')$$,
  '42501', 'artist context is not available to this user',
  'a user cannot select an artist without membership'
);
select throws_ok(
  $$select public.gpt_set_active_artist('a3333333-3333-4333-8333-333333333333')$$,
  '22023', 'a valid artist key is required',
  'the GPT context surface does not accept an artist UUID as authority'
);

select is(
  public.gpt_set_active_artist('vladimir') #>> '{active_artist,key}',
  'vladimir',
  'the user selects Vladimir by safe artist key after membership validation'
);
select is(
  (select count(*)::integer
   from public.gpt_list_enquiries(null, null, null, 20)
   where enquiry_id = '69200000-0000-4000-8000-000000000001'),
  1,
  'Core enquiry action resolves the active Vladimir context'
);
select is(
  (select count(*)::integer
   from public.gpt_list_enquiries(null, null, null, 20)
   where enquiry_id = '69200000-0000-4000-8000-000000000002'),
  0,
  'Core enquiry action cannot read Kristina while Vladimir is active'
);
select is(
  (select count(*)::integer
   from public.gpt_list_appointments(now(), now() + interval '90 days', 20)
   where appointment_id = '69500000-0000-4000-8000-000000000001'),
  1,
  'Operations appointment action resolves the active Vladimir context'
);
select is(
  public.gpt_authorize_gmail_enquiry('69200000-0000-4000-8000-000000000001')
    ->> 'enquiry_id',
  '69200000-0000-4000-8000-000000000001',
  'Communications action authorizes only the active Vladimir enquiry'
);
select throws_ok(
  $$select public.gpt_authorize_gmail_enquiry(
      '69200000-0000-4000-8000-000000000002'
    )$$,
  '42501', 'enquiry is outside this GPT artist scope',
  'Gmail cannot cross from Vladimir to Kristina'
);
select lives_ok(
  $$select public.gpt_list_monzo_reconciliation_candidates()$$,
  'finance action is available only after membership and finance checks'
);
select throws_ok(
  $$select public.gpt_ignore_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from unified_kristina_candidate)
    )$$,
  '42501', 'reconciliation candidate is outside this GPT artist scope',
  'Monzo reconciliation cannot cross from Vladimir to Kristina'
);

select is(
  public.gpt_set_active_artist('kristina') #>> '{active_artist,key}',
  'kristina',
  'the same authenticated user and OAuth application switch to Kristina'
);
select is(
  (select count(*)::integer
   from public.gpt_list_enquiries(null, null, null, 20)
   where enquiry_id = '69200000-0000-4000-8000-000000000002'),
  1,
  'the shared OAuth token is not intrinsically bound to one artist'
);
select throws_ok(
  $$select public.gpt_authorize_gmail_enquiry(
      '69200000-0000-4000-8000-000000000001'
    )$$,
  '42501', 'enquiry is outside this GPT artist scope',
  'switching artist cannot reuse the previous Gmail CRM target'
);
select throws_ok(
  $$select public.gpt_ignore_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from unified_vladimir_candidate)
    )$$,
  '42501', 'reconciliation candidate is outside this GPT artist scope',
  'switching artist cannot reuse the previous Monzo candidate state'
);

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000001","role":"authenticated"}'
);
select lives_ok(
  $$select public.configure_gpt_artist_policy(
      'a2222222-2222-4222-8222-222222222222',
      true, true, true, true, true, false, true
    )$$,
  'owner can narrow the Kristina finance policy independently'
);

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000002","role":"authenticated","client_id":"oauth-unified-0069"}'
);
select throws_ok(
  $$select public.gpt_list_monzo_reconciliation_candidates()$$,
  '42501', 'this GPT artist policy cannot manage finance',
  'finance requires its explicit artist policy after artist selection'
);
select lives_ok(
  $$select * from public.gpt_list_enquiries(null, null, null, 20)$$,
  'narrowing finance does not create a parallel CRM capability system'
);

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000003","role":"authenticated","client_id":"oauth-unified-0069"}'
);
select is(
  public.gpt_get_artist_context() #>> '{active_artist,key}',
  'kristina',
  'a user with one membership automatically operates in that artist context'
);
select is(
  (select count(*)::integer
   from public.gpt_list_enquiries(null, null, null, 20)
   where enquiry_id = '69200000-0000-4000-8000-000000000002'),
  1,
  'single-membership auto-selection scopes a Core action to Kristina'
);

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000001","role":"authenticated"}'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'vladimir-gpt-actions', 'oauth-legacy-0069', true, true
    )$$,
  'the old artist-bound OAuth client can remain enabled during transition'
);

reset role;
set local role authenticated;
select pg_temp.unified_gpt_claims(
  '{"sub":"69000000-0000-4000-8000-000000000002","role":"authenticated","client_id":"oauth-legacy-0069"}'
);
select is(
  (select count(*)::integer from public.gpt_list_accessible_artists()),
  1,
  'legacy OAuth compatibility remains fixed to its historical artist'
);
select throws_ok(
  $$select public.gpt_set_active_artist('kristina')$$,
  '42501', 'artist context is not available to this user',
  'a legacy token cannot escape its fixed artist through the new switch RPC'
);

reset role;
set local role anon;
select pg_temp.unified_gpt_claims('{"role":"anon"}');
select throws_ok(
  $$select public.gpt_get_artist_context()$$,
  '42501', null,
  'anon cannot call the GPT context surface'
);

reset role;
set local role service_role;
select pg_temp.unified_gpt_claims('{"role":"service_role"}');
select throws_ok(
  $$select public.gpt_get_artist_context()$$,
  '42501', null,
  'service backend tokens cannot impersonate a GPT OAuth user'
);

reset role;
select ok(
  not has_table_privilege('authenticated', 'crm_private.gpt_oauth_applications', 'select')
  and not has_table_privilege('authenticated', 'crm_private.gpt_user_artist_contexts', 'select')
  and not has_table_privilege('service_role', 'crm_private.gpt_user_artist_contexts', 'select'),
  'application identity and active context storage remain server-owned'
);

select * from finish();
rollback;
