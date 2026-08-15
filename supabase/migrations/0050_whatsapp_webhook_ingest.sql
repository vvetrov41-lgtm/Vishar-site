-- 0050_whatsapp_webhook_ingest.sql
--
-- Backend-only ingestion for signed Meta WhatsApp webhook notifications.
-- The public webhook Worker authenticates the raw request first, resolves the
-- artist from the signed WABA + phone-number identity, then calls only these
-- narrow RPCs. Browser input can never select the artist, integration or
-- destination through this surface.
--
-- This migration handles the official inbound `messages` and delivery `statuses`
-- contract only. Business App coexistence echo events are deliberately not
-- ingested until a current official Meta contract for those events is proven.
--
-- Forward-only. No provider call, no credential, no route, no deployment.

create or replace function public.record_whatsapp_inbound_message(
  p_artist_id uuid,
  p_integration_key text,
  p_contact_wa_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_message_type text,
  p_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation_id uuid;
  v_message_id uuid;
  v_existing public.whatsapp_messages%rowtype;
  v_body text;
  v_changed boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp webhook ingestion is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_contact_wa_id, '') !~ '^[0-9]{6,20}$' then
    raise exception 'a valid WhatsApp contact id is required' using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;
  if p_provider_timestamp is null or p_provider_timestamp > now() + interval '5 minutes' then
    raise exception 'a valid provider timestamp is required' using errcode = '22023';
  end if;
  if coalesce(p_message_type, '') !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'a safe message type is required' using errcode = '22023';
  end if;

  if p_message_type = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' or char_length(v_body) > 4096 then
      raise exception 'a valid text message body is required' using errcode = '22023';
    end if;
  else
    if p_body is not null then
      raise exception 'non-text webhook messages must not carry body text'
        using errcode = '22023';
    end if;
    v_body := null;
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.provider = 'meta_cloud_api'
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist WhatsApp webhook route is unavailable'
      using errcode = '23503';
  end if;

  insert into public.whatsapp_conversations (
    artist_id,
    integration_key,
    contact_wa_id,
    last_message_at,
    last_inbound_at
  ) values (
    p_artist_id,
    p_integration_key,
    p_contact_wa_id,
    p_provider_timestamp,
    p_provider_timestamp
  )
  on conflict (artist_id, contact_wa_id) do update
  set integration_key = excluded.integration_key,
      last_message_at = greatest(
        coalesce(public.whatsapp_conversations.last_message_at, '-infinity'::timestamptz),
        excluded.last_message_at
      ),
      last_inbound_at = greatest(
        coalesce(public.whatsapp_conversations.last_inbound_at, '-infinity'::timestamptz),
        excluded.last_inbound_at
      ),
      updated_at = now()
  returning id into v_conversation_id;

  insert into public.whatsapp_messages (
    conversation_id,
    artist_id,
    direction,
    origin,
    status,
    message_type,
    body,
    provider_message_id,
    provider_timestamp
  ) values (
    v_conversation_id,
    p_artist_id,
    'inbound'::public.whatsapp_message_direction,
    'contact'::public.whatsapp_message_origin,
    'received'::public.whatsapp_message_status,
    p_message_type,
    v_body,
    p_provider_message_id,
    p_provider_timestamp
  )
  on conflict (artist_id, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    v_changed := true;
  else
    select m.* into v_existing
    from public.whatsapp_messages m
    where m.artist_id = p_artist_id
      and m.provider_message_id = p_provider_message_id;

    if not found
       or v_existing.conversation_id <> v_conversation_id
       or v_existing.direction <> 'inbound'::public.whatsapp_message_direction
       or v_existing.origin <> 'contact'::public.whatsapp_message_origin then
      raise exception 'provider message id conflicts with an existing WhatsApp message'
        using errcode = '23514';
    end if;

    v_message_id := v_existing.id;
  end if;

  return jsonb_build_object(
    'message_id', v_message_id,
    'conversation_id', v_conversation_id,
    'changed', v_changed
  );
end;
$$;

revoke all on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) to service_role;

