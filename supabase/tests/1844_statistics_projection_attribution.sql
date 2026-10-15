begin;

select plan(9);

select ok(
  (
    select bool_and(coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true'])
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'statistics_enquiries',
        'statistics_sessions',
        'statistics_payment_requests'
      ])
  ),
  'extended Statistics projections remain security_invoker views'
);

select ok(
  (
    select bool_and(not has_table_privilege('anon', 'public.' || name, 'SELECT'))
    from unnest(array['statistics_enquiries', 'statistics_sessions', 'statistics_payment_requests']) as name
  ),
  'anonymous users still cannot read the extended projections'
);

select is(
  (
    select array_agg(column_name::text order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'statistics_enquiries'
  ),
  array[
    'id', 'artist_id', 'client_id', 'status', 'intake_state', 'source',
    'booking_source_id', 'communication_channel', 'utm_source', 'discovery_source',
    'created_at', 'archived_at', 'utm_medium', 'utm_campaign', 'referrer_host'
  ],
  'statistics_enquiries keeps its existing columns in order and appends attribution columns'
);

select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'statistics_enquiries'
      and column_name in ('referrer', 'landing_page', 'submitted_email', 'submitted_phone', 'submitted_full_name')
  ),
  'statistics_enquiries exposes no full referrer URL and no contact column'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'statistics_sessions' and column_name = 'created_at'
  ),
  'statistics_sessions carries when the booking was made'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'statistics_payment_requests' and column_name = 'expires_at'
  ),
  'statistics_payment_requests carries the request expiry'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, workspace_id)
values (
  'ca718440-0000-4000-8000-000000000001',
  'Referrer host fixture',
  (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111')
);

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at, artist_id,
  utm_source, utm_medium, utm_campaign, referrer, excluded_from_analytics
) values
  (
    'ea718440-0000-4000-8000-000000000001',
    'ca718440-0000-4000-8000-000000000001',
    'ENQ-2099-9844',
    '98440000-0000-4000-8000-000000000001',
    repeat('c', 64),
    'complete',
    'Referrer host fixture',
    'referrer-host@example.test',
    '2026-07-29',
    now(),
    'a1111111-1111-4111-8111-111111111111',
    'fb', 'paid', '120000000000000001',
    'https://L.Facebook.com/l.php?u=https%3A%2F%2Fexample.test&fbclid=secret',
    false
  ),
  (
    'ea718440-0000-4000-8000-000000000002',
    'ca718440-0000-4000-8000-000000000001',
    'ENQ-2099-9845',
    '98450000-0000-4000-8000-000000000002',
    repeat('d', 64),
    'complete',
    'Referrer host fixture',
    'referrer-host@example.test',
    '2026-07-29',
    now(),
    'a1111111-1111-4111-8111-111111111111',
    null, null, null,
    'not a url',
    true
  );

select is(
  (select referrer_host from public.statistics_enquiries where id = 'ea718440-0000-4000-8000-000000000001'),
  'l.facebook.com',
  'referrer is reduced to a lower-case host, without path or click identifiers'
);

select is(
  (select utm_medium || '/' || utm_campaign from public.statistics_enquiries where id = 'ea718440-0000-4000-8000-000000000001'),
  'paid/120000000000000001',
  'campaign tags reach Statistics'
);

select is(
  (select count(*)::int from public.statistics_enquiries where id = 'ea718440-0000-4000-8000-000000000002'),
  0,
  'analytics exclusion still removes an excluded enquiry from the projection'
);

select * from finish();
rollback;
