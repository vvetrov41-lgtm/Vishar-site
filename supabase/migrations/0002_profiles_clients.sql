-- 0002_profiles_clients.sql
--
-- Staff profiles and client records, plus the deterministic normalisation
-- functions used for client matching.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Deterministic normalisation
--
-- Both functions are IMMUTABLE because the normalised columns on `clients`
-- are GENERATED ALWAYS ... STORED. That is deliberate: a stored generated
-- column cannot be written directly by anyone, including `service_role`, so a
-- wrong normalised value cannot be injected by a backend bug.
--
-- Changing either function later requires a new migration that drops and
-- re-adds the dependent generated column.
-- ---------------------------------------------------------------------------

-- Email normalisation: trim and lowercase ONLY.
--
-- Deliberately NOT done: stripping dots, removing "+alias" suffixes, or any
-- provider-specific rewriting. Those rewrites are wrong for many providers and
-- would silently merge two different people into one client record.
create or replace function public.normalize_email(value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select case
    when value is null then null
    when btrim(value) = '' then null
    else lower(btrim(value))
  end;
$$;

comment on function public.normalize_email(text) is
  'Trim and lowercase only. Never rewrites plus aliases or provider-specific dots.';

-- Phone normalisation: conservative, deterministic, and never guesses a
-- country code.
--
-- Returns an E.164-shaped string only when the input already carries an
-- international prefix ("+44..." or "0044..."). A national-format number such
-- as "07700 900123" returns NULL, because turning it into a match key would
-- require guessing a country. NULL means "not safe to match on"; the raw value
-- is still stored in `clients.phone` and remains searchable in the CRM.
create or replace function public.normalize_phone(value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
declare
  trimmed text;
  digits  text;
begin
  if value is null then
    return null;
  end if;

  trimmed := btrim(value);
  if trimmed = '' then
    return null;
  end if;

  -- Reject anything that is not plausible phone input rather than silently
  -- stripping letters out of a mistyped value and matching on the remainder.
  if trimmed !~ '^\+?[-0-9 ()./]+$' then
    return null;
  end if;

  -- "(0)" is the standard notation for the national trunk prefix that is
  -- omitted when dialling internationally, so removing it is reading the
  -- notation, not guessing a country. Any OTHER parenthesised group is an
  -- ambiguous local grouping and makes the value unsafe to match on.
  trimmed := replace(trimmed, '(0)', '');
  if trimmed like '%(%' or trimmed like '%)%' then
    return null;
  end if;

  digits := regexp_replace(trimmed, '[^0-9]', '', 'g');
  if digits = '' then
    return null;
  end if;

  if left(trimmed, 1) = '+' then
    null;                                    -- already international
  elsif left(digits, 2) = '00' then
    digits := substr(digits, 3);             -- 00 international prefix
  else
    return null;                             -- no country code: do not guess
  end if;

  -- A country code never starts with 0, so a leading zero at this point means
  -- a trunk prefix survived and the value is not a real E.164 number.
  if left(digits, 1) = '0' then
    return null;
  end if;

  -- E.164 allows at most 15 digits. Anything shorter than 7 is not a routable
  -- international number and is not safe to match on.
  if length(digits) < 7 or length(digits) > 15 then
    return null;
  end if;

  return '+' || digits;
end;
$$;

comment on function public.normalize_phone(text) is
  'Conservative E.164-style normalisation. Returns NULL when no country code was supplied; never guesses one.';

-- ---------------------------------------------------------------------------
-- profiles
--
-- One row per CRM staff member, keyed to the Supabase Auth user. Access
-- control reads role and is_active from here, never from a JWT claim the
-- client could influence.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        extensions.citext not null,
  display_name text,
  role         public.crm_role not null default 'read_only',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_email_not_blank check (btrim(email::text) <> ''),
  constraint profiles_email_shape check (email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint profiles_display_name_length check (display_name is null or char_length(display_name) <= 120)
);

create unique index if not exists profiles_email_key on public.profiles (email);
create index if not exists profiles_active_role_idx on public.profiles (role) where is_active;

comment on table public.profiles is
  'CRM staff. A Supabase Auth user with no active profile row has no CRM access at all.';

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

create table if not exists public.clients (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  email             text,
  email_normalized  text generated always as (public.normalize_email(email)) stored,
  phone             text,
  phone_normalized  text generated always as (public.normalize_phone(phone)) stored,
  instagram         text,
  preferred_contact text,
  travelling_from   text,
  notes_summary     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  constraint clients_full_name_not_blank check (btrim(full_name) <> ''),
  constraint clients_full_name_length check (char_length(full_name) <= 160),
  constraint clients_email_length check (email is null or char_length(email) <= 320),
  constraint clients_phone_length check (phone is null or char_length(phone) <= 80),
  constraint clients_instagram_length check (instagram is null or char_length(instagram) <= 80),
  constraint clients_travelling_from_length check (travelling_from is null or char_length(travelling_from) <= 160),
  constraint clients_notes_summary_length check (notes_summary is null or char_length(notes_summary) <= 4000),
  constraint clients_preferred_contact_allowed
    check (preferred_contact is null or preferred_contact in ('Email', 'WhatsApp', 'Instagram'))
);

-- Lookup indexes, deliberately NOT unique.
--
-- A partial unique index on the normalised values would reject a second
-- enquiry from a shared household address, and would make intake fail rather
-- than surface a reviewable conflict. Duplicate resolution is an owner policy
-- decision that has not been made; until it is, matching is handled explicitly
-- and conservatively inside the intake RPC.
create index if not exists clients_email_normalized_idx
  on public.clients (email_normalized) where email_normalized is not null;
create index if not exists clients_phone_normalized_idx
  on public.clients (phone_normalized) where phone_normalized is not null;
create index if not exists clients_created_at_idx
  on public.clients (created_at desc) where archived_at is null;
create index if not exists clients_full_name_trgm_idx
  on public.clients (lower(full_name));

comment on column public.clients.email_normalized is
  'Generated: lower(trim(email)). Match key. Cannot be written directly, including by service_role.';
comment on column public.clients.phone_normalized is
  'Generated: E.164 form when a country code was supplied, otherwise NULL. Never guessed.';
comment on table public.clients is
  'Client records. Clients are NEVER matched by name; see public.create_enquiry_intake.';
