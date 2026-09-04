-- 0137_public_booking_slugs.sql
--
-- Stable human-readable public booking routes: /book/{artist-slug}.
-- The slug is presentation only. Durable routing still resolves to one
-- immutable booking_sources.artist_id and every enquiry persists that UUID.
--
-- Existing UUID /forms links remain valid compatibility paths.

-- ---------------------------------------------------------------------------
-- 1. One canonical public source per artist
-- ---------------------------------------------------------------------------

alter table public.booking_sources
  add column is_public_booking boolean not null default false;

comment on column public.booking_sources.is_public_booking is
  'Exactly one source may back an Artist public /book/{slug} route. The marker selects a source, never an Artist; immutable artist_id remains routing authority.';

create unique index booking_sources_one_public_per_artist_idx
  on public.booking_sources (artist_id)
  where is_public_booking;

-- Reuse source history rather than minting replacement identifiers. Prefer an
-- already-active source, then a hosted source, then the oldest stable row.
with ranked as (
  select
    s.id,
    row_number() over (
      partition by s.artist_id
      order by s.is_active desc,
               (s.source_kind = 'hosted') desc,
               s.created_at,
               s.id
    ) as position
  from public.booking_sources s
)
update public.booking_sources s
set is_public_booking = true
from ranked r
where r.id = s.id
  and r.position = 1;

-- If an active Artist already has source history but every source is disabled,
-- activate only its selected canonical source when that source can satisfy its
-- own transport invariant. This keeps existing active sources unchanged, makes
-- a previously-created hosted source usable, and leaves an incomplete external
-- source disabled rather than violating its required-origin constraint.
update public.booking_sources s
set is_active = true
from public.artists a
where s.artist_id = a.id
  and s.is_public_booking
  and a.is_active
  and (s.source_kind = 'hosted' or s.allowed_origin is not null)
  and not exists (
    select 1
    from public.booking_sources live
    where live.artist_id = s.artist_id
      and live.is_active
  );

-- The canonical designation is part of source identity. Existing management
-- APIs may relabel or enable/disable a source, but cannot move the public route
-- to a different row by mutation.
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
       or new.source_kind is distinct from old.source_kind
       or new.is_public_booking is distinct from old.is_public_booking
     ) then
    raise exception 'booking source identity is immutable; deactivate it and create a new source'
      using errcode = '23514';
  end if;

  new.display_label := coalesce(nullif(btrim(new.display_label), ''), new.source_key);

  if new.source_kind = 'external' then
    if new.allowed_origin is not null then
      new.allowed_origin := crm_private.canonical_booking_origin(new.allowed_origin);
    end if;
  elsif new.source_kind = 'hosted' then
    if new.allowed_origin is not null then
      raise exception 'hosted booking sources do not accept an external origin'
        using errcode = '23514';
    end if;
  else
    raise exception 'unknown booking source kind'
      using errcode = '22023';
  end if;

  if new.is_active then
    perform crm_private.require_active_artist(new.artist_id);

    if new.source_kind = 'external' then
      if new.allowed_origin is null then
        raise exception 'an active external booking source requires an origin'
          using errcode = '23514';
      end if;

      perform pg_advisory_xact_lock(hashtextextended(new.allowed_origin, 781122));

      if exists (
        select 1
        from public.booking_sources s
        where s.is_active
          and s.source_kind = 'external'
          and s.allowed_origin = new.allowed_origin
          and s.artist_id <> new.artist_id
          and s.id <> new.id
      ) then
        raise exception 'an active external booking origin cannot route to more than one artist'
          using errcode = '23514';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_booking_source_identity()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. First source for a future Artist automatically claims its public route
-- ---------------------------------------------------------------------------

create or replace function public.create_booking_source(
  p_artist_id uuid,
  p_source_kind text,
  p_display_label text,
  p_allowed_origin text default null,
  p_form_template text default 'tattoo-enquiry',
  p_activate boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid := gen_random_uuid();
  v_kind text := lower(btrim(coalesce(p_source_kind, '')));
  v_label text := btrim(coalesce(p_display_label, ''));
  v_origin text;
  v_template text := lower(btrim(coalesce(p_form_template, '')));
  v_public boolean;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_booking_sources');

  if v_kind not in ('external', 'hosted') then
    raise exception 'booking source kind must be external or hosted'
      using errcode = '22023';
  end if;
  if v_label = '' or char_length(v_label) > 120 then
    raise exception 'booking source label is required and must be at most 120 characters'
      using errcode = '22023';
  end if;
  if v_template <> 'tattoo-enquiry' then
    raise exception 'booking form template is not supported'
      using errcode = '22023';
  end if;

  if v_kind = 'external' then
    v_origin := crm_private.canonical_booking_origin(p_allowed_origin);
    if coalesce(p_activate, false) and v_origin is null then
      raise exception 'an active external booking source requires an origin'
        using errcode = '22023';
    end if;
  elsif p_allowed_origin is not null and btrim(p_allowed_origin) <> '' then
    raise exception 'hosted booking sources do not accept an external origin'
      using errcode = '22023';
  end if;

  -- Two simultaneous first-source creations cannot both claim the public URL.
  perform pg_advisory_xact_lock(hashtextextended('crm:public-booking:' || p_artist_id::text, 0));
  v_public := not exists (
    select 1
    from public.booking_sources s
    where s.artist_id = p_artist_id
      and s.is_public_booking
  );

  insert into public.booking_sources (
    id,
    artist_id,
    source_key,
    allowed_origin,
    form_version,
    is_active,
    public_source_id,
    source_kind,
    display_label,
    form_template,
    is_public_booking
  ) values (
    v_id,
    p_artist_id,
    'booking-' || replace(v_id::text, '-', ''),
    v_origin,
    'booking-v1',
    coalesce(p_activate, false),
    gen_random_uuid(),
    v_kind,
    v_label,
    v_template,
    v_public
  );

  perform crm_private.log_artist_activity(
    p_artist_id,
    'booking_source.created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'source_kind', v_kind,
      'is_active', coalesce(p_activate, false),
      'form_template', v_template,
      'is_public_booking', v_public
    )
  );

  return v_id;
