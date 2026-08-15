-- 0049_whatsapp_inbound_ingestion.sql
--
-- Backend-only ingestion for Meta webhook deliveries.
--
-- Artist resolution is server-authoritative and starts from the non-secret
-- `integration_key`, which the Worker derives from the encrypted binding whose
-- Meta phone number id matched the payload. Nothing in the webhook body can
-- select an artist: a body naming an unknown phone number never reaches these
-- functions at all, and a body naming a disabled integration is refused here.
--
-- Every entry point is idempotent on `(artist_id, provider_message_id)`, which
-- is the deduplication boundary for Meta's at-least-once webhook delivery and,
-- importantly, for coexistence echoes of messages this CRM itself sent.
--
-- Forward-only. No provider call, no credential, no cron, no deployment.

-- ---------------------------------------------------------------------------
-- Shared resolution
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_whatsapp_conversation(
  p_integration_key text,
  p_contact_wa_id text,
  p_contact_label text
)
returns public.whatsapp_conversations
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_conversation public.whatsapp_conversations%rowtype;
  v_label text;
begin
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a valid integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_contact_wa_id, '') !~ '^[0-9]{6,20}$' then
    raise exception 'a valid WhatsApp contact id is required' using errcode = '22023';
  end if;

  -- The artist comes from the enabled integration, never from the payload.
  select i.artist_id into v_artist_id
  from public.artist_integrations i
  join crm_private.artist_state a on a.artist_id = i.artist_id and a.is_active
  where i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.integration_key = p_integration_key
    and i.is_enabled;
  if not found then
    raise exception 'no enabled WhatsApp integration matches this key'
      using errcode = '23503';
  end if;

  v_label := nullif(btrim(coalesce(p_contact_label, '')), '');
  if v_label is not null then
    v_label := left(v_label, 160);
  end if;

  select c.* into v_conversation
  from public.whatsapp_conversations c
  where c.artist_id = v_artist_id
    and c.contact_wa_id = p_contact_wa_id;

  if not found then
    insert into public.whatsapp_conversations (
      artist_id, integration_key, contact_wa_id, contact_label
    ) values (
      v_artist_id, p_integration_key, p_contact_wa_id, v_label
    )
    returning * into v_conversation;
  elsif v_label is not null and v_conversation.contact_label is distinct from v_label then
    update public.whatsapp_conversations c
    set contact_label = v_label
    where c.id = v_conversation.id
    returning * into v_conversation;
  end if;

  return v_conversation;
end;
$$;

