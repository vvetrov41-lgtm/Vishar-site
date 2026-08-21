-- 0078_booking_source_registry.sql
--
-- Phase H of the platform refactor. Booking intake can resolve an opaque,
-- public source id plus the exact request Origin at runtime instead of relying
-- on one BOOKING_SOURCE_KEY / ALLOWED_ORIGINS Worker configuration per site.
--
-- The public id is a selector, not authority. Authority remains in this
-- backend mapping and the observed Origin. One active HTTPS origin may belong
-- to only one artist, so changing the public id in a browser can never select a
-- different artist on the same origin. Existing source_key resolution remains
-- intact as a rollout fallback.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Public opaque source id
-- ---------------------------------------------------------------------------

alter table public.booking_sources
  add column public_source_id uuid;

-- Stable ids let the two already-deployed forms move to the registry without a
-- data-dependent website edit. They are public identifiers, not credentials.
update public.booking_sources
set public_source_id = case source_key
  when 'vladimir-website' then '39680fe5-6da0-48c0-bb6b-b543928747e2'::uuid
  when 'kristina-website' then '870e6c8d-a5f7-4c44-97b0-895b659d350f'::uuid
  else gen_random_uuid()
end
where public_source_id is null;

alter table public.booking_sources
  alter column public_source_id set default gen_random_uuid(),
  alter column public_source_id set not null;

alter table public.booking_sources
  add constraint booking_sources_public_source_id_key unique (public_source_id);

comment on column public.booking_sources.public_source_id is
  'Opaque public booking-source selector. It is not a credential and never grants artist access; the backend also requires the exact registered Origin.';

-- ---------------------------------------------------------------------------
-- Source identity and active-origin ownership
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
       or new.public_source_id is distinct from old.public_source_id
     ) then
    raise exception 'booking source identity is immutable; deactivate it and create a new source'
      using errcode = '23514';
  end if;

  if new.allowed_origin is not null then
    new.allowed_origin := crm_private.canonical_booking_origin(new.allowed_origin);
  end if;

  if new.is_active then
    perform crm_private.require_active_artist(new.artist_id);

    -- Origin is the transport-side authority. Serialize activation per origin
    -- so concurrent writes cannot create two different artist owners for the
    -- same website. Multiple sources for the same artist/origin remain valid.
    perform pg_advisory_xact_lock(hashtextextended(new.allowed_origin, 781122));

    if exists (
      select 1
      from public.booking_sources s
      where s.is_active
        and s.allowed_origin = new.allowed_origin
        and s.artist_id <> new.artist_id
        and s.id <> new.id
    ) then
      raise exception 'an active booking origin cannot route to more than one artist'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_booking_source_identity()
  from public, anon, authenticated, service_role;

-- The existing trigger already points at this function, so replacing the
-- function upgrades both INSERT and UPDATE enforcement without trigger churn.

-- ---------------------------------------------------------------------------
-- Backend runtime resolver
-- ---------------------------------------------------------------------------

create or replace function public.resolve_booking_source_public(
  p_public_source_id uuid,
  p_origin text
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
    raise exception 'public booking source resolution is backend-only'
      using errcode = '42501';
  end if;

  if p_public_source_id is null then
    raise exception 'public booking source id is required'
      using errcode = '22023';
  end if;

  v_origin := crm_private.canonical_booking_origin(p_origin);
  if v_origin is null then
    raise exception 'booking origin is required'
      using errcode = '22023';
  end if;

  return query
  select s.id, s.artist_id, s.source_key, s.form_version
  from public.booking_sources s
  join crm_private.artist_state a on a.artist_id = s.artist_id
  where s.public_source_id = p_public_source_id
    and s.allowed_origin = v_origin
    and s.is_active
    and a.is_active;

  if not found then
    raise exception 'booking source id or origin is not permitted'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.resolve_booking_source_public(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_booking_source_public(uuid, text)
  to service_role;

comment on function public.resolve_booking_source_public(uuid, text) is
  'Backend-only runtime mapping from opaque public source id + exact observed Origin to one active booking source and artist. The browser never supplies artist_id or source_key.';