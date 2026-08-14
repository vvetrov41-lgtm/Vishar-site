-- 0025_artist_outbox_routes.sql
--
-- Backend-only artist-specific provider routing. The outbox row supplies the
-- event-time artist and its kind supplies the integration type. Browser input
-- cannot select an artist, provider account or payment destination.
--
-- Forward-only.

create unique index if not exists artist_integrations_one_enabled_type_idx
  on public.artist_integrations (artist_id, integration_type)
  where is_enabled;

create or replace function public.resolve_outbox_route(p_outbox_id uuid)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  integration_type public.artist_integration_type,
  provider text,
  integration_key text,
  external_account_label text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_kind public.outbox_kind;
  v_integration_type public.artist_integration_type;
begin
  if not crm_private.is_service_backend() then
    raise exception 'outbox route resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'outbox id is required' using errcode = '22023';
  end if;

  select o.artist_id, o.kind into v_artist_id, v_kind
  from public.integration_outbox o
  where o.id = p_outbox_id;
  if not found then
    raise exception 'outbox route is unavailable' using errcode = '22023';
  end if;

  v_integration_type := case v_kind
    when 'telegram_notification' then 'telegram'::public.artist_integration_type
    when 'transactional_email' then 'email'::public.artist_integration_type
    when 'approved_email' then 'email'::public.artist_integration_type
    when 'calendar_create' then 'calendar'::public.artist_integration_type
    when 'calendar_update' then 'calendar'::public.artist_integration_type
    when 'calendar_cancel' then 'calendar'::public.artist_integration_type
    else null
  end;
  if v_integration_type is null then
    raise exception 'outbox kind has no provider route' using errcode = '22023';
  end if;

  return query
  select o.id, o.artist_id, o.kind, v_integration_type,
         i.provider, i.integration_key, i.external_account_label, i.configuration
  from public.integration_outbox o
  join public.artist_integrations i
    on i.artist_id = o.artist_id
   and i.integration_type = v_integration_type
   and i.is_enabled
  join crm_private.artist_state a
    on a.artist_id = o.artist_id and a.is_active
  where o.id = p_outbox_id;

  if not found then
    raise exception 'artist provider route is unavailable' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_outbox_route(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_outbox_route(uuid) to service_role;

comment on function public.resolve_outbox_route(uuid) is
  'Backend-only safe metadata for one artist-scoped outbox row. Returns no payload, client data or credentials.';
