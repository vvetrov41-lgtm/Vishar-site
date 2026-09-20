begin;

select plan(20);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'enquiries'
      and column_name = 'excluded_from_analytics'
  ),
  'enquiry analytics exclusion marker exists'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'enquiries'
      and column_name = 'excluded_from_analytics'
      and is_nullable = 'NO'
      and column_default like '%false%'
  ),
  'analytics exclusion defaults false and cannot be null'
);

select ok(to_regclass('public.statistics_enquiries') is not null, 'statistics enquiries view exists');

select ok(
  (
    select bool_and(coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true'])
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'statistics_enquiries',
        'statistics_projects',
        'statistics_sessions',
        'statistics_payment_requests',
        'statistics_payment_transactions'
      ])
  ),
  'all analytics projections are security_invoker views'
);

select ok(
  (
    select bool_and(has_table_privilege('authenticated', 'public.' || name, 'SELECT'))
    from unnest(array[
      'statistics_enquiries',
      'statistics_projects',
      'statistics_sessions',
      'statistics_payment_requests',
      'statistics_payment_transactions'
    ]) as name
  ),
  'authenticated CRM users can read the analytics projections'
);

select ok(
  (
    select bool_and(not has_table_privilege('anon', 'public.' || name, 'SELECT'))
    from unnest(array[
      'statistics_enquiries',
      'statistics_projects',
      'statistics_sessions',
      'statistics_payment_requests',
      'statistics_payment_transactions'
    ]) as name
  ),
  'anonymous users cannot read analytics projections'
);

select ok(
  to_regprocedure('public.set_enquiry_analytics_exclusion(uuid,boolean)') is not null,
  'narrow analytics exclusion RPC exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.set_enquiry_analytics_exclusion(uuid,boolean)',
    'EXECUTE'
  ),
  'authenticated CRM users may call the guarded analytics exclusion RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.set_enquiry_analytics_exclusion(uuid,boolean)',
    'EXECUTE'
  ),
  'anonymous users cannot call the analytics exclusion RPC'
);

select ok(
  (
    select p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public, crm_private']
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_enquiry_analytics_exclusion'
      and pg_get_function_identity_arguments(p.oid) = 'p_enquiry_id uuid, p_excluded boolean'
  ),
  'analytics exclusion RPC is SECURITY DEFINER with a fixed search path'
);

select ok(
  pg_get_functiondef('public.set_enquiry_analytics_exclusion(uuid,boolean)'::regprocedure)
    like '%require_artist_access(v_enquiry.artist_id, ''manage'')%',
  'analytics exclusion RPC rechecks artist management capability'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, workspace_id)
values
  (
    'ca710000-0000-4000-8000-000000000001',
    'Analytics excluded fixture',
    (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111')
  ),
  (
    'ca710000-0000-4000-8000-000000000002',
    'Analytics included fixture',
    (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at, artist_id,
  excluded_from_analytics
) values
  (
    'ea710000-0000-4000-8000-000000000001',
    'ca710000-0000-4000-8000-000000000001',
    'ENQ-2099-9711',
    '97110000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'complete',
    'Analytics excluded fixture',
    'analytics-excluded@example.test',
    '2026-07-29',
    now(),
    'a1111111-1111-4111-8111-111111111111',
    true
  ),
  (
    'ea710000-0000-4000-8000-000000000002',
    'ca710000-0000-4000-8000-000000000002',
    'ENQ-2099-9712',
    '97120000-0000-4000-8000-000000000002',
    repeat('b', 64),
    'complete',
    'Analytics included fixture',
    'analytics-included@example.test',
    '2026-07-29',
    now(),
    'a1111111-1111-4111-8111-111111111111',
    false
  );

insert into public.projects (
  id, client_id, enquiry_id, status, title, artist_id
) values
  (
    'aa710000-0000-4000-8000-000000000001',
    'ca710000-0000-4000-8000-000000000001',
    'ea710000-0000-4000-8000-000000000001',
    'active',
    'Analytics excluded project',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    'aa710000-0000-4000-8000-000000000002',
    'ca710000-0000-4000-8000-000000000002',
    'ea710000-0000-4000-8000-000000000002',
    'active',
    'Analytics included project',
    'a1111111-1111-4111-8111-111111111111'
  );

insert into public.sessions (
  id, project_id, client_id, enquiry_id, status,
  start_at, end_at, artist_id
) values
  (
    'ba710000-0000-4000-8000-000000000001',
    'aa710000-0000-4000-8000-000000000001',
    'ca710000-0000-4000-8000-000000000001',
    'ea710000-0000-4000-8000-000000000001',
    'confirmed',
    '2099-07-11 10:00:00+00',
    '2099-07-11 17:00:00+00',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    'ba710000-0000-4000-8000-000000000002',
    'aa710000-0000-4000-8000-000000000002',
    'ca710000-0000-4000-8000-000000000002',
    'ea710000-0000-4000-8000-000000000002',
    'confirmed',
    '2099-07-12 10:00:00+00',
    '2099-07-12 17:00:00+00',
    'a1111111-1111-4111-8111-111111111111'
  );

select is(
  (select count(*)::integer from public.enquiries where id = 'ea710000-0000-4000-8000-000000000001'),
  1,
  'excluded enquiry remains stored in CRM'
);

select is(
  (select count(*)::integer from public.statistics_enquiries where id = 'ea710000-0000-4000-8000-000000000001'),
  0,
  'excluded enquiry is absent from Statistics'
);

select is(
  (select count(*)::integer from public.statistics_projects where id = 'aa710000-0000-4000-8000-000000000001'),
  0,
  'project linked to an excluded enquiry is absent from Statistics'
);

select is(
  (select count(*)::integer from public.statistics_sessions where id = 'ba710000-0000-4000-8000-000000000001'),
  0,
  'session linked to an excluded enquiry is absent from Statistics'
);

select is(
  (select count(*)::integer from public.statistics_enquiries where id = 'ea710000-0000-4000-8000-000000000002'),
  1,
  'ordinary enquiry remains visible to Statistics'
);

select is(
  (select count(*)::integer from public.statistics_projects where id = 'aa710000-0000-4000-8000-000000000002'),
  1,
  'ordinary linked project remains visible to Statistics'
);

select is(
  (select count(*)::integer from public.statistics_sessions where id = 'ba710000-0000-4000-8000-000000000002'),
  1,
  'ordinary linked session remains visible to Statistics'
);

select ok(
  pg_get_viewdef('public.statistics_payment_requests'::regclass, true)
    like '%statistics_projects%'
  and pg_get_viewdef('public.statistics_payment_requests'::regclass, true)
    like '%statistics_sessions%',
  'payment request projection inherits project and session exclusion'
);

select ok(
  pg_get_viewdef('public.statistics_payment_transactions'::regclass, true)
    like '%statistics_payment_requests%',
  'payment transaction projection inherits payment request exclusion'
);

select * from finish();
rollback;
