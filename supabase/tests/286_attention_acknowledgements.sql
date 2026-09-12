-- Durable, versioned acknowledgements for dismissible Today rows.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('ad111111-1111-4111-8111-111111111111', 'attention-manager@example.test'),
  ('ad222222-2222-4222-8222-222222222222', 'attention-reader@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('ad111111-1111-4111-8111-111111111111', 'attention-manager@example.test', 'booking_manager', true),
  ('ad222222-2222-4222-8222-222222222222', 'attention-reader@example.test', 'read_only', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active
) values
  ('ad111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'manager', true, false, true),
  ('ad222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, true);

insert into public.clients (id, workspace_id, full_name, email) values (
  'ad300000-0000-4000-8000-000000000001',
  (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111'),
  'Attention Client', 'attention-client@example.test'
);
insert into public.enquiries (
  id, artist_id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version,
  privacy_acknowledged_at, created_at
) values (
  'ad400000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'ad300000-0000-4000-8000-000000000001',
  'ENQ-2026-9901', 'ad500000-0000-4000-8000-000000000001', repeat('a', 64),
  'complete', 'Attention Client', 'attention-client@example.test', '2026-07-29',
  now(), '2026-09-12 08:00:00+00'
);
insert into public.projects (
  id, artist_id, client_id, enquiry_id, status, title, deposit_amount,
  deposit_status, updated_at
) values (
  'ad600000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'ad300000-0000-4000-8000-000000000001',
  'ad400000-0000-4000-8000-000000000001',
  'active', 'Attention project', 250, 'requested', '2026-09-12 08:30:00+00'
);

create function pg_temp.attention_claims(p uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.attention_claims(uuid) to authenticated;

set local role authenticated;
select pg_temp.attention_claims('ad111111-1111-4111-8111-111111111111');

select lives_ok(
  $$select public.acknowledge_attention_item(
    'a1111111-1111-4111-8111-111111111111', 'new_enquiry',
    'ad400000-0000-4000-8000-000000000001', '2026-09-12 08:00:00+00'
  )$$,
  'a manager can acknowledge a real item in the managed artist scope'
);
select is(
  (select count(*)::int from public.list_attention_acknowledgements(
    'a1111111-1111-4111-8111-111111111111'
  )),
  1,
  'the acknowledgement is visible through the bounded read RPC'
);
select is(
  (select item_kind from public.list_attention_acknowledgements(null) limit 1),
  'new_enquiry',
  'the all-accessible-artists read keeps the acknowledgement kind'
);
select is(
  (select count(*)::int from public.activity_log
   where enquiry_id='ad400000-0000-4000-8000-000000000001'
     and event_type='attention.dismissed'),
  1,
  'acknowledging a row leaves an artist-scoped audit event'
);

select throws_ok(
  $$select public.acknowledge_attention_item(
    'a2222222-2222-4222-8222-222222222222', 'new_enquiry',
    'ad400000-0000-4000-8000-000000000001', '2026-09-12 08:00:00+00'
  )$$,
  '42501', null,
  'a manager cannot acknowledge work for another artist'
);
select throws_ok(
  $$select public.acknowledge_attention_item(
    'a1111111-1111-4111-8111-111111111111', 'email_draft_to_approve',
    'ad400000-0000-4000-8000-000000000001', '2026-09-12 08:00:00+00'
  )$$,
  '22023', null,
  'a non-dismissible kind fails closed'
);

select pg_temp.attention_claims('ad222222-2222-4222-8222-222222222222');
select is(
  (select count(*)::int from public.list_attention_acknowledgements(
    'a1111111-1111-4111-8111-111111111111'
  )),
  1,
  'read-only staff see the shared resolved queue state'
);
select throws_ok(
  $$select public.acknowledge_attention_item(
    'a1111111-1111-4111-8111-111111111111', 'deposit_outstanding',
    'ad600000-0000-4000-8000-000000000001', '2026-09-12 08:30:00+00'
  )$$,
  '42501', null,
  'read-only staff cannot dismiss work'
);

reset role;
select ok(
  not has_table_privilege('anon', 'public.attention_acknowledgements', 'select')
  and not has_table_privilege('authenticated', 'public.attention_acknowledgements', 'select')
  and not has_table_privilege('service_role', 'public.attention_acknowledgements', 'select'),
  'the backing table is not exposed through the Data API'
);
select ok(
  has_function_privilege('authenticated', 'public.list_attention_acknowledgements(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.acknowledge_attention_item(uuid,text,uuid,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.list_attention_acknowledgements(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.acknowledge_attention_item(uuid,text,uuid,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'public.acknowledge_attention_item(uuid,text,uuid,timestamptz)', 'execute'),
  'only authenticated CRM sessions can reach the bounded RPCs'
);

select * from finish();
rollback;
