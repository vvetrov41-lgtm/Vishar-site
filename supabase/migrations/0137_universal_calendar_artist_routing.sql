-- 0137_universal_calendar_artist_routing.sql
--
-- Make Google Calendar onboarding work for every current and future artist
-- without a source-code change and without artist-specific Worker variables.
--
-- Before this migration the Calendar Worker enumerated `vladimir` and
-- `kristina` in JavaScript, read `VLADIMIR_*` / `KRISTINA_*` bindings for the
-- artist id and the expected Google account, and `set_calendar_connection_metadata`
-- rejected every other slug. Production already runs a third active artist
-- (`sam`) whose booking manager holds `can_manage_integrations` and cannot
-- connect a calendar at all.
--
-- The replacement keeps every existing boundary:
--   * Supabase appointments stay authoritative, Google Calendar stays a projection;
--   * refresh tokens stay in encrypted Cloudflare KV keyed by artist UUID;
--   * the browser never selects artist ownership or a provider account;
--   * artist resolution stays backend-only and capability-checked.
--
-- Forward-only and additive. No earlier migration is edited.

-- ---------------------------------------------------------------------------
-- 1. Existing data must already satisfy the new invariants
--
-- A silent backfill would hide a real ownership problem, so an unexpected row
-- fails the migration instead.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from public.artist_integrations i
    join public.artists a on a.id = i.artist_id
    where i.integration_type = 'calendar'::public.artist_integration_type
      and (
        i.provider <> 'google'
        or i.integration_key <> 'google_calendar_' || a.slug
      )
  ) then
    raise exception 'existing calendar integration key is not the exact owning artist route'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.artist_integrations i
    where i.integration_type = 'calendar'::public.artist_integration_type
      and i.external_account_label is not null
    group by lower(btrim(i.external_account_label))
    having count(*) > 1
  ) then
    raise exception 'existing calendar Google accounts are shared between artists'
      using errcode = '23505';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The calendar route selector is derived from the owning artist slug
--
-- Same rule the WhatsApp routes got in 0129: the selector cannot drift from the
-- artist that owns it, so a Worker can trust `google_calendar_<slug>` without
-- carrying its own artist table.
-- ---------------------------------------------------------------------------

create or replace function crm_private.enforce_exact_calendar_artist_route_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
begin
  if new.integration_type <> 'calendar'::public.artist_integration_type then
    return new;
  end if;

  select a.slug
    into v_artist_slug
  from public.artists a
  where a.id = new.artist_id;

  if not found then
    raise exception 'artist does not exist'
      using errcode = '23503';
  end if;

  if new.provider <> 'google' then
    raise exception 'calendar integrations support only the google provider'
      using errcode = '23514';
  end if;

  if new.integration_key <> 'google_calendar_' || v_artist_slug then
    raise exception 'calendar integration key must be the exact owning artist route'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.enforce_exact_calendar_artist_route_key()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_exact_calendar_artist_route_key
  on public.artist_integrations;
create trigger enforce_exact_calendar_artist_route_key
  before insert or update of artist_id, integration_type, provider, integration_key
  on public.artist_integrations
  for each row execute function crm_private.enforce_exact_calendar_artist_route_key();

comment on function crm_private.enforce_exact_calendar_artist_route_key() is
  'Keeps every Google Calendar selector equal to google_calendar_<owning artist slug>, so a Worker can validate the route shape without an artist allowlist.';

-- ---------------------------------------------------------------------------
-- 3. One Google account backs at most one artist calendar
--
-- Two artists sharing one Google account would write both artists'
-- appointments into the same primary calendar and make the projection
-- unattributable. The pin also survives disconnect, which is what keeps a
-- reconnect bound to the account that was originally authorised.
-- ---------------------------------------------------------------------------

create unique index if not exists artist_integrations_calendar_account_unique
  on public.artist_integrations (lower(btrim(external_account_label)))
  where integration_type = 'calendar'::public.artist_integration_type
    and external_account_label is not null;

-- ---------------------------------------------------------------------------
-- 4. Server-owned event presentation
--
-- Event visibility, display name, colour and label used to live in
-- `VLADIMIR_GOOGLE_EVENT_*` / `KRISTINA_GOOGLE_EVENT_*` Worker variables. They
-- are non-secret presentation settings, so they belong in the same safe
-- configuration blob the drain already reads through `resolve_outbox_route`.
-- ---------------------------------------------------------------------------

