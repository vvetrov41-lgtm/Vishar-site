-- migration-harness-bootstrap.sql
--
-- TEST HARNESS ONLY. This file is never applied to a Supabase project.
--
-- `scripts/test-communications-migration.sh` replays the CRM migration history
-- in stages against a throwaway database so that a data migration can be
-- proved against rows that already existed. A throwaway database in the local
-- cluster has the Supabase roles (roles are cluster-wide) but not the
-- Supabase-managed `auth` and `storage` schemas, which migrations 0002 and
-- 0008 reference.
--
-- These are the narrowest stubs that let those two migrations run. They are
-- deliberately not faithful reimplementations: nothing here is a security
-- control, and no test may rely on them for authorisation behaviour. The real
-- authorisation surface is exercised by the pgTAP suite against a real
-- Supabase stack.

-- `gen_random_uuid()` is core from PostgreSQL 13; pgcrypto is installed by
-- migration 0001 into the `extensions` schema and must not be pre-empted here.
create schema if not exists auth;
create schema if not exists storage;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;

-- Supabase resolves these from the verified JWT. The harness resolves them
-- from a session GUC so a test can act as a role without an auth server.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create or replace function auth.role() returns text
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

create or replace function auth.jwt() returns jsonb
  language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;
