-- Local test shim: the parts of a hosted Supabase database that the CRM
-- migrations depend on.
--
-- THIS FILE IS A TEST HARNESS. It is never applied to a hosted database, and
-- `supabase test db` never loads it — the real platform already provides all of
-- this. It exists so the pgTAP suite can run on a plain PostgreSQL 16 cluster
-- when Docker and the Supabase CLI are unavailable.
--
-- Differences from real Supabase are recorded in scripts/test-support/README.md.
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

-- pgTAP lives in its own schema rather than in `public`.
--
-- Migration 0012 revokes EXECUTE on every public function from PUBLIC, and
-- tests/050_rls_roles.sql then asserts that nothing in `public` or
-- `crm_private` outside its allow-list is callable by an API role. With pgTAP
-- in `public`, granting the assertion functions to `authenticated` - which the
-- suites need, because they assert from inside `set local role authenticated`
-- - would add ~1000 callable functions to the surface that test polices.
-- Keeping them in `tap` lets both be true at once.
create schema if not exists tap;
create extension if not exists pgtap with schema tap;
grant usage on schema tap to anon, authenticated, service_role;
grant execute on all functions in schema tap to anon, authenticated, service_role;

-- Test files call no_plan(), is(), throws_ok() unqualified, so `tap` has to be
-- on the search path. Set on the database rather than per session, because the
-- harness opens a fresh psql session for every test file. `extensions` is
-- included for the same reason hosted Supabase includes it.
do $$
begin
  execute format(
    'alter database %I set search_path = public, tap, extensions',
    current_database());
end;
$$;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------

-- The hosted GoTrue column set, not just the four columns the CRM policies
-- read. Several suites insert or update the wider set, and the account
-- lifecycle RPC writes most of it while erasing an account.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  instance_id        uuid,
  aud                text,
  role               text,
  email              extensions.citext unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  invited_at         timestamptz,
  confirmation_token text,
  recovery_token     text,
  email_change       text,
  email_change_token_new     text,
  email_change_token_current text,
  phone              text,
  phone_change       text,
  phone_change_token text,
  reauthentication_token text,
  last_sign_in_at    timestamptz,
  raw_app_meta_data  jsonb,
  raw_user_meta_data jsonb,
  is_super_admin     boolean,
  banned_until       timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz default now()
);

-- Session tables the account-lifecycle RPC deletes from when erasing an
-- account. Structure only; no GoTrue behaviour is simulated.
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid
);
create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  user_id text
);
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  provider text
);
create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid
);
create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid
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

-- The GPT OAuth-client context reads the whole claim set, not just the subject.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

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
grant select on storage.objects to anon;
grant select, insert, update, delete on storage.objects to authenticated, service_role;

-- Supabase owns these managed tables and enables RLS before project migrations
-- run. The plain-PostgreSQL harness must model that platform invariant itself;
-- production migration roles must not ALTER the managed Storage tables.
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

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