end;
$$;

revoke all on function public.create_booking_source(uuid,text,text,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_booking_source(uuid,text,text,text,text,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Extend the existing backend-only resolver with a reserved slug namespace
-- ---------------------------------------------------------------------------

-- `public-slug:<slug>` is generated only by the trusted Worker. It is not a
-- browser field and it is accepted only at the canonical Vishar origin. Normal
-- external source/origin/version resolution is unchanged.
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
  v_slug text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'booking source resolution is backend-only'
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

  if p_source_key like 'public-slug:%' then
    if v_origin <> 'https://vishartattoo.com' then
      raise exception 'public booking slug origin is not permitted'
        using errcode = '42501';
    end if;

    v_slug := substr(p_source_key, char_length('public-slug:') + 1);
    if v_slug !~ '^[a-z][a-z0-9-]{1,62}$' then
      raise exception 'public booking slug is invalid'
        using errcode = '22023';
    end if;

    return query
    select s.id, s.artist_id, s.source_key, s.form_version
    from public.artists a
    join crm_private.artist_state st on st.artist_id = a.id
    join public.booking_sources s on s.artist_id = a.id
    where a.slug = v_slug
      and a.is_active
      and st.is_active
      and s.is_public_booking
      and s.is_active
      and s.form_template = 'tattoo-enquiry'
      and s.form_version = p_form_version;
  else
    return query
    select s.id, s.artist_id, s.source_key, s.form_version
    from public.booking_sources s
    join crm_private.artist_state a on a.artist_id = s.artist_id
    where s.source_kind = 'external'
      and s.source_key = p_source_key
      and s.allowed_origin = v_origin
      and s.form_version = p_form_version
      and s.is_active
      and a.is_active;
  end if;

  if not found then
    raise exception 'booking source, origin or form version is not permitted'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.resolve_booking_source(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_booking_source(text,text,text)
  to service_role;

comment on function public.resolve_booking_source(text,text,text) is
  'Backend-only source resolver. public-slug:<Artist slug> at https://vishartattoo.com resolves the one active canonical public source; all other calls retain exact external source/origin/version semantics.';

-- ---------------------------------------------------------------------------
-- 4. CRM readback returns the canonical human URL without changing result shape
-- ---------------------------------------------------------------------------

create or replace function public.list_booking_sources(p_artist_id uuid default null)
returns table (
  id uuid,
  artist_id uuid,
  public_source_id uuid,
  source_kind text,
  display_label text,
  allowed_origin text,
  form_template text,
  form_version text,
  is_active boolean,
  public_path text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not public.is_active_user() then
    raise exception 'an active CRM profile is required' using errcode = '42501';
  end if;

  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'manage_booking_sources');
  end if;

  return query
  select
    s.id,
    s.artist_id,
    s.public_source_id,
    s.source_kind,
    s.display_label,
    s.allowed_origin,
    s.form_template,
    s.form_version,
    s.is_active,
    case
      when s.is_public_booking
        then 'https://vishartattoo.com/book/' || a.slug
      when s.source_kind = 'hosted'
        then '/forms/' || s.public_source_id::text
      else null
    end,
    s.created_at,
    s.updated_at
  from public.booking_sources s
  join public.artists a on a.id = s.artist_id
  where (p_artist_id is null or s.artist_id = p_artist_id)
    and crm_private.has_artist_capability(s.artist_id, 'manage_booking_sources')
  order by s.created_at, s.id;
end;
$$;

revoke all on function public.list_booking_sources(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_booking_sources(uuid)
  to authenticated;

comment on function public.list_booking_sources(uuid) is
  'Lists booking-source configuration for Artists the caller may manage. A canonical public source exposes its stable https://vishartattoo.com/book/{slug} URL through public_path; noncanonical hosted sources retain legacy UUID paths.';
