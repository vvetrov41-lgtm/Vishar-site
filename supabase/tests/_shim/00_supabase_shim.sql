-- Local test shim: the parts of a hosted Supabase database that the CRM
-- migrations depend on.
--
-- THIS FILE IS A TEST HARNESS. It is never applied to a hosted database, and
-- `supabase test db` never loads it — the real platform already provides all of
-- this. It exists so the pgTAP suite can run on a plain PostgreSQL 16 cluster
-- when Docker and the Supabase CLI are unavailable.
--
-- Differences from real Supabase are recorded in supabase/tests/_shim/README.md.
--
-- Deliberate strictness: the migration owner created by the runner is
-- NOSUPERUSER NOBYPASSRLS, so FORCE ROW LEVEL SECURITY genuinely applies to
-- SECURITY DEFINER functions here. That is stricter than hosted Supabase, where
-- `postgres` bypasses RLS, so a pass in this harness is a pass there too.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Hosted Supabase gives service_role BYPASSRLS. The harness deliberately
    -- does not, so tests prove the policies themselves are correct.
    create role service_role nologin noinherit;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;

-- Hosted Supabase exposes newly created `public` objects to its API roles by
-- default. Model that here so migration 0001's closed-by-default privilege
-- reset is exercised rather than silently relying on plain PostgreSQL defaults.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pgtap;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              extensions.citext unique,
  encrypted_password text,
  created_at         timestamptz not null default now()
);

-- Mirrors the hosted helper: reads the JWT subject from the request GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'sub',
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'role', ''),
    'anon'
  );
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage
--
-- Only the columns the CRM policies reference. The real storage schema has
-- many more; none of them are used by migration 0008.
-- ---------------------------------------------------------------------------

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text not null,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

grant select on storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Role switching for the test suite
--
-- The tests impersonate `anon`, `authenticated` and `service_role` with
-- SET LOCAL ROLE, which requires the migration owner to be a member of each.
-- Hosted Supabase arranges the same thing through the `authenticator` role.
-- ---------------------------------------------------------------------------

do $$ begin
  execute format('grant anon, authenticated, service_role to %I', current_user);
end $$;
