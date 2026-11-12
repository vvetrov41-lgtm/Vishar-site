-- Activate a genuinely Meta-approved Vladimir tattoo cash v3 WhatsApp card.
-- The reviewed Meta URL buttons, consultations, Kristina and existing messages are unchanged.
-- Guarded Worker deployment must precede this SQL activation.

CREATE OR REPLACE FUNCTION crm_private.create_booking_card_whatsapp(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client public.clients%rowtype;
  v_artist public.artists%rowtype;
  v_phone text;
  v_contact_wa_id text;
  v_integration_key text;
  v_integration_count integer;
  v_conversation public.communication_conversations%rowtype;
  v_conversation_id uuid;
  v_message_id uuid;
  v_template_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_body text;
  v_parameters jsonb;
  v_deposit text;
  v_remaining text;
  v_group record;
  v_grouped boolean := false;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('booking-card-whatsapp:' || p_booking_card_id::text, 0)
  );

  select p.communication_message_id
    into v_message_id
  from crm_private.booking_card_whatsapp_payloads p
  where p.booking_card_id = p_booking_card_id;

  if found then
    return v_message_id;
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return null;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id
    and s.whatsapp_enabled;

  if not found then
    return null;
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_card.client_id
    and c.archived_at is null;

  select a.* into v_artist
  from public.artists a
  where a.id = v_card.artist_id
    and a.is_active;

  if v_client.id is null or v_artist.id is null then
    return null;
  end if;

  if crm_private.client_send_block_reason(
    v_card.client_id,
    'whatsapp'::public.message_template_channel,
    'service'::public.message_classification
  ) is not null then
    return null;
  end if;

  v_phone := crm_private.normalize_whatsapp_phone(v_client.phone);
  if v_phone is null or v_phone !~ '^\+[0-9]{6,20}$' then
    return null;
  end if;
  v_contact_wa_id := substring(v_phone from 2);

  select count(*), min(i.integration_key)
    into v_integration_count, v_integration_key
  from public.artist_integrations i
  where i.artist_id = v_card.artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.is_enabled;

  if v_integration_count <> 1 or v_integration_key is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_card.artist_id::text || ':whatsapp:' || v_contact_wa_id, 0)
  );

  select c.* into v_conversation
  from public.communication_conversations c
  where c.artist_id = v_card.artist_id
    and c.channel = 'whatsapp'::public.communication_channel
    and c.external_contact_id = v_contact_wa_id
  for update;

  if found then
    if v_conversation.state <> 'open'::public.communication_conversation_state
       or (v_conversation.client_id is not null
           and v_conversation.client_id <> v_card.client_id) then
      return null;
    end if;

    update public.communication_conversations c
    set client_id = coalesce(c.client_id, v_card.client_id),
        enquiry_id = coalesce(c.enquiry_id, v_card.enquiry_id),
        link_state = 'linked'::public.communication_link_state,
        integration_key = v_integration_key,
        updated_at = now()
    where c.id = v_conversation.id
    returning c.id into v_conversation_id;
  else
    insert into public.communication_conversations (
      artist_id,
      channel,
      integration_key,
      external_contact_id,
      client_id,
      enquiry_id,
      link_state,
      state
    ) values (
      v_card.artist_id,
      'whatsapp'::public.communication_channel,
      v_integration_key,
      v_contact_wa_id,
      v_card.client_id,
      v_card.enquiry_id,
      'linked'::public.communication_link_state,
      'open'::public.communication_conversation_state
    )
    returning id into v_conversation_id;
  end if;

  v_first_name := split_part(btrim(v_client.full_name), ' ', 1);
  if nullif(v_first_name, '') is null then
    return null;
  end if;

  v_date := to_char(
    v_card.start_at at time zone v_card.timezone,
    'FMDay, FMDD FMMonth YYYY'
  );
  v_time := to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  select * into v_group from crm_private.booking_group_card_summary(v_card.id);
  v_grouped := found and v_group.session_count > 1;
  if v_grouped then v_date := v_group.dates_compact; v_time := v_group.times_compact; end if;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_template_name := v_settings.whatsapp_tattoo_template_name;
    v_deposit := crm_private.booking_card_money(case when v_grouped then v_group.total_deposit else v_card.deposit_paid end, v_card.currency);
    v_remaining := crm_private.booking_card_money(case when v_grouped then v_group.total_remaining else v_card.remaining_balance end, v_card.currency);
    -- Reviewed v2 is headerless and has two static URL buttons. Meta
    -- expects exactly six text parameters, without an artist-name parameter.
    v_parameters := case when v_template_name in ('booking_card_tattoo_v2','booking_card_tattoo_cash_v3')
      then jsonb_build_array(v_first_name,v_date,v_time,v_deposit,
                            'Remaining balance on the day',v_remaining)
      else jsonb_build_array(v_first_name,v_artist.display_name,v_date,
                             v_time,v_deposit,v_remaining) end;
    v_body :=
      case when v_grouped then 'Your ' || v_group.session_count || ' tattoo sessions are booked. ' else 'Your tattoo session is booked. ' end
      || 'Deposit paid: ' || v_deposit
      || '. Remaining balance: ' || v_remaining || '.'
      || case when v_template_name='booking_card_tattoo_cash_v3'
           then ' A little note: cash payment is preferred, if that''s convenient for you. Thank you!'
           else '' end;
  elsif v_card.card_kind = 'consultation_booked' then
    v_template_name := case when v_card.appointment_type = 'video_consultation'::public.appointment_type
      then v_settings.whatsapp_video_template_name
      else v_settings.whatsapp_consultation_template_name end;
    if v_card.appointment_type = 'video_consultation'::public.appointment_type
       and v_settings.whatsapp_video_template_status is distinct from 'APPROVED' then
      return null;
    end if;
    v_parameters := case when v_template_name in (
      'booking_card_consultation_v2','booking_card_consultation_v3',
      'booking_card_video_consultation_v2')
      then jsonb_build_array(v_first_name,v_date,v_time)
      else jsonb_build_array(v_first_name,v_artist.display_name,v_date,v_time)
    end;
    v_body := case when v_card.appointment_type = 'video_consultation'::public.appointment_type then 'Your video consultation is booked.' else 'Your consultation is booked.' end;
  else
    return null;
  end if;

  if v_template_name is null or v_template_name not in
    ('booking_card_tattoo_v2','booking_card_tattoo_cash_v3',
     'booking_card_consultation_v2',
     'booking_card_consultation_v3','booking_card_video_consultation_v2') then
    return null; -- fail closed for third-person legacy v1
  end if;
  -- Block only Vladimir's in-person v2, whose static Meta URL leads to
  -- the tattoo-session studio. Correct Gmail booking still goes out.
  if v_card.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
     and v_card.card_kind='consultation_booked'
     and v_card.appointment_type='in_person_consultation'::public.appointment_type
     and v_template_name='booking_card_consultation_v2' then
    return null;
  end if;
  -- A reviewed template must remain Meta-approved for this exact artist
  -- and matching purpose, even if a separate settings poll drifts.
  if v_template_name in (
    'booking_card_tattoo_v2','booking_card_tattoo_cash_v3',
    'booking_card_consultation_v2',
    'booking_card_consultation_v3','booking_card_video_consultation_v2'
  ) and not exists (
    select 1 from crm_private.whatsapp_template_proposals p
    where p.artist_id=v_card.artist_id and p.template_name=v_template_name
      and p.kind=case
        when v_template_name='booking_card_tattoo_v2' then 'booking_tattoo'
        when v_template_name='booking_card_tattoo_cash_v3' then 'booking_tattoo_cash'
        when v_template_name='booking_card_consultation_v2' then 'booking_consultation'
        when v_template_name='booking_card_consultation_v3' then 'booking_consultation_directions'
        else 'booking_video' end
      and p.template_language=v_settings.whatsapp_template_language
      and p.approval_status='APPROVED' and p.provider_template_id is not null
      and p.verified_at>now()-interval '24 hours'
  ) then return null; end if;

  insert into public.communication_messages (
    conversation_id,
    artist_id,
    channel,
    direction,
    origin,
    status,
    message_type,
    body,
    created_by
  ) values (
    v_conversation_id,
    v_card.artist_id,
    'whatsapp'::public.communication_channel,
    'outbound'::public.communication_direction,
    'automation'::public.communication_origin,
    'queued'::public.communication_status,
    'template',
    v_body,
    null
  )
  returning id into v_message_id;

  insert into crm_private.booking_card_whatsapp_payloads (
    booking_card_id,
    communication_message_id,
    template_name,
    template_language,
    body_parameters,
    location_name,
    location_address,
    location_latitude,
    location_longitude,
    confirm_payload,
    reschedule_payload
  ) values (
    v_card.id,
    v_message_id,
    v_template_name,
    v_settings.whatsapp_template_language,
    v_parameters,
    v_settings.studio_name,
    v_settings.studio_address,
    v_settings.location_latitude,
    v_settings.location_longitude,
    'booking_action:' || p_confirm_token,
    'booking_action:' || p_reschedule_token
  );

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now(),
      updated_at = now()
  where c.id = v_conversation_id;

  return v_message_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_whatsapp_booking_card_payload(p_outbox_id uuid, p_worker_id text)
 RETURNS TABLE(is_booking_card boolean, booking_card_id uuid, communication_message_id uuid, artist_id uuid, template_name text, template_language text, body_parameters jsonb, location_name text, location_address text, location_latitude numeric, location_longitude numeric, confirm_payload text, reschedule_payload text, delivery_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp booking card resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null
     or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'valid WhatsApp lease identity is required'
      using errcode = '22023';
  end if;

  return query
  select
    m.message_type = 'template' as is_booking_card,
    p.booking_card_id,
    m.id,
    o.artist_id,
    p.template_name,
    p.template_language,
    p.body_parameters,
    p.location_name,
    p.location_address,
    p.location_latitude,
    p.location_longitude,
    p.confirm_payload,
    p.reschedule_payload,
    case
      when m.message_type <> 'template' then true
      else (
        p.booking_card_id is not null
        and b.superseded_at is null
        and crm_private.booking_group_card_valid(b.id)
        and b.artist_id = o.artist_id
        and b.client_id is not distinct from o.client_id
        and s.status = 'confirmed'::public.session_status
        and s.calendar_version = b.calendar_version
        and s.start_at > now()
        and not (b.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
          and b.card_kind='consultation_booked'
          and b.appointment_type='in_person_consultation'::public.appointment_type
          and p.template_name='booking_card_consultation_v2')
        and m.status = 'queued'::public.communication_status
        and p.template_name in
          ('booking_card_tattoo_v2','booking_card_tattoo_cash_v3',
           'booking_card_consultation_v2',
           'booking_card_consultation_v3','booking_card_video_consultation_v2')
        and (p.template_name<>'booking_card_tattoo_cash_v3'
          or exists (select 1 from crm_private.whatsapp_template_proposals proposal
             where proposal.artist_id=b.artist_id
               and proposal.kind='booking_tattoo_cash'
               and proposal.template_name=p.template_name
               and proposal.template_language=p.template_language
               and proposal.approval_status='APPROVED'
               and proposal.provider_template_id ~ '^[0-9]{5,32}$'
               and proposal.verified_at>now()-interval '24 hours'))
        and settings.whatsapp_enabled
        and settings.whatsapp_template_language = p.template_language
        and (
          (b.card_kind = 'tattoo_deposit_paid'
            and settings.whatsapp_tattoo_template_name = p.template_name)
          or
          (b.card_kind = 'consultation_booked'
            and b.appointment_type = 'in_person_consultation'::public.appointment_type
            and settings.whatsapp_consultation_template_name = p.template_name)
          or
          (b.card_kind = 'consultation_booked'
            and b.appointment_type = 'video_consultation'::public.appointment_type
            and settings.whatsapp_video_template_name = p.template_name
            and settings.whatsapp_video_template_status = 'APPROVED')
        )
      )
    end as delivery_allowed
  from public.integration_outbox o
  join public.communication_messages m
    on m.id = o.communication_message_id
  left join crm_private.booking_card_whatsapp_payloads p
    on p.communication_message_id = m.id
  left join crm_private.booking_cards b
    on b.id = p.booking_card_id
  left join public.sessions s
    on s.id = b.session_id
  left join crm_private.booking_card_artist_settings settings
    on settings.artist_id = b.artist_id
  where o.id = p_outbox_id
    and o.kind = 'whatsapp_message'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status
    and o.leased_by = p_worker_id
    and o.lease_expires_at > now()
    and m.artist_id = o.artist_id
    and m.channel = 'whatsapp'::public.communication_channel;
end;
$function$;

-- The new Meta template is immutable, and its approval was recorded by
-- a readback that verified the body and both original URL buttons.
-- Do not change the active routing unless the actual production account
-- has fresh approval and no in-flight old WhatsApp messages.
CREATE OR REPLACE FUNCTION crm_private.activate_vladimir_cash_booking_whatsapp()
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $activation$
DECLARE
 v_artist constant uuid := 'a1111111-1111-4111-8111-111111111111';
 v_current text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.artists a WHERE a.id=v_artist AND a.slug='vladimir') THEN
   RAISE EXCEPTION 'Unexpected artist scope' USING errcode='42501';
 END IF;
 LOCK TABLE crm_private.booking_card_artist_settings,
   crm_private.whatsapp_template_proposals,
   public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;
 SELECT s.whatsapp_tattoo_template_name INTO STRICT v_current
 FROM crm_private.booking_card_artist_settings s
 WHERE s.artist_id=v_artist AND s.whatsapp_enabled
   AND s.whatsapp_template_language='en_GB'
   AND s.whatsapp_tattoo_template_status='APPROVED';
 IF v_current='booking_card_tattoo_cash_v3' THEN
   RETURN 'already_active';
 END IF;
 IF v_current<>'booking_card_tattoo_v2' THEN
   RAISE EXCEPTION 'Active tattoo WhatsApp identity drifted' USING errcode='23514';
 END IF;
 IF (SELECT count(*) FROM crm_private.whatsapp_template_proposals p
     WHERE p.artist_id=v_artist AND p.kind='booking_tattoo_cash'
       AND p.template_name='booking_card_tattoo_cash_v3'
       AND p.template_language='en_GB'
       AND p.approval_status='APPROVED'
       AND p.provider_template_id~'^[0-9]{5,32}$'
       AND p.verified_at>now()-interval '24 hours')<>1 THEN
   RAISE EXCEPTION 'Fresh Meta cash-template approval is required' USING errcode='23514';
 END IF;
 IF EXISTS (
   SELECT 1 FROM public.integration_outbox o WHERE o.artist_id=v_artist
     AND o.kind='whatsapp_message' AND o.status IN ('pending','leased')
 ) THEN
   RAISE EXCEPTION 'Existing WhatsApp messages must finish before template promotion'
     USING errcode='23514';
 END IF;
 IF EXISTS (
   SELECT 1 FROM crm_private.whatsapp_template_proposals p
   WHERE p.artist_id='a2222222-2222-4222-8222-222222222222'
     AND p.kind='booking_tattoo_cash'
 ) THEN
   RAISE EXCEPTION 'Unexpected Kristina cash-template proposal' USING errcode='23514';
 END IF;
 UPDATE crm_private.booking_card_artist_settings s
 SET whatsapp_tattoo_template_name='booking_card_tattoo_cash_v3',
     whatsapp_tattoo_template_status='APPROVED',
     whatsapp_template_checked_at=now(),updated_at=now()
 WHERE s.artist_id=v_artist AND s.whatsapp_tattoo_template_name='booking_card_tattoo_v2'
   AND s.whatsapp_tattoo_template_status='APPROVED';
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Booking template promotion lost race' USING errcode='23514';
 END IF;
 RETURN 'activated';
END;
$activation$;

REVOKE ALL ON FUNCTION crm_private.activate_vladimir_cash_booking_whatsapp()
 FROM PUBLIC,anon,authenticated,service_role;

DO $activate$
DECLARE
 result text;
BEGIN
 -- Clean CI has no actual bookings or Meta approval and cannot fabricate either.
 IF NOT EXISTS (SELECT 1 FROM public.sessions s
   WHERE s.artist_id='a1111111-1111-4111-8111-111111111111'::uuid) THEN
   RETURN;
 END IF;
 result:=crm_private.activate_vladimir_cash_booking_whatsapp();
 IF result<>'activated' THEN
   RAISE EXCEPTION 'Expected fresh cash-template promotion, got %',result;
 END IF;
END;
$activate$;