create or replace function crm_private.calendar_presentation_defaults(p_artist_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'event_visibility', 'public',
    'event_display_name', left(btrim(a.display_name), 80),
    'event_color_id', null,
    'event_label_name', null,
    'event_label_color', null
  )
  from public.artists a
  where a.id = p_artist_id;
$$;

revoke all on function crm_private.calendar_presentation_defaults(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.normalized_calendar_presentation(
  p_artist_id uuid,
  p_existing jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_defaults jsonb;
  v_existing jsonb;
  v_visibility text;
  v_display_name text;
  v_color_id text;
  v_label_name text;
  v_label_color text;
begin
  v_defaults := crm_private.calendar_presentation_defaults(p_artist_id);
  if v_defaults is null then
    raise exception 'artist does not exist' using errcode = '23503';
  end if;

  v_existing := case
    when jsonb_typeof(p_existing) = 'object' then p_existing
    else '{}'::jsonb
  end;

  v_visibility := nullif(btrim(coalesce(v_existing ->> 'event_visibility', '')), '');
  if v_visibility is null or v_visibility not in ('default', 'public', 'private') then
    v_visibility := v_defaults ->> 'event_visibility';
  end if;

  v_display_name := nullif(btrim(coalesce(v_existing ->> 'event_display_name', '')), '');
  if v_display_name is null or char_length(v_display_name) > 80 then
    v_display_name := v_defaults ->> 'event_display_name';
  end if;

  v_color_id := nullif(btrim(coalesce(v_existing ->> 'event_color_id', '')), '');
  if v_color_id is not null and v_color_id !~ '^([1-9]|10|11)$' then
    v_color_id := null;
  end if;

  v_label_name := nullif(btrim(coalesce(v_existing ->> 'event_label_name', '')), '');
  if v_label_name is not null and char_length(v_label_name) > 50 then
    v_label_name := null;
  end if;

  v_label_color := lower(nullif(btrim(coalesce(v_existing ->> 'event_label_color', '')), ''));
  if v_label_color is not null and v_label_color !~ '^#[0-9a-f]{6}$' then
    v_label_color := null;
  end if;

  -- A label needs both halves or neither; a half-configured label would make
  -- every connection attempt fail the Worker's label lookup.
  if v_label_name is null or v_label_color is null then
    v_label_name := null;
    v_label_color := null;
  end if;

  return jsonb_build_object(
    'event_visibility', v_visibility,
    'event_display_name', v_display_name,
    'event_color_id', v_color_id,
    'event_label_name', v_label_name,
    'event_label_color', v_label_color
  );
end;
$$;

revoke all on function crm_private.normalized_calendar_presentation(uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function crm_private.normalized_calendar_presentation(uuid, jsonb) is
  'Server-owned Google Calendar event presentation for one artist. Unknown or malformed values fall back to the artist default rather than reaching the provider.';

-- ---------------------------------------------------------------------------
-- 5. Connection metadata upsert, for any artist
--
-- Replaces the vladimir/kristina allowlist. The Google account label is pinned
-- on first connect: while a pin exists the Worker may only re-assert the same
-- account, so a stolen consent for a different Google account cannot silently
-- re-point an artist's projection.
-- ---------------------------------------------------------------------------

create or replace function public.set_calendar_connection_metadata(
  p_artist_id uuid,
  p_integration_key text,
  p_external_account_label text,
  p_is_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
  v_external_account_label text;
  v_existing_label text;
  v_existing_configuration jsonb;
  v_presentation jsonb;
  v_integration_id uuid;
  v_reconciled integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar connection metadata is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null or p_is_enabled is null then
    raise exception 'calendar connection metadata is incomplete'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  select a.slug
  into v_artist_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_artist_slug is null then
    raise exception 'calendar artist is not active'
      using errcode = '55000';
  end if;

  if p_integration_key is distinct from ('google_calendar_' || v_artist_slug) then
    raise exception 'calendar integration key does not match artist route'
      using errcode = '22023';
  end if;

  v_external_account_label := lower(btrim(coalesce(p_external_account_label, '')));
  if v_external_account_label = ''
     or length(v_external_account_label) > 160
     or v_external_account_label !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'calendar account label is invalid'
      using errcode = '22023';
  end if;

  select i.external_account_label, i.configuration
    into v_existing_label, v_existing_configuration
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.integration_key = 'google_calendar_' || v_artist_slug;

  if v_existing_label is not null
     and lower(btrim(v_existing_label)) is distinct from v_external_account_label then
    raise exception 'calendar account is already bound to a different Google account'
      using errcode = '23505',
            detail = 'Disconnect and clear the recorded account before binding a different one.';
  end if;

  if exists (
    select 1
    from public.artist_integrations i
    where i.integration_type = 'calendar'::public.artist_integration_type
      and i.artist_id <> p_artist_id
      and lower(btrim(i.external_account_label)) = v_external_account_label
  ) then
    raise exception 'calendar account is already bound to another artist'
      using errcode = '23505';
  end if;

  v_presentation := crm_private.normalized_calendar_presentation(
    p_artist_id,
    v_existing_configuration -> 'presentation'
  );

  insert into public.artist_integrations (
    artist_id,
    integration_type,
    provider,
    integration_key,
    external_account_label,
    configuration,
    is_enabled
  ) values (
    p_artist_id,
    'calendar',
    'google',
    'google_calendar_' || v_artist_slug,
    v_external_account_label,
    jsonb_build_object(
      'calendar_id', 'primary',
      'oauth_scope', 'calendar.events',
      'connection_mode', 'worker_oauth',
      'artist_slug', v_artist_slug,
      'presentation', v_presentation
    ),
    p_is_enabled
  )
  on conflict (artist_id, integration_type, integration_key) do update
    set provider = 'google',
        external_account_label = excluded.external_account_label,
        configuration = excluded.configuration,
        is_enabled = excluded.is_enabled,
        updated_at = now()
  returning id into v_integration_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    case
      when p_is_enabled then 'integration.calendar_connected'
      else 'integration.calendar_disconnected'
    end,
    'worker',
    null,
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'integration_type', 'calendar',
      'provider', 'google',
      'integration_key', 'google_calendar_' || v_artist_slug,
      'is_enabled', p_is_enabled
    )
  );

  -- Reconnecting re-queues Time Off blocks that never reached Google, exactly
  -- as migration 0041 established. Losing this would silently drop the
  -- recovery path for every artist.
  if p_is_enabled then
    v_reconciled := crm_private.reconcile_artist_availability_calendar(p_artist_id);
  end if;

  return jsonb_build_object(
    'integration_id', v_integration_id,
    'artist_id', p_artist_id,
    'artist_slug', v_artist_slug,
    'provider', 'google',
    'integration_key', 'google_calendar_' || v_artist_slug,
    'is_enabled', p_is_enabled,
    'reconciled_availability_jobs', v_reconciled
  );
end;
$$;

revoke all on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  to service_role;

comment on function public.set_calendar_connection_metadata(uuid,text,text,boolean) is
  'Backend-only Google Calendar connection metadata upsert for any active artist. The route selector is derived from the artist slug, the Google account is pinned on first connect, and no token material is accepted or returned.';

-- ---------------------------------------------------------------------------
-- 6. Backend-only artist resolution for the Calendar Worker
--
-- The artist reference in an OAuth URL is a lookup hint. This is the only
-- authority on which artist it means, whether that artist is active, whether
-- the Access-verified operator may manage its integrations, and which Google
-- account the connection must use. Unknown, inactive and unauthorized are all
-- the same answer so the endpoint cannot enumerate artists.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_calendar_artist_route(
  p_actor_email text,
  p_artist_ref text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ref text;
  v_artist_id uuid;
  v_slug text;
  v_display_name text;
  v_integration record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar artist resolution is backend-only'
      using errcode = '42501';
  end if;

  v_ref := btrim(coalesce(p_artist_ref, ''));
  if v_ref = '' or btrim(coalesce(p_actor_email, '')) = '' then
    return null;
  end if;

  if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select a.id, a.slug, a.display_name
      into v_artist_id, v_slug, v_display_name
    from public.artists a
    where a.id = v_ref::uuid
      and a.is_active;
  elsif v_ref ~ '^[a-z][a-z0-9-]{1,62}$' then
    select a.id, a.slug, a.display_name
      into v_artist_id, v_slug, v_display_name
    from public.artists a
    where a.slug = v_ref
      and a.is_active;
  else
    return null;
  end if;

  if v_artist_id is null then
    return null;
  end if;

  -- Same predicate as public.authorize_calendar_actor: an active CRM profile,
  -- an active membership of this exact artist, and current
  -- manage-integrations capability.
  if not exists (
    select 1
    from public.profiles p
    join crm_private.profile_access pa
      on pa.profile_id = p.id
    join crm_private.artist_access aa
      on aa.profile_id = p.id
     and aa.artist_id = v_artist_id
    join crm_private.artist_state ast
      on ast.artist_id = aa.artist_id
    where lower(btrim(p.email)) = lower(btrim(p_actor_email))
      and pa.is_active
      and aa.is_active
      and ast.is_active
      and (
        pa.role = 'owner'
        or (pa.role = 'booking_manager' and aa.can_manage_integrations)
      )
  ) then
    return null;
  end if;

  select i.external_account_label, i.is_enabled, i.configuration
    into v_integration
  from public.artist_integrations i
  where i.artist_id = v_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.integration_key = 'google_calendar_' || v_slug;

  return jsonb_build_object(
    'artist_id', v_artist_id,
    'artist_slug', v_slug,
    'artist_display_name', v_display_name,
    'integration_key', 'google_calendar_' || v_slug,
    'expected_account_email', lower(nullif(btrim(coalesce(v_integration.external_account_label, '')), '')),
    'connected', coalesce(v_integration.is_enabled, false),
    'presentation', crm_private.normalized_calendar_presentation(
      v_artist_id,
      v_integration.configuration -> 'presentation'
    )
  );
end;
$$;

revoke all on function public.resolve_calendar_artist_route(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_calendar_artist_route(text,text)
  to service_role;

comment on function public.resolve_calendar_artist_route(text,text) is
  'Backend-only Calendar OAuth artist resolver. Accepts an artist UUID or slug hint and returns the authoritative artist identity, route selector, pinned Google account and event presentation only when the actor currently holds manage-integrations for that active artist. Unknown, inactive and unauthorized all return null, and no profile or membership data is exposed.';

-- ---------------------------------------------------------------------------
-- 7. Clearing the recorded Google account
--
-- Trust-on-first-connect needs a supervised way back. An authorized operator
-- can forget the recorded account only while the integration is disabled, so
-- the pin can never be dropped underneath a live projection.
-- ---------------------------------------------------------------------------

create or replace function public.reset_calendar_expected_account(p_artist_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug text;
  v_is_enabled boolean;
  v_label text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(p_artist_id);

  select a.slug into v_slug
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_slug is null then
    raise exception 'calendar artist is not active' using errcode = '55000';
  end if;

  select i.is_enabled, i.external_account_label
    into v_is_enabled, v_label
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.integration_key = 'google_calendar_' || v_slug;

  if v_is_enabled is null or v_label is null then
    return jsonb_build_object('artist_id', p_artist_id, 'cleared', false);
  end if;

  if v_is_enabled then
    raise exception 'disconnect the calendar before changing its Google account'
      using errcode = '55000';
  end if;

  update public.artist_integrations i
  set external_account_label = null,
      updated_at = now()
  where i.artist_id = p_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.integration_key = 'google_calendar_' || v_slug;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'integration.calendar_account_cleared',
    'staff',
    null, null, null, null, null, null,
    jsonb_build_object(
      'integration_type', 'calendar',
      'provider', 'google',
      'integration_key', 'google_calendar_' || v_slug
    )
  );

  return jsonb_build_object('artist_id', p_artist_id, 'cleared', true);
end;
$$;

revoke all on function public.reset_calendar_expected_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reset_calendar_expected_account(uuid)
  to authenticated;

comment on function public.reset_calendar_expected_account(uuid) is
  'Clears the recorded Google account for a disconnected artist calendar so a different account can be authorised. Requires manage-integrations for that artist and refuses while the integration is enabled.';

-- ---------------------------------------------------------------------------
-- 8. Connection status, for any artist
-- ---------------------------------------------------------------------------

create or replace function public.list_calendar_connection_status()
returns table (
  artist_id uuid,
  artist_slug text,
  artist_display_name text,
  provider text,
  integration_key text,
  connected boolean,
  external_account_label text,
  connection_updated_at timestamptz,
  last_successful_sync_at timestamptz,
  queued_jobs integer,
  retrying_jobs integer,
  failed_jobs integer,
  last_error_code text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with manageable_artists as (
    select
      a.id,
      a.slug,
      a.display_name,
      'google_calendar_' || a.slug as expected_integration_key
    from public.artists a
    where a.is_active
      and public.can_manage_artist_integrations(a.id)
  ),
  calendar_jobs as (
    select
      o.artist_id,
      count(*) filter (where o.status = 'pending')::integer as queued_jobs,
      count(*) filter (where o.status = 'leased')::integer as retrying_jobs,
      count(*) filter (
        where o.status in ('failed', 'dead')
          and (i.updated_at is null or o.updated_at >= i.updated_at)
      )::integer as failed_jobs
    from public.integration_outbox o
    join manageable_artists a on a.id = o.artist_id
    left join public.artist_integrations i
      on i.artist_id = a.id
     and i.integration_type = 'calendar'
     and i.provider = 'google'
     and i.integration_key = a.expected_integration_key
    where o.kind in (
      'calendar_create', 'calendar_update', 'calendar_cancel',
      'calendar_availability_create', 'calendar_availability_update', 'calendar_availability_cancel'
    )
    group by o.artist_id
  ),
  successful_syncs as (
    select s.artist_id, s.calendar_last_synced_at
    from public.sessions s
    join manageable_artists a on a.id = s.artist_id
    where s.calendar_last_synced_at is not null
    union all
    select b.artist_id, b.calendar_last_synced_at
    from public.artist_availability_blocks b
    join manageable_artists a on a.id = b.artist_id
    where b.calendar_last_synced_at is not null
  ),
  calendar_sync as (
    select artist_id, max(calendar_last_synced_at) as last_successful_sync_at
    from successful_syncs
    group by artist_id
  )
  select
    a.id as artist_id,
    a.slug as artist_slug,
    a.display_name as artist_display_name,
    coalesce(i.provider, 'google') as provider,
    a.expected_integration_key as integration_key,
    coalesce(i.is_enabled, false) as connected,
    i.external_account_label,
    i.updated_at as connection_updated_at,
    s.last_successful_sync_at,
    coalesce(j.queued_jobs, 0) as queued_jobs,
    coalesce(j.retrying_jobs, 0) as retrying_jobs,
    coalesce(j.failed_jobs, 0) as failed_jobs,
    e.last_error_code
  from manageable_artists a
  left join public.artist_integrations i
    on i.artist_id = a.id
   and i.integration_type = 'calendar'
   and i.provider = 'google'
   and i.integration_key = a.expected_integration_key
  left join calendar_jobs j on j.artist_id = a.id
  left join calendar_sync s on s.artist_id = a.id
  left join lateral (
    select o.last_error_code
    from public.integration_outbox o
    where o.artist_id = a.id
      and o.kind in (
        'calendar_create', 'calendar_update', 'calendar_cancel',
        'calendar_availability_create', 'calendar_availability_update', 'calendar_availability_cancel'
      )
      and o.status in ('failed', 'dead')
      and o.last_error_code is not null
      and (i.updated_at is null or o.updated_at >= i.updated_at)
    order by o.updated_at desc, o.id desc
    limit 1
  ) e on true
  order by a.display_name, a.slug;
$$;

revoke all on function public.list_calendar_connection_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_calendar_connection_status()
  to authenticated;

comment on function public.list_calendar_connection_status() is
  'Returns safe per-artist Google Calendar connection and current queue metadata for every active artist the signed-in profile can manage integrations for. Historical failures before the latest connection update are excluded, while pending and leased work remains visible.';

-- ---------------------------------------------------------------------------
-- 9. Carry today's Worker-variable presentation into server-owned configuration
--
-- These are the exact values `wrangler.calendar.production.toml` supplied
-- before this change, so already-projected events keep the same visibility,
-- organiser display name, colour and Google event label.
-- ---------------------------------------------------------------------------

update public.artist_integrations i
set configuration = i.configuration
  || jsonb_build_object('artist_slug', a.slug)
  || jsonb_build_object(
       'presentation',
       crm_private.normalized_calendar_presentation(
         i.artist_id,
         jsonb_build_object(
           'event_visibility', 'public',
           'event_display_name', a.display_name,
           'event_color_id', case a.slug when 'vladimir' then '9' else null end,
           'event_label_name', case a.slug when 'kristina' then 'Wisteria' else null end,
           'event_label_color', case a.slug when 'kristina' then '#b39ddb' else null end
         )
       )
     ),
    updated_at = i.updated_at
from public.artists a
where a.id = i.artist_id
  and i.integration_type = 'calendar'::public.artist_integration_type
  and a.slug in ('vladimir', 'kristina')
  and not (i.configuration ? 'presentation');

update public.artist_integrations i
set configuration = i.configuration
  || jsonb_build_object('artist_slug', a.slug)
  || jsonb_build_object(
       'presentation',
       crm_private.normalized_calendar_presentation(i.artist_id, null)
     ),
    updated_at = i.updated_at
from public.artists a
where a.id = i.artist_id
  and i.integration_type = 'calendar'::public.artist_integration_type
  and a.slug not in ('vladimir', 'kristina')
  and not (i.configuration ? 'presentation');
