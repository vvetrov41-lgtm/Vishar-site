-- 0079_hosted_booking_forms.sql
--
-- Phases I-J of the platform refactor: booking sources become a self-service
-- CRM resource and gain a distinct hosted mode.
--
-- External sources keep the Phase H security boundary: opaque public source id
-- + exact observed HTTPS Origin. Hosted sources are rendered and accepted by
-- the trusted Worker itself, so many artists may safely share the Worker host;
-- the URL's opaque source id selects the public form and the database selects
-- the artist. A browser never supplies artist_id, source_key or form_version as
-- routing authority.
--
-- This is deliberately a template registry, not an arbitrary form builder. The
-- only supported template/version in this migration is tattoo-enquiry /
-- booking-v1.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- 1. Source mode and safe public presentation metadata
-- ---------------------------------------------------------------------------

alter table public.booking_sources
  add column source_kind text not null default 'external',
  add column display_label text,
  add column form_template text not null default 'tattoo-enquiry';

update public.booking_sources
set display_label = case source_key
  when 'vladimir-website' then 'Vladimir website'
  when 'kristina-website' then 'Kristina website'
  else source_key
end
where display_label is null;

alter table public.booking_sources
  alter column display_label set not null;

alter table public.booking_sources
  add constraint booking_sources_source_kind_known
    check (source_kind in ('external', 'hosted')),
  add constraint booking_sources_display_label_shape
    check (btrim(display_label) <> '' and char_length(display_label) <= 120),
  add constraint booking_sources_form_template_known
    check (form_template in ('tattoo-enquiry'));

alter table public.booking_sources
  drop constraint booking_sources_active_requires_origin;

alter table public.booking_sources
  add constraint booking_sources_origin_matches_kind
  check (
    (source_kind = 'external' and (not is_active or allowed_origin is not null))
    or
    (source_kind = 'hosted' and allowed_origin is null)
  );

comment on column public.booking_sources.source_kind is
  'external requires exact request-Origin authorization; hosted is served by the trusted Vishar Worker and therefore has no external Origin.';
comment on column public.booking_sources.display_label is
  'Safe operator-facing/public form label. Never a provider credential or routing authority.';
comment on column public.booking_sources.form_template is
  'Server-owned allow-listed template key. Arbitrary HTML or arbitrary form schemas are not stored here.';
comment on column public.booking_sources.allowed_origin is
  'Exact canonical HTTPS Origin for external sources. Hosted sources must keep this NULL.';
comment on column public.booking_sources.source_key is
  'Immutable non-secret internal routing key. Self-service creation generates it server-side; browser form data never selects it.';

-- ---------------------------------------------------------------------------
-- 2. Identity and source-kind invariants
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
       or new.source_kind is distinct from old.source_kind
     ) then
    raise exception 'booking source identity is immutable; deactivate it and create a new source'
      using errcode = '23514';
  end if;

  new.display_label := btrim(new.display_label);

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

      -- Serialize active external ownership per Origin. Hosted sources do not
      -- participate because their own Worker route is the transport boundary.
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

-- The existing trigger already invokes this function for INSERT and UPDATE.