comment on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) is
  'Backend-only idempotent ingestion of one signed Meta inbound WhatsApp message after server-authoritative artist routing.';

create or replace function public.record_whatsapp_message_status(
  p_artist_id uuid,
  p_integration_key text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_message public.whatsapp_messages%rowtype;
  v_current_rank integer;
  v_incoming_rank integer;
  v_new_status public.whatsapp_message_status;
  v_changed boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp status ingestion is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'unsupported WhatsApp delivery status' using errcode = '22023';
  end if;
  if p_provider_timestamp is null or p_provider_timestamp > now() + interval '5 minutes' then
    raise exception 'a valid provider timestamp is required' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.provider = 'meta_cloud_api'
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist WhatsApp webhook route is unavailable'
      using errcode = '23503';
  end if;

  select m.* into v_message
  from public.whatsapp_messages m
  where m.artist_id = p_artist_id
    and m.provider_message_id = p_provider_message_id
  for update;

  -- A status may legitimately race ahead of the send acknowledgement or refer
  -- to a message created outside this CRM. A missing row is a safe no-op so a
  -- valid Meta webhook does not enter a retry storm.
  if not found then
    return jsonb_build_object('changed', false, 'status', null);
  end if;

  if v_message.direction <> 'outbound'::public.whatsapp_message_direction then
    return jsonb_build_object('changed', false, 'status', v_message.status);
  end if;

  if v_message.provider_timestamp is not null
     and p_provider_timestamp < v_message.provider_timestamp then
    return jsonb_build_object('changed', false, 'status', v_message.status);
  end if;

  v_current_rank := case v_message.status
    when 'queued'::public.whatsapp_message_status then 0
    when 'sent'::public.whatsapp_message_status then 1
    when 'delivered'::public.whatsapp_message_status then 2
    when 'read'::public.whatsapp_message_status then 3
    else -1
  end;
  v_incoming_rank := case p_status
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    else -1
  end;

  if p_status = 'failed' then
    if v_message.status in (
      'delivered'::public.whatsapp_message_status,
      'read'::public.whatsapp_message_status
    ) then
      return jsonb_build_object('changed', false, 'status', v_message.status);
    end if;

    v_new_status := 'failed'::public.whatsapp_message_status;
  else
    if v_message.status <> 'failed'::public.whatsapp_message_status
       and v_current_rank >= v_incoming_rank then
      return jsonb_build_object('changed', false, 'status', v_message.status);
    end if;

    v_new_status := p_status::public.whatsapp_message_status;
  end if;

  update public.whatsapp_messages m
  set status = v_new_status,
      provider_timestamp = p_provider_timestamp,
      delivered_at = case
        when v_new_status in (
          'delivered'::public.whatsapp_message_status,
          'read'::public.whatsapp_message_status
        ) then coalesce(m.delivered_at, p_provider_timestamp)
        else m.delivered_at
      end,
      read_at = case
        when v_new_status = 'read'::public.whatsapp_message_status
          then coalesce(m.read_at, p_provider_timestamp)
        else m.read_at
      end,
      failed_at = case
        when v_new_status = 'failed'::public.whatsapp_message_status
          then p_provider_timestamp
        else null
      end,
      error_code = case
        when v_new_status = 'failed'::public.whatsapp_message_status
          then 'provider_failed'
        else null
      end,
      updated_at = now()
  where m.id = v_message.id;

  v_changed := true;

  return jsonb_build_object(
    'message_id', v_message.id,
    'changed', v_changed,
    'status', v_new_status
  );
end;
$$;

revoke all on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) to service_role;

comment on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) is
  'Backend-only monotonic application of signed Meta sent/delivered/read/failed status notifications. Unknown message ids are safe no-ops.';