revoke all on function crm_private.resolve_whatsapp_conversation(text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Inbound message from the WhatsApp user
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_inbound_message(
  p_integration_key text,
  p_contact_wa_id text,
  p_provider_message_id text,
  p_message_type text,
  p_body text,
  p_provider_timestamp timestamptz,
  p_contact_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.whatsapp_conversations%rowtype;
  v_message_id uuid;
  v_existing uuid;
  v_type text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp ingestion is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;

  v_type := coalesce(nullif(btrim(coalesce(p_message_type, '')), ''), 'text');
  if v_type !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'the message type is not in the expected form' using errcode = '22023';
  end if;

  v_conversation := crm_private.resolve_whatsapp_conversation(
    p_integration_key, p_contact_wa_id, p_contact_label
  );

  -- Meta delivers webhooks at least once, so a repeat is normal traffic.
  select m.id into v_existing
  from public.whatsapp_messages m
  where m.artist_id = v_conversation.artist_id
    and m.provider_message_id = p_provider_message_id;
  if found then
    return jsonb_build_object(
      'conversation_id', v_conversation.id,
      'message_id', v_existing,
      'replayed', true
    );
  end if;

  insert into public.whatsapp_messages (
    conversation_id, artist_id, direction, origin, status,
    message_type, body, provider_message_id, provider_timestamp
  ) values (
    v_conversation.id,
    v_conversation.artist_id,
    'inbound'::public.whatsapp_message_direction,
    'contact'::public.whatsapp_message_origin,
    'received'::public.whatsapp_message_status,
    v_type,
    left(coalesce(p_body, ''), 4096),
    p_provider_message_id,
    coalesce(p_provider_timestamp, now())
  )
  returning id into v_message_id;

  update public.whatsapp_conversations c
  set last_message_at = greatest(coalesce(c.last_message_at, to_timestamp(0)),
                                 coalesce(p_provider_timestamp, now())),
      last_inbound_at = greatest(coalesce(c.last_inbound_at, to_timestamp(0)),
                                 coalesce(p_provider_timestamp, now()))
  where c.id = v_conversation.id;

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'message_id', v_message_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.record_whatsapp_inbound_message(text, text, text, text, text, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_inbound_message(text, text, text, text, text, timestamptz, text)
  to service_role;

comment on function public.record_whatsapp_inbound_message(text, text, text, text, text, timestamptz, text) is
  'Backend-only idempotent ingestion of one inbound WhatsApp message. The artist is resolved from the enabled integration key, never from the webhook body.';

-- ---------------------------------------------------------------------------
-- Coexistence echo: a message the artist sent from the WhatsApp Business App
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_echo_message(
  p_integration_key text,
  p_contact_wa_id text,
  p_provider_message_id text,
  p_message_type text,
  p_body text,
  p_provider_timestamp timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.whatsapp_conversations%rowtype;
  v_message_id uuid;
  v_existing public.whatsapp_messages%rowtype;
  v_type text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp ingestion is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;

  v_type := coalesce(nullif(btrim(coalesce(p_message_type, '')), ''), 'text');
  if v_type !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'the message type is not in the expected form' using errcode = '22023';
  end if;

  v_conversation := crm_private.resolve_whatsapp_conversation(
    p_integration_key, p_contact_wa_id, null
  );

  -- The decisive coexistence case: Meta echoes messages this CRM sent through
  -- the Cloud API as well as messages typed in the Business App. If the wamid
  -- already belongs to a CRM-sent row, this is that echo and must not become a
  -- second message in the timeline.
  select m.* into v_existing
  from public.whatsapp_messages m
  where m.artist_id = v_conversation.artist_id
    and m.provider_message_id = p_provider_message_id;
  if found then
    return jsonb_build_object(
      'conversation_id', v_conversation.id,
      'message_id', v_existing.id,
      'origin', v_existing.origin,
      'replayed', true
    );
  end if;

  insert into public.whatsapp_messages (
    conversation_id, artist_id, direction, origin, status,
    message_type, body, provider_message_id, provider_timestamp
  ) values (
    v_conversation.id,
    v_conversation.artist_id,
    'outbound'::public.whatsapp_message_direction,
    'business_app'::public.whatsapp_message_origin,
    'sent'::public.whatsapp_message_status,
    v_type,
    left(coalesce(p_body, ''), 4096),
    p_provider_message_id,
    coalesce(p_provider_timestamp, now())
  )
  returning id into v_message_id;

  update public.whatsapp_conversations c
  set last_message_at = greatest(coalesce(c.last_message_at, to_timestamp(0)),
                                 coalesce(p_provider_timestamp, now()))
  where c.id = v_conversation.id;

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'message_id', v_message_id,
    'origin', 'business_app',
    'replayed', false
  );
end;
$$;

revoke all on function public.record_whatsapp_echo_message(text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_echo_message(text, text, text, text, text, timestamptz)
  to service_role;

comment on function public.record_whatsapp_echo_message(text, text, text, text, text, timestamptz) is
  'Backend-only ingestion of a Meta coexistence echo. An echo of a CRM-sent message deduplicates against the original row instead of duplicating the timeline.';

-- ---------------------------------------------------------------------------
-- Delivery status callback
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_status_update(
  p_integration_key text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_message public.whatsapp_messages%rowtype;
  v_status public.whatsapp_message_status;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp ingestion is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a valid integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;
  if coalesce(p_status, '') not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'unknown WhatsApp delivery status' using errcode = '22023';
  end if;
  if p_status = 'failed'
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'a failed status requires a safe machine error code'
      using errcode = '22023';
  end if;

  select i.artist_id into v_artist_id
  from public.artist_integrations i
  where i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.integration_key = p_integration_key
    and i.is_enabled;
  if not found then
    raise exception 'no enabled WhatsApp integration matches this key'
      using errcode = '23503';
  end if;

  select m.* into v_message
  from public.whatsapp_messages m
  where m.artist_id = v_artist_id
    and m.provider_message_id = p_provider_message_id;
  if not found then
    -- A status for a message this CRM has never seen is not an error: it may
    -- belong to a Business App message whose echo has not arrived yet.
    return jsonb_build_object('matched', false, 'changed', false);
  end if;

  v_status := p_status::public.whatsapp_message_status;

  -- Meta status callbacks can arrive out of order, so the lifecycle only ever
  -- moves forward. A late `sent` must not undo an already-recorded `read`.
  if v_message.status = 'failed'::public.whatsapp_message_status
     or (v_status <> 'failed'::public.whatsapp_message_status
         and array_position(array['queued', 'sent', 'delivered', 'read'], v_status::text)
             <= array_position(array['queued', 'sent', 'delivered', 'read'], v_message.status::text)) then
    return jsonb_build_object(
      'matched', true,
      'changed', false,
      'message_id', v_message.id
    );
  end if;

  update public.whatsapp_messages m
  set status = v_status,
      delivered_at = case
        when v_status in ('delivered'::public.whatsapp_message_status,
                          'read'::public.whatsapp_message_status)
        then coalesce(m.delivered_at, coalesce(p_provider_timestamp, now()))
        else m.delivered_at end,
      read_at = case
        when v_status = 'read'::public.whatsapp_message_status
        then coalesce(m.read_at, coalesce(p_provider_timestamp, now()))
        else m.read_at end,
      failed_at = case
        when v_status = 'failed'::public.whatsapp_message_status
        then coalesce(p_provider_timestamp, now())
        else m.failed_at end,
      error_code = case
        when v_status = 'failed'::public.whatsapp_message_status
        then p_error_code
        else m.error_code end,
      updated_at = now()
  where m.id = v_message.id;

  return jsonb_build_object(
    'matched', true,
    'changed', true,
    'message_id', v_message.id,
    'status', v_status
  );
end;
$$;

revoke all on function public.record_whatsapp_status_update(text, text, text, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_status_update(text, text, text, timestamptz, text)
  to service_role;

comment on function public.record_whatsapp_status_update(text, text, text, timestamptz, text) is
  'Backend-only monotonic WhatsApp delivery status update. Out-of-order Meta callbacks never move a message backwards.';
