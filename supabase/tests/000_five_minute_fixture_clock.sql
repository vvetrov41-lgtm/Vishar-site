-- 000_five_minute_fixture_clock.sql
--
-- Test-harness compatibility for migration 0031.
--
-- Older pgTAP fixtures intentionally use `now()` as an arbitrary synthetic
-- session start. Once new appointment boundaries must be on a five-minute
-- grid, those fixtures can fail before reaching the unrelated constraint they
-- are meant to exercise simply because the test process started at e.g.
-- 08:02:37.
--
-- Keep production enforcement strict. This file exists only under
-- `supabase/tests`, so it is never a migration and is never applied to hosted
-- staging or production. It shadows unqualified `now()` in later test scripts
-- with the current transaction timestamp rounded down to the nearest five
-- minutes. Production functions that set `search_path = pg_catalog, ...` keep
-- resolving the real pg_catalog.now().
--
-- The database-level search_path is needed because pg_prove executes each SQL
-- test file in a fresh connection. The explicit current-session SET makes this
-- bootstrap file itself deterministic too.

create or replace function public.now()
returns timestamptz
language sql
stable
as $$
  select pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from pg_catalog.now()) / 300) * 300
  );
$$;

do $$
begin
  execute format(
    'alter database %I set search_path = public, pg_catalog',
    current_database()
  );
end;
$$;

set search_path = public, pg_catalog;

select plan(3);

select is(
  mod(extract(epoch from now())::numeric, 300),
  0::numeric,
  'test-only now() is aligned to the five-minute grid'
);

select ok(
  pg_catalog.now() >= now()
    and pg_catalog.now() - now() < interval '5 minutes',
  'test-only alignment changes the clock by less than five minutes'
);

select isnt(
  to_regprocedure('public.now()'),
  null::regprocedure,
  'test-only public.now() shim is installed for later pgTAP files'
);

select * from finish();
