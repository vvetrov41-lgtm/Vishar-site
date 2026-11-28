-- Record first outbound WhatsApp Business app messages for unique, existing, artist-scoped clients.
-- Preserve unknown-contact privacy, the inbound-only customer service window, and provider deduplication.
CREATE OR REPLACE FUNCTION public.record_communication_outbound_echo(p_artist_id uuid, p_channel text, p_integration_key text, p_external_contact_id text, p_provider_message_id text, p_provider_timestamp timestamp with time zone, p_message_type text, p_body text DEFAULT NULL::text, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_channel public.communication_channel;
  v_conversation_id uuid;
  v_client_id uuid;
  v_created_client_id uuid;
  v_message_id uuid;
  v_body text;
  v_attachments jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication echo ingestion is backend-only'
      using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;
  v_channel := p_channel::public.communication_channel;

  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
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
      raise exception 'non-text echoes must not carry body text' using errcode = '22023';
    end if;
    v_body := null;
  end if;

  v_attachments := coalesce(p_attachments, '[]'::jsonb);
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 16 then
    raise exception 'attachment metadata is not in the expected form' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = crm_private.communication_integration_type(v_channel)
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist webhook route is unavailable' using errcode = '23503';
  end if;

  select c.id into v_conversation_id
  from public.communication_conversations c
  where c.artist_id = p_artist_id
    and c.channel = v_channel
    and c.external_contact_id = p_external_contact_id;
  if not found then
    -- A first outbound WhatsApp message may be the artist's reply to an
    -- existing enquiry. Never create a conversation for a personal/unknown
    -- number, an ambiguous match, an out-of-scope client, or Instagram.
    if v_channel <> 'whatsapp'::public.communication_channel
       or coalesce(p_external_contact_id, '') !~ '^[1-9][0-9]{6,14}

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, attachments, provider_message_id, provider_timestamp,
    sent_at
  ) values (
    v_conversation_id,
    p_artist_id,
    v_channel,
    'outbound'::public.communication_direction,
    'provider_app'::public.communication_origin,
    'sent'::public.communication_status,
    p_message_type,
    v_body,
    v_attachments,
    p_provider_message_id,
    p_provider_timestamp,
    p_provider_timestamp
  )
  on conflict (artist_id, channel, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    return jsonb_build_object('changed', false, 'message_id', null);
  end if;

  update public.communication_conversations c
  set last_message_at = greatest(
        coalesce(c.last_message_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      last_outbound_at = greatest(
        coalesce(c.last_outbound_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      updated_at = now()
  where c.id = v_conversation_id;

  return jsonb_build_object('changed', true, 'message_id', v_message_id);
end;
$function$
 then
      return jsonb_build_object('changed', false, 'message_id', null);
    end if;
    v_client_id := crm_private.unique_whatsapp_client_match(p_artist_id, p_external_contact_id);
    if v_client_id is null then
      return jsonb_build_object('changed', false, 'message_id', null);
    end if;
    -- An already-recorded provider id must not create an empty conversation.
    if exists (
      select 1 from public.communication_messages m
      where m.artist_id = p_artist_id and m.channel = v_channel
        and m.provider_message_id = p_provider_message_id
    ) then
      return jsonb_build_object('changed', false, 'message_id', null);
    end if;

    -- The existing BEFORE INSERT trigger resolves the client and enquiry
    -- using the same unique artist-scoped phone match as inbound messages.
    -- Deliberately leave last_inbound_at NULL: an outbound echo does not
    -- open the WhatsApp 24-hour customer-service window.
    insert into public.communication_conversations (
      artist_id, channel, integration_key, external_contact_id,
      last_message_at, last_outbound_at
    ) values (
      p_artist_id, v_channel, p_integration_key, p_external_contact_id,
      p_provider_timestamp, p_provider_timestamp
    )
    on conflict (artist_id, channel, external_contact_id) do nothing
    returning id, client_id into v_conversation_id, v_created_client_id;
    if found then
      if v_created_client_id is distinct from v_client_id then
        raise exception 'WhatsApp client match changed during echo ingestion'
          using errcode = '40001';
      end if;
    else
      -- A concurrent inbound message or echo already opened the conversation.
      select c.id into v_conversation_id
      from public.communication_conversations c
      where c.artist_id = p_artist_id and c.channel = v_channel
        and c.external_contact_id = p_external_contact_id;
      if not found then
        raise exception 'WhatsApp conversation changed during echo ingestion'
          using errcode = '40001';
      end if;
    end if;
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, attachments, provider_message_id, provider_timestamp,
    sent_at
  ) values (
    v_conversation_id,
    p_artist_id,
    v_channel,
    'outbound'::public.communication_direction,
    'provider_app'::public.communication_origin,
    'sent'::public.communication_status,
    p_message_type,
    v_body,
    v_attachments,
    p_provider_message_id,
    p_provider_timestamp,
    p_provider_timestamp
  )
  on conflict (artist_id, channel, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    return jsonb_build_object('changed', false, 'message_id', null);
  end if;

  update public.communication_conversations c
  set last_message_at = greatest(
        coalesce(c.last_message_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      last_outbound_at = greatest(
        coalesce(c.last_outbound_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      updated_at = now()
  where c.id = v_conversation_id;

  return jsonb_build_object('changed', true, 'message_id', v_message_id);
end;
$function$;
