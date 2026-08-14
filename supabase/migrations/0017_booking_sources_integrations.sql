-- 0017_booking_sources_integrations.sql
--
-- Trusted server-side booking source resolution and metadata-only artist
-- integration records. No provider credential, OAuth token, Telegram chat id,
-- payment secret or GPT key belongs in these tables.
--
-- The current Worker is not switched by this migration. Migration 0020 will
-- add the artist-aware intake workflow, and the Worker will then pass only a
-- server-configured source key plus the verified request Origin.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.artist_integration_type as enum (
    'telegram', 'calendar', 'email', 'payments', 'gpt'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Canonical booking origins
-- ---------------------------------------------------------------------------

create or replace function crm_private.canonical_booking_origin(p_origin text)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, crm_private
as $$
declare
  v_origin text;
begin
  if p_origin is null then
    return null;
  end if;

  v_origin := lower(rtrim(btrim(p_origin), '/'));

  if v_origin !~ '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$' then
    raise exception 'booking origin must be one canonical HTTPS origin'
      using errcode = '22023';
  end if;

  return v_origin;
end;
$$;

revoke all on function crm_private.canonical_booking_origin(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Booking sources
--
-- `source_key` is selected by trusted Worker configuration. A browser form may
-- still submit marketing attribution text, but it is never authoritative for
-- artist ownership.
-- ---------------------------------------------------------------------------

create table if not exists public.booking_sources (
  id             uuid primary key default gen_random_uuid(),
  artist_id      uuid not null references public.artists(id) on delete restrict,
  source_key     text not null,
  allowed_origin text,
  form_version   text not null,
  is_active      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint booking_sources_source_key_key unique (source_key),
  constraint booking_sources_source_key_shape
    check (source_key ~ '^[a-z][a-z0-9-]{2,79}$'),
  constraint booking_sources_form_version_not_blank
    check (btrim(form_version) <> ''),
  constraint booking_sources_form_version_length
    check (char_length(form_version) <= 80),
  constraint booking_sources_origin_canonical
    check (
      allowed_origin is null
      or allowed_origin = crm_private.canonical_booking_origin(allowed_origin)
    ),
  constraint booking_sources_active_requires_origin
    check (not is_active or allowed_origin is not null)
);

comment on table public.booking_sources is
  'Trusted server-side mapping from a Worker source key and exact request Origin to one artist. Browser data never selects artist_id.';
comment on column public.booking_sources.source_key is
  'Non-secret stable routing key configured on the server. It must not be accepted from multipart form data as authoritative input.';
comment on column public.booking_sources.allowed_origin is
  'Exact canonical HTTPS Origin. NULL is permitted only while a source is inactive and awaiting its real website domain.';

create index if not exists booking_sources_artist_idx
  on public.booking_sources (artist_id, source_key);
create index if not exists booking_sources_active_origin_idx
  on public.booking_sources (allowed_origin, source_key)
  where is_active;

-- ---------------------------------------------------------------------------
-- Artist integrations
--
-- Safe labels and provider-neutral configuration only. Secret values remain in
-- encrypted Cloudflare server-side configuration and are selected using the
-- non-secret `integration_key`.
-- ---------------------------------------------------------------------------

create table if not exists public.artist_integrations (
  id                     uuid primary key default gen_random_uuid(),
  artist_id              uuid not null references public.artists(id) on delete restrict,
  integration_type       public.artist_integration_type not null,
  provider               text not null,
  integration_key        text not null,
  external_account_label text,
  configuration          jsonb not null default '{}'::jsonb,
  is_enabled             boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint artist_integrations_artist_type_key_key
    unique (artist_id, integration_type, integration_key),
  constraint artist_integrations_provider_shape
    check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint artist_integrations_key_shape
    check (integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint artist_integrations_label_length
    check (
      external_account_label is null
      or (
        btrim(external_account_label) <> ''
        and char_length(external_account_label) <= 160
      )
    ),
  constraint artist_integrations_configuration_object
    check (jsonb_typeof(configuration) = 'object'),
  constraint artist_integrations_configuration_size
    check (pg_column_size(configuration) <= 8192)
);

comment on table public.artist_integrations is
  'Artist-scoped provider metadata only. Tokens, chat ids, OAuth credentials, payment secrets and private keys are prohibited.';
comment on column public.artist_integrations.integration_key is
  'Non-secret server configuration selector. The corresponding secret binding is stored only in encrypted Cloudflare configuration.';
comment on column public.artist_integrations.configuration is
  'Safe non-secret settings such as calendar name, sender label, locale or routing mode. Recursive guards reject credential-shaped keys and values.';

create index if not exists artist_integrations_artist_type_idx
  on public.artist_integrations (artist_id, integration_type, is_enabled);

-- ---------------------------------------------------------------------------
-- Recursive no-secrets guard
-- ---------------------------------------------------------------------------

create or replace function crm_private.find_forbidden_integration_key(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, crm_private
as $$
declare
  v_key text;
  v_key_lower text;
  v_child jsonb;
  v_nested text;
  v_exact text[] := array[
    'token', 'access_token', 'refresh_token', 'id_token', 'bot_token',
    'api_key', 'secret', 'client_secret', 'webhook_secret', 'signing_secret',
    'password', 'passphrase', 'credential', 'credentials', 'authorization',
    'private_key', 'service_key', 'service_role_key', 'supabase_service_key',
    'chat_id', 'telegram_chat_id', 'destination_chat_id', 'webhook_key',
    'signing_key', 'encryption_key'
  ];
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      v_key_lower := lower(v_key);

      if v_key_lower = any (v_exact)
         or v_key_lower ~ '(^|_)(access|refresh|service|private|signing|webhook|bot)?_?token$'
         or v_key_lower ~ '(^|_)(api|service|private|signing|webhook|encryption)_?key$'
         or v_key_lower ~ '(^|_)(client|webhook|signing)?_?secret$'
         or v_key_lower ~ '(^|_)password$'
         or v_key_lower ~ '(^|_)(telegram_)?chat_id$' then
        return v_key;
      end if;

      v_nested := crm_private.find_forbidden_integration_key(v_child);
      if v_nested is not null then
        return v_nested;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      v_nested := crm_private.find_forbidden_integration_key(v_child);
      if v_nested is not null then
        return v_nested;
      end if;
    end loop;
  end if;

  return null;
end;
$$;

create or replace function crm_private.find_suspicious_integration_value(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, crm_private
as $$
declare
  v_child jsonb;
  v_text text;
  v_nested text;
begin
  if jsonb_typeof(p_value) = 'string' then
    v_text := trim(both '"' from p_value::text);

    if v_text ~ '^(sk|rk)_(live|test)_[A-Za-z0-9]'
       or v_text ~ '^whsec_[A-Za-z0-9]'
       or v_text ~ '^sk-proj-[A-Za-z0-9]'
       or v_text ~ '^sb_secret_[A-Za-z0-9]'
       or v_text ~ '^gh[pousr]_[A-Za-z0-9]'
       or v_text ~ '^xox[baprs]-[A-Za-z0-9-]'
       or v_text ~ '^-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----'
       or v_text ~ '^[0-9]{6,}:[A-Za-z0-9_-]{20,}$' then
      return left(v_text, 16);
    end if;
  elsif jsonb_typeof(p_value) = 'object' then
    for v_child in select value from jsonb_each(p_value) loop
      v_nested := crm_private.find_suspicious_integration_value(v_child);
      if v_nested is not null then
        return v_nested;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      v_nested := crm_private.find_suspicious_integration_value(v_child);
      if v_nested is not null then
        return v_nested;
      end if;
    end loop;
  end if;

  return null;
end;
$$;

create or replace function crm_private.guard_artist_integration_configuration()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_key text;
  v_value_prefix text;
begin
  v_key := crm_private.find_forbidden_integration_key(new.configuration);
  if v_key is not null then
    raise exception 'artist integration configuration may not contain credential key %', v_key
      using errcode = '23514',
            detail = 'Store credentials only in encrypted server-side Cloudflare configuration.';
  end if;

  v_value_prefix := crm_private.find_suspicious_integration_value(new.configuration);
  if v_value_prefix is not null then
    raise exception 'artist integration configuration contains a credential-shaped value'
      using errcode = '23514',
            detail = 'Store credentials only in encrypted server-side Cloudflare configuration.';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.find_forbidden_integration_key(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.find_suspicious_integration_value(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_artist_integration_configuration()
  from public, anon, authenticated, service_role;

drop trigger if exists artist_integrations_guard_configuration
  on public.artist_integrations;
create trigger artist_integrations_guard_configuration
  before insert or update of configuration on public.artist_integrations
  for each row execute function crm_private.guard_artist_integration_configuration();

-- ---------------------------------------------------------------------------
-- Identity and active-artist invariants
-- ---------------------------------------------------------------------------

create or replace function crm_private.protect_booking_source_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.artist_id is distinct from old.artist_id
       or new.source_key is distinct from old.source_key
     ) then
    raise exception 'booking source identity is immutable; deactivate it and create a new source'
      using errcode = '23514';
  end if;

  if new.allowed_origin is not null then
    new.allowed_origin := crm_private.canonical_booking_origin(new.allowed_origin);
  end if;

  if new.is_active then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

create or replace function crm_private.protect_artist_integration_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.artist_id is distinct from old.artist_id
       or new.integration_type is distinct from old.integration_type
       or new.integration_key is distinct from old.integration_key
     ) then
    raise exception 'artist integration identity is immutable; disable it and create a new integration'
      using errcode = '23514';
  end if;

  if new.is_enabled then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_booking_source_identity()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.protect_artist_integration_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_sources_protect_identity on public.booking_sources;
create trigger booking_sources_protect_identity
  before insert or update on public.booking_sources
  for each row execute function crm_private.protect_booking_source_identity();

drop trigger if exists artist_integrations_protect_identity on public.artist_integrations;
create trigger artist_integrations_protect_identity
  before insert or update on public.artist_integrations
  for each row execute function crm_private.protect_artist_integration_identity();

drop trigger if exists booking_sources_set_updated_at on public.booking_sources;
create trigger booking_sources_set_updated_at
  before update on public.booking_sources
  for each row execute function public.set_updated_at();

drop trigger if exists artist_integrations_set_updated_at on public.artist_integrations;
create trigger artist_integrations_set_updated_at
  before update on public.artist_integrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Initial logical sources
--
-- Both are intentionally inactive in every environment. Vladimir's real site
-- origin is known; Kristina's production origin is left NULL rather than
-- guessed. Activation happens only after the matching Worker configuration and
-- website endpoint are reviewed.
-- ---------------------------------------------------------------------------

insert into public.booking_sources (
  id, artist_id, source_key, allowed_origin, form_version, is_active
) values
  (
    'b1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'vladimir-website',
    'https://vishartattoo.com',
    'booking-v1',
    false
  ),
  (
    'b2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'kristina-website',
    null,
    'booking-v1',
    false
  )
on conflict (source_key) do nothing;

-- ---------------------------------------------------------------------------
-- Trusted source resolver
--
-- The Worker calls this with a source key from encrypted/server configuration,
-- the already verified request Origin, and the deployed form version. The
-- multipart body cannot override any of these values.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_booking_source(
  p_source_key text,
  p_origin text,
  p_form_version text
)
returns table (
  booking_source_id uuid,
  artist_id uuid,
  source_key text,
  form_version text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_origin text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted booking source resolution is backend-only'
      using errcode = '42501';
  end if;

  if p_source_key is null or btrim(p_source_key) = '' then
    raise exception 'booking source key is required' using errcode = '22023';
  end if;

  if p_form_version is null or btrim(p_form_version) = '' then
    raise exception 'booking form version is required' using errcode = '22023';
  end if;

  v_origin := crm_private.canonical_booking_origin(p_origin);
  if v_origin is null then
    raise exception 'booking origin is required' using errcode = '22023';
  end if;

  return query
  select s.id, s.artist_id, s.source_key, s.form_version
  from public.booking_sources s
  join crm_private.artist_state a on a.artist_id = s.artist_id
  where s.source_key = p_source_key
    and s.allowed_origin = v_origin
    and s.form_version = p_form_version
    and s.is_active
    and a.is_active;

  if not found then
    raise exception 'booking source, origin or form version is not permitted'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.resolve_booking_source(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_booking_source(text, text, text)
  to service_role;

comment on function public.resolve_booking_source(text, text, text) is
  'Backend-only exact mapping from server source key + request Origin + form version to one artist. It accepts no artist_id.';

-- ---------------------------------------------------------------------------
-- RLS and API privileges
-- ---------------------------------------------------------------------------

alter table public.booking_sources enable row level security;
alter table public.booking_sources force row level security;
alter table public.artist_integrations enable row level security;
alter table public.artist_integrations force row level security;

revoke all on public.booking_sources
  from public, anon, authenticated, service_role;
revoke all on public.artist_integrations
  from public, anon, authenticated, service_role;

grant select on public.booking_sources to authenticated;
grant select on public.artist_integrations to authenticated;

drop policy if exists booking_sources_select on public.booking_sources;
create policy booking_sources_select on public.booking_sources
  for select
  using (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

drop policy if exists booking_sources_insert on public.booking_sources;
create policy booking_sources_insert on public.booking_sources
  for insert
  with check (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

drop policy if exists booking_sources_update on public.booking_sources;
create policy booking_sources_update on public.booking_sources
  for update
  using (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  )
  with check (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

drop policy if exists artist_integrations_select on public.artist_integrations;
create policy artist_integrations_select on public.artist_integrations
  for select
  using (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

drop policy if exists artist_integrations_insert on public.artist_integrations;
create policy artist_integrations_insert on public.artist_integrations
  for insert
  with check (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

drop policy if exists artist_integrations_update on public.artist_integrations;
create policy artist_integrations_update on public.artist_integrations
  for update
  using (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  )
  with check (
    public.can_manage_artist_integrations(artist_id)
    or crm_private.is_service_backend()
  );

-- No browser or service role receives direct INSERT/UPDATE/DELETE privileges.
-- Later audited owner/manager changes use named SECURITY DEFINER RPCs.
