-- 0051_whatsapp_crm_conversation.sql
--
-- Authenticated CRM entry point for opening the WhatsApp conversation attached
-- to one enquiry. The browser supplies only the enquiry id. Artist, client,
-- destination phone and integration key are resolved from durable CRM state.
--
-- Forward-only. No provider call and no external activation.

create or replace function public.ensure_whatsapp_conversation_for_enquiry(
  p_enquiry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_client public.clients%rowtype;
  v_phone_normalized text;
  v_contact_wa_id text;
  v_integration_key text;
  v_integration_count integer;
  v_existing public.whatsapp_conversations%rowtype;
  v_conversation_id uuid;
  v_created boolean := false;
begin
  if p_enquiry_id is null then
    raise exception 'an enquiry id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_enquiry.client_id is null then
    raise exception 'enquiry is not linked to a client' using errcode = '23503';
  end if;
  if v_enquiry.client_identifier_conflict then
    raise exception 'client identifier conflict must be resolved before WhatsApp messaging'
      using errcode = '23514';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_enquiry.client_id
    and c.archived_at is null;
  if not found then
    raise exception 'active client was not found' using errcode = '23503';
  end if;

  -- Reuse the repository's deliberately conservative normaliser. Local-format
  -- numbers fail closed instead of guessing a country code.
  v_phone_normalized := public.normalize_phone(v_client.phone);
  if v_phone_normalized is null then
    raise exception 'client phone must already be an international number for WhatsApp messaging'
      using errcode = '22023';
  end if;
  v_contact_wa_id := substr(v_phone_normalized, 2);

  select count(*), min(i.integration_key)
  into v_integration_count, v_integration_key
  from public.artist_integrations i
  where i.artist_id = v_enquiry.artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.is_enabled;

  if v_integration_count <> 1 or v_integration_key is null then
    raise exception 'artist must have exactly one enabled Meta WhatsApp integration'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_enquiry.artist_id::text || ':whatsapp:' || v_contact_wa_id, 0)
  );

  select c.* into v_existing
  from public.whatsapp_conversations c
  where c.artist_id = v_enquiry.artist_id
    and c.contact_wa_id = v_contact_wa_id
  for update;

  if found then
    if v_existing.client_id is not null and v_existing.client_id <> v_enquiry.client_id then
      raise exception 'WhatsApp destination is already linked to a different client in this artist scope'
        using errcode = '23514';
    end if;

    update public.whatsapp_conversations c
    set client_id = coalesce(c.client_id, v_enquiry.client_id),
        integration_key = v_integration_key,
        updated_at = now()
    where c.id = v_existing.id
    returning c.id into v_conversation_id;
  else
    insert into public.whatsapp_conversations (
      artist_id, client_id, integration_key, contact_wa_id
    ) values (
      v_enquiry.artist_id,
      v_enquiry.client_id,
      v_integration_key,
      v_contact_wa_id
    )
    returning id into v_conversation_id;
    v_created := true;
  end if;

  if v_created then
    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'whatsapp.conversation_created',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      v_enquiry.client_id,
      v_enquiry.id,
      null, null, null,
      jsonb_build_object(
        'conversation', v_conversation_id,
        'integration', v_integration_key
      )
    );
  end if;

  return jsonb_build_object(
    'conversation_id', v_conversation_id,
    'artist_id', v_enquiry.artist_id,
    'client_id', v_enquiry.client_id,
    'contact_wa_id', v_contact_wa_id,
    'integration_key', v_integration_key,
    'created', v_created
  );
end;
$$;

revoke all on function public.ensure_whatsapp_conversation_for_enquiry(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_whatsapp_conversation_for_enquiry(uuid)
  to authenticated;

comment on function public.ensure_whatsapp_conversation_for_enquiry(uuid) is
  'Artist-scoped CRM conversation opener. Caller supplies only enquiry id; artist, client, destination and enabled Meta integration are derived from durable CRM state.';