-- ---------------------------------------------------------------------------
-- 3. External resolvers remain external-only
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
  where s.source_kind = 'external'
    and s.source_key = p_source_key
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
  where s.source_kind = 'external'
    and s.public_source_id = p_public_source_id
    and s.allowed_origin = v_origin
    and s.is_active
    and a.is_active;

  if not found then
    raise exception 'booking source id or origin is not permitted'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.resolve_booking_source(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_booking_source(text, text, text)
  to service_role;
revoke all on function public.resolve_booking_source_public(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_booking_source_public(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Hosted public-page resolver
-- ---------------------------------------------------------------------------

create or replace function public.resolve_hosted_booking_source(
  p_public_source_id uuid
)
returns table (
  booking_source_id uuid,
  artist_id uuid,
  source_key text,
  form_version text,
  form_template text,
  display_label text,
  artist_slug text,
  artist_display_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'hosted booking source resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_public_source_id is null then
    raise exception 'public booking source id is required'
      using errcode = '22023';
  end if;

  return query
  select
    s.id,
    s.artist_id,
    s.source_key,
    s.form_version,
    s.form_template,
    s.display_label,
    a.slug,
    a.display_name
  from public.booking_sources s
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id
  where s.source_kind = 'hosted'
    and s.public_source_id = p_public_source_id
    and s.is_active
    and a.is_active
    and st.is_active;

  if not found then
    raise exception 'hosted booking source is unavailable'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.resolve_hosted_booking_source(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_hosted_booking_source(uuid)
  to service_role;

comment on function public.resolve_hosted_booking_source(uuid) is
  'Backend-only resolver for an active Vishar-hosted public booking page. Returns safe presentation metadata plus server-owned source routing data.';

-- ---------------------------------------------------------------------------
-- 5. One durable intake implementation for external and hosted sources
-- ---------------------------------------------------------------------------

create or replace function crm_private.create_enquiry_for_booking_source(
  p_booking_source_id uuid,
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source record;
  v_result jsonb;
  v_enquiry_id uuid;
  v_previous_context text;
  v_changed integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

  select s.* into v_source
  from public.booking_sources s
  join crm_private.artist_state a on a.artist_id = s.artist_id
  where s.id = p_booking_source_id
    and s.is_active
    and a.is_active;

  if not found then
    raise exception 'booking source is inactive or unavailable'
      using errcode = '42501';
  end if;

  v_previous_context := pg_catalog.current_setting('crm.trusted_booking_source_id', true);
  perform set_config('crm.trusted_booking_source_id', v_source.id::text, true);

  begin
    v_result := public.create_enquiry_intake(
      p_idempotency_key,
      p_client,
      coalesce(p_enquiry, '{}'::jsonb) || jsonb_build_object(
        '_trusted_booking_source_id', v_source.id,
        '_trusted_artist_id', v_source.artist_id
      ),
      p_files
    );
  exception when others then
    perform set_config(
      'crm.trusted_booking_source_id',
      coalesce(v_previous_context, ''),
      true
    );
    raise;
  end;

  perform set_config(
    'crm.trusted_booking_source_id',
    coalesce(v_previous_context, ''),
    true
  );

  v_enquiry_id := (v_result ->> 'enquiry_id')::uuid;

  update public.enquiries e
  set booking_source_id = v_source.id
  where e.id = v_enquiry_id
    and e.artist_id = v_source.artist_id
    and e.booking_source_id is null;
  get diagnostics v_changed = row_count;

  if not exists (
    select 1
    from public.enquiries e
    where e.id = v_enquiry_id
      and e.artist_id = v_source.artist_id
      and e.booking_source_id = v_source.id
  ) then
    raise exception 'intake replay does not match the trusted booking source'
      using errcode = '23514';
  end if;

  if v_changed = 1 then
    perform crm_private.log_artist_activity(
      v_source.artist_id,
      'enquiry.source_resolved',
      'worker',
      null,
      (v_result ->> 'client_id')::uuid,
      v_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object(
        'source_key', v_source.source_key,
        'source_kind', v_source.source_kind,
        'form_version', v_source.form_version
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'artist_id', v_source.artist_id,
    'booking_source_id', v_source.id,
    'trusted_source_key', v_source.source_key
  );
end;
$$;

revoke all on function crm_private.create_enquiry_for_booking_source(uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.create_trusted_enquiry_intake(
  p_source_key text,
  p_origin text,
  p_form_version text,
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

  select * into v_source
  from public.resolve_booking_source(p_source_key, p_origin, p_form_version);

  return crm_private.create_enquiry_for_booking_source(
    v_source.booking_source_id,
    p_idempotency_key,
    p_client,
    p_enquiry,
    p_files
  );
end;
$$;

revoke all on function public.create_trusted_enquiry_intake(text,text,text,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_trusted_enquiry_intake(text,text,text,uuid,jsonb,jsonb,jsonb)
  to service_role;

create or replace function public.create_hosted_enquiry_intake(
  p_public_source_id uuid,
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'hosted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

  select * into v_source
  from public.resolve_hosted_booking_source(p_public_source_id);

  return crm_private.create_enquiry_for_booking_source(
    v_source.booking_source_id,
    p_idempotency_key,
    p_client,
    p_enquiry,
    p_files
  );
end;
$$;

revoke all on function public.create_hosted_enquiry_intake(uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_hosted_enquiry_intake(uuid,uuid,jsonb,jsonb,jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Self-service CRM booking-source API
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
    perform crm_private.require_artist_access(p_artist_id, 'view_booking_sources');
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
    case when s.source_kind = 'hosted'
      then '/forms/' || s.public_source_id::text
      else null
    end,
    s.created_at,
    s.updated_at
  from public.booking_sources s
  where (p_artist_id is null or s.artist_id = p_artist_id)
    and crm_private.has_artist_capability(s.artist_id, 'view_booking_sources')
  order by s.created_at, s.id;
end;
$$;

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
    form_template
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
    v_template
  );

  perform crm_private.log_artist_activity(
    p_artist_id,
    'booking_source.created',
    'profile',
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'source_kind', v_kind,
      'is_active', coalesce(p_activate, false),
      'form_template', v_template
    )
  );

  return v_id;
end;
$$;

create or replace function public.update_booking_source(
  p_booking_source_id uuid,
  p_display_label text,
  p_allowed_origin text default null,
  p_is_active boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source record;
  v_label text := btrim(coalesce(p_display_label, ''));
  v_origin text;
  v_active boolean;
begin
  select s.* into v_source
  from public.booking_sources s
  where s.id = p_booking_source_id;

  if not found then
    raise exception 'booking source does not exist' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_source.artist_id, 'manage_booking_sources');

  if v_label = '' or char_length(v_label) > 120 then
    raise exception 'booking source label is required and must be at most 120 characters'
      using errcode = '22023';
  end if;

  v_active := coalesce(p_is_active, v_source.is_active);

  if v_source.source_kind = 'external' then
    v_origin := crm_private.canonical_booking_origin(p_allowed_origin);
    if v_active and v_origin is null then
      raise exception 'an active external booking source requires an origin'
        using errcode = '22023';
    end if;
  else
    if p_allowed_origin is not null and btrim(p_allowed_origin) <> '' then
      raise exception 'hosted booking sources do not accept an external origin'
        using errcode = '22023';
    end if;
    v_origin := null;
  end if;

  update public.booking_sources
  set display_label = v_label,
      allowed_origin = v_origin,
      is_active = v_active
  where id = p_booking_source_id;

  perform crm_private.log_artist_activity(
    v_source.artist_id,
    'booking_source.updated',
    'profile',
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'source_kind', v_source.source_kind,
      'is_active', v_active
    )
  );

  return true;
end;
$$;

revoke all on function public.list_booking_sources(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_booking_sources(uuid)
  to authenticated;

revoke all on function public.create_booking_source(uuid,text,text,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_booking_source(uuid,text,text,text,text,boolean)
  to authenticated;

revoke all on function public.update_booking_source(uuid,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_booking_source(uuid,text,text,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Precise booking-source RLS vocabulary
-- ---------------------------------------------------------------------------

-- Direct browser writes remain ungranted. These policies protect owner-context
-- probes and any future narrow table read without turning policy visibility into
-- the write API.
drop policy if exists booking_sources_select on public.booking_sources;
create policy booking_sources_select on public.booking_sources
  for select
  using (
    crm_private.has_artist_capability(artist_id, 'view_booking_sources')
    or crm_private.is_service_backend()
  );

drop policy if exists booking_sources_insert on public.booking_sources;
create policy booking_sources_insert on public.booking_sources
  for insert
  with check (
    crm_private.has_artist_capability(artist_id, 'manage_booking_sources')
    or crm_private.is_service_backend()
  );

drop policy if exists booking_sources_update on public.booking_sources;
create policy booking_sources_update on public.booking_sources
  for update
  using (
    crm_private.has_artist_capability(artist_id, 'manage_booking_sources')
    or crm_private.is_service_backend()
  )
  with check (
    crm_private.has_artist_capability(artist_id, 'manage_booking_sources')
    or crm_private.is_service_backend()
  );
