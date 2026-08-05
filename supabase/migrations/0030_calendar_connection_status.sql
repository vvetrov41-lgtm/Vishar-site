-- 0030_calendar_connection_status.sql
--
-- CRM-visible, metadata-only status for the separate Vladimir and Kristina
-- Google Calendar connections. Provider credentials remain in encrypted
-- Cloudflare KV; these functions cannot return token material, raw provider
-- responses or a KV key.
--
-- Forward-only. No OAuth consent, provider call, cron or deployment is enabled.

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
  v_integration_id uuid;
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

  if v_artist_slug not in ('vladimir', 'kristina') then
    raise exception 'calendar artist route is unsupported'
      using errcode = '22023';
  end if;

  if p_integration_key is distinct from ('google_calendar_' || v_artist_slug) then
    raise exception 'calendar integration key does not match artist route'
      using errcode = '22023';
  end if;

  v_external_account_label := lower(btrim(coalesce(p_external_account_label, '')));
  if v_external_account_label = ''
     or length(v_external_account_label) > 320
     or v_external_account_label !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'calendar account label is invalid'
      using errcode = '22023';
  end if;

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
    p_integration_key,
    v_external_account_label,
    jsonb_build_object(
      'calendar_id', 'primary',
      'oauth_scope', 'calendar.events',
      'connection_mode', 'worker_oauth'
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
      'integration_key', p_integration_key,
      'is_enabled', p_is_enabled
    )
  );

  return jsonb_build_object(
    'integration_id', v_integration_id,
    'artist_id', p_artist_id,
    'provider', 'google',
    'integration_key', p_integration_key,
    'is_enabled', p_is_enabled
  );
end;
$$;

revoke all on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  to service_role;

comment on function public.set_calendar_connection_metadata(uuid,text,text,boolean) is
  'Backend-only Google Calendar connection metadata upsert. Provider, configuration and supported artist routes are fixed server-side; no token material is accepted or returned.';

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
  with supported_artists as (
    select
      a.id,
      a.slug,
      a.display_name,
      case a.slug
        when 'vladimir' then 'google_calendar_vladimir'
        when 'kristina' then 'google_calendar_kristina'
      end as expected_integration_key
    from public.artists a
    where a.is_active
      and a.slug in ('vladimir', 'kristina')
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
    join supported_artists a on a.id = o.artist_id
    left join public.artist_integrations i
      on i.artist_id = a.id
     and i.integration_type = 'calendar'
     and i.provider = 'google'
     and i.integration_key = a.expected_integration_key
    where o.kind in ('calendar_create', 'calendar_update', 'calendar_cancel')
    group by o.artist_id
  ),
  calendar_sync as (
    select
      s.artist_id,
      max(s.calendar_last_synced_at) as last_successful_sync_at
    from public.sessions s
    join supported_artists a on a.id = s.artist_id
    where s.calendar_last_synced_at is not null
    group by s.artist_id
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
  from supported_artists a
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
      and o.kind in ('calendar_create', 'calendar_update', 'calendar_cancel')
      and o.status in ('failed', 'dead')
      and o.last_error_code is not null
      and (i.updated_at is null or o.updated_at >= i.updated_at)
    order by o.updated_at desc, o.id desc
    limit 1
  ) e on true
  order by case a.slug when 'vladimir' then 1 else 2 end;
$$;

revoke all on function public.list_calendar_connection_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_calendar_connection_status()
  to authenticated;

comment on function public.list_calendar_connection_status() is
  'Returns safe per-artist Google Calendar connection and current queue metadata only to CRM users with can_manage_integrations for that artist. Historical failures before the latest connection update are excluded, while pending and leased work remains visible.';