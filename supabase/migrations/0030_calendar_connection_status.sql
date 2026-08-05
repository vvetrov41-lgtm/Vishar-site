-- 0030_calendar_connection_status.sql
--
-- CRM-visible, metadata-only status for the separate Vladimir and Kristina
-- Google Calendar connections. Provider credentials remain in encrypted
-- Cloudflare KV; this function cannot return token material, raw provider
-- responses or a KV key.
--
-- Forward-only. No OAuth consent, provider call, cron or deployment is enabled.

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
