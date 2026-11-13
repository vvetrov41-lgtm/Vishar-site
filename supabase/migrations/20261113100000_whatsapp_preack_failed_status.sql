-- Audit 13 November 2026: Meta's signed failed delivery event can arrive
-- before the CRM's provider message id is acknowledged. Preserve only
-- the opaque id, artist, timestamp and terminal machine status until that
-- acknowledgement transaction, without copying Meta error details or PII.
-- Provider reconciliation remains idempotent and single-artist scoped.

create table if not exists crm_private.whatsapp_preack_failed_status (
  artist_id uuid not null,
  provider_message_id text not null,
  provider_timestamp timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (artist_id, provider_message_id),
  constraint whatsapp_preack_failed_id_shape
    check (provider_message_id ~ '^[A-Za-z0-9_=./-]{8,255}$')
);

create index if not exists whatsapp_preack_failed_received_idx
  on crm_private.whatsapp_preack_failed_status (received_at);

revoke all on table crm_private.whatsapp_preack_failed_status from public, anon, authenticated;
-- Only the SECURITY DEFINER functions below access this private buffer.

create or replace function public.record_whatsapp_message_status(
  p_artist_id uuid,
  p_integration_key text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_result jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp status ingestion is backend-only' using errcode = '42501';
  end if;

  -- Serialize the signed status and its later send acknowledgement by one
  -- artist/provider ID, independent of network event arrival order.
  if p_artist_id is not null and p_provider_message_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_artist_id::text || ':' || p_provider_message_id, 0)
    );
  end if;

  v_result := public.record_communication_message_status(
    p_artist_id, 'whatsapp', p_integration_key,
    p_provider_message_id, p_status, p_provider_timestamp
  );

  if p_status = 'failed' and v_result ->> 'status' is null then
    -- A signed status may refer to a message sent from the business app.
    -- Buffer only if a recent CRM outbox has a durable send intent.
    if exists (
      select 1
      from public.integration_outbox o
      where o.artist_id = p_artist_id
        and o.kind = 'whatsapp_message'::public.outbox_kind
        and o.provider_send_started_at >= now() - interval '15 minutes'
    ) then
      insert into crm_private.whatsapp_preack_failed_status(
        artist_id, provider_message_id, provider_timestamp
      ) values (
        p_artist_id, p_provider_message_id, p_provider_timestamp
      )
      on conflict (artist_id, provider_message_id) do update
        set provider_timestamp = greatest(
          crm_private.whatsapp_preack_failed_status.provider_timestamp,
          excluded.provider_timestamp
        ),
        received_at = now();

      -- Keep retention bounded without adding another account-level cron.
      delete from crm_private.whatsapp_preack_failed_status t
      where (t.artist_id, t.provider_message_id) in (
        select old.artist_id, old.provider_message_id
        from crm_private.whatsapp_preack_failed_status old
        where old.received_at < now() - interval '48 hours'
        order by old.received_at
        limit 100
      );
      return v_result || jsonb_build_object('buffered', true);
    end if;
  end if;
  return v_result;
end;
$function$;

create or replace function public.record_whatsapp_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_artist_id uuid;
  v_message_id uuid;
  v_status_time timestamptz;
  v_result jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox acknowledgement is backend-only' using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;
  select o.artist_id into v_artist_id
  from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'whatsapp_message'::public.outbox_kind;
  if not found then
    raise exception 'WhatsApp outbox job is unavailable' using errcode = '22023';
  end if;

  if p_succeeded and p_provider_message_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_artist_id::text || ':' || p_provider_message_id, 0)
    );
  end if;

  -- This is the existing lease-aware, send-intent-aware, idempotent function.
  v_result := public.record_communication_outbox_result(
    p_outbox_id, p_worker_id, p_succeeded, p_provider_message_id, p_error_code
  );

  if p_succeeded and v_result ->> 'status' = 'succeeded' then
    delete from crm_private.whatsapp_preack_failed_status b
    where b.artist_id = v_artist_id
      and b.provider_message_id = p_provider_message_id
    returning b.provider_timestamp into v_status_time;

    if found then
      select m.id into v_message_id
      from public.communication_messages m
      where m.artist_id = v_artist_id
        and m.channel = 'whatsapp'::public.communication_channel
        and m.provider_message_id = p_provider_message_id;
      if found then
        perform crm_private.apply_communication_status(
          v_message_id, 'failed'::public.communication_status,
          v_status_time, 'provider_failed'
        );
      end if;
    end if;
  end if;
  return v_result;
end;
$function$;

revoke all on function public.record_whatsapp_message_status(
  uuid,text,text,text,timestamptz
) from public,anon,authenticated;
revoke all on function public.record_whatsapp_outbox_result(
  uuid,text,boolean,text,text
) from public,anon,authenticated;
grant execute on function public.record_whatsapp_message_status(
  uuid,text,text,text,timestamptz
) to service_role;
grant execute on function public.record_whatsapp_outbox_result(
  uuid,text,boolean,text,text
) to service_role;
