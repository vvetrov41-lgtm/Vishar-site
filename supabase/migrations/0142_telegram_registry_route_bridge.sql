create or replace function public.resolve_outbox_route(p_outbox_id uuid)
returns table(
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
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
declare
  v_artist_id uuid;
  v_kind public.outbox_kind;
  v_integration_type public.artist_integration_type;
begin
  if not crm_private.is_service_backend() then
    raise exception 'outbox route resolution is backend-only' using errcode = '42501';
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
    when 'calendar_availability_create' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_update' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_cancel' then 'calendar'::public.artist_integration_type
    when 'whatsapp_message' then 'whatsapp'::public.artist_integration_type
    when 'instagram_message' then 'instagram'::public.artist_integration_type
    else null
  end;
  if v_integration_type is null then
    raise exception 'outbox kind has no provider route' using errcode = '22023';
  end if;

  -- Production Telegram delivery is registry-first. Return a compatibility route
  -- when the artist has an active secure destination even if the historical
  -- artist_integrations Telegram binding is absent. The Worker resolves the
  -- actual destination again through service_resolve_telegram_destination and
  -- does not consume this placeholder configuration.
  if v_integration_type = 'telegram'::public.artist_integration_type then
    return query
    select o.id, o.artist_id, o.kind, v_integration_type,
           'telegram'::text, 'shared-registry'::text,
           'Shared Telegram registry'::text, '{}'::jsonb
    from public.integration_outbox o
    join crm_private.artist_state a
      on a.artist_id = o.artist_id and a.is_active
    where o.id = p_outbox_id
      and exists (
        select 1
        from crm_private.telegram_destinations d
        where d.artist_id = o.artist_id
          and d.destination_kind = 'artist'
          and d.is_active
      );

    if found then
      return;
    end if;
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
$function$;
