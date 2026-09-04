-- 182_calendar_connection_metadata.sql
--
-- Backend-only Calendar connection metadata write surface. Direct table ACLs
-- remain closed; the RPC fixes provider/configuration and exact artist routing.

begin;
select no_plan();

create function pg_temp.calendar_metadata_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.calendar_metadata_claims(text)
  to anon, authenticated, service_role;

select ok(
  not has_function_privilege(
    'anon',
    'public.set_calendar_connection_metadata(uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'anonymous callers cannot write Calendar connection metadata'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.set_calendar_connection_metadata(uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'CRM browser sessions cannot call the backend metadata RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.set_calendar_connection_metadata(uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'service_role receives only the narrow metadata RPC explicitly'
);
select ok(
  not has_table_privilege('service_role', 'public.artist_integrations', 'INSERT'),
  'service_role still has no direct insert privilege on artist_integrations'
);
select ok(
  not has_table_privilege('service_role', 'public.artist_integrations', 'UPDATE'),
  'service_role still has no direct update privilege on artist_integrations'
);

set local role authenticated;
select pg_temp.calendar_metadata_claims(
  '{"sub":"81111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vvetrov41@gmail.com',
    true
  )$$,
  '42501', null,
  'an authenticated caller is rejected before metadata mutation'
);
reset role;

set local role service_role;
select pg_temp.calendar_metadata_claims('{"role":"service_role"}');
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'Vvetrov41@GMAIL.COM',
    true
  )$$,
  'the backend can connect Vladimir through the exact route'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  1,
  'the connection is represented by exactly one integration row'
);
select is(
  (
    select provider
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  'google',
  'the provider is fixed server-side'
);
select is(
  (
    select external_account_label
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  'vvetrov41@gmail.com',
  'the account label is normalized server-side'
);
select is(
  (
    select configuration
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  '{"calendar_id":"primary","oauth_scope":"calendar.events","connection_mode":"worker_oauth","artist_slug":"vladimir","presentation":{"event_visibility":"public","event_display_name":"Vladimir","event_color_id":null,"event_label_name":null,"event_label_color":null}}'::jsonb,
  'provider configuration is fixed, server-derived and contains no credential material'
);
select is(
  (
    select is_enabled
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  true,
  'the backend can enable the connection'
);

set local role service_role;
select pg_temp.calendar_metadata_claims('{"role":"service_role"}');
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_kristina',
    'vvetrov41@gmail.com',
    true
  )$$,
  '22023', null,
  'a cross-artist integration key is rejected'
);
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'not-an-email',
    true
  )$$,
  '22023', null,
  'an invalid account label is rejected'
);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vvetrov41@gmail.com',
    false
  )$$,
  'the same narrow RPC performs an idempotent disconnect metadata update'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  1,
  'disconnect updates the existing row instead of creating a duplicate'
);
select is(
  (
    select is_enabled
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
      and integration_key = 'google_calendar_vladimir'
  ),
  false,
  'disconnect disables the existing connection metadata'
);

select * from finish();
rollback;
