-- Three-channel multi-session summary. Existing approved WhatsApp template remains in use;
-- its date/time and finance variables contain a concise group summary.
CREATE OR REPLACE FUNCTION crm_private.render_booking_card_email(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text)
 RETURNS TABLE(subject text, body text, html_body text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client_name text;
  v_artist_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_confirm_url text;
  v_reschedule_url text;
  v_deposit text;
  v_remaining text;
  v_title text;
  v_finance_text text := '';
  v_finance_html text := '';
  v_group record;
  v_grouped boolean := false;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return;
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id
    and s.email_enabled;

  if not found then
    return;
  end if;

  select c.full_name, a.display_name
    into v_client_name, v_artist_name
  from public.clients c
  join public.artists a on a.id = v_card.artist_id
  where c.id = v_card.client_id
    and c.archived_at is null;

  if not found
     or nullif(btrim(v_client_name), '') is null
     or nullif(btrim(v_artist_name), '') is null then
    return;
  end if;

  v_first_name := split_part(btrim(v_client_name), ' ', 1);
  v_date := to_char(v_card.start_at at time zone v_card.timezone, 'FMDay, FMDD FMMonth YYYY');
  v_time := to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  select * into v_group from crm_private.booking_group_card_summary(v_card.id);
  v_grouped := found and v_group.session_count > 1;
  if v_grouped then v_date := v_group.dates_text; v_time := ''; end if;
  if v_settings.client_action_base_url is null then
    return;
  end if;
  v_confirm_url := v_settings.client_action_base_url || p_confirm_token;
  v_reschedule_url := v_settings.client_action_base_url || p_reschedule_token;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_title := case when v_grouped then 'Your tattoo sessions are booked' else 'Your tattoo session is booked' end;
    subject := v_title || ' with ' || v_artist_name;
    v_deposit := crm_private.booking_card_money(case when v_grouped then v_group.total_deposit else v_card.deposit_paid end, v_card.currency);
    v_remaining := crm_private.booking_card_money(case when v_grouped then v_group.total_remaining else v_card.remaining_balance end, v_card.currency);
    v_finance_text := E'\nDeposit paid: ' || v_deposit
      || E'\nRemaining balance: ' || v_remaining;
    v_finance_html :=
      '<div style="margin:20px 0;padding:16px;border-radius:12px;background:#f6f6f6;">'
      || '<div style="margin-bottom:8px;"><strong>Deposit paid:</strong> '
      || crm_private.booking_card_html_escape(v_deposit) || '</div>'
      || '<div><strong>Remaining balance:</strong> '
      || crm_private.booking_card_html_escape(v_remaining) || '</div>'
      || '</div>';
  elsif v_card.card_kind = 'consultation_booked' then
    v_title := 'Your consultation is booked';
    subject := 'Your consultation is booked with ' || v_artist_name;
  else
    return;
  end if;

  body :=
    'Hi ' || v_first_name || E',\n\n'
    || v_title || E'.\n\n'
    || 'Artist: ' || v_artist_name || E'\n'
    || 'When: ' || v_date || case when v_grouped then '' else ' at ' || v_time end
    || v_finance_text || E'\n\n'
    || v_settings.studio_name || E'\n'
    || v_settings.studio_address || E'\n'
    || v_settings.studio_map_url || E'\n\n'
    || case when v_grouped then E'Please confirm all sessions.\n\n' else E'Please confirm so I know to expect you.\n\n' end
    || case when v_grouped then E'Confirm all sessions:\n' else E'I\'ll be there:\n' end || v_confirm_url || E'\n\n'
    || E'Need another time:\n' || v_reschedule_url;

  html_body :=
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;'
    || 'font-family:Arial,Helvetica,sans-serif;color:#111;">'
    || '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:18px;'
    || 'padding:28px;box-sizing:border-box;">'
    || '<p style="margin:0 0 20px;">Hi '
    || crm_private.booking_card_html_escape(v_first_name) || ',</p>'
    || '<h1 style="font-size:24px;line-height:1.2;margin:0 0 22px;">'
    || crm_private.booking_card_html_escape(v_title) || ' ✓</h1>'
    || '<div style="line-height:1.6;">'
    || '<div><strong>Artist:</strong> '
    || crm_private.booking_card_html_escape(v_artist_name) || '</div>'
    || '<div><strong>When:</strong> '
    || replace(crm_private.booking_card_html_escape(v_date || case when v_grouped then '' else ' at ' || v_time end), E'\n','<br>') || '</div>'
    || '</div>'
    || v_finance_html
    || '<div style="margin:20px 0;line-height:1.5;">'
    || '<strong>' || crm_private.booking_card_html_escape(v_settings.studio_name) || '</strong><br>'
    || crm_private.booking_card_html_escape(v_settings.studio_address) || '<br>'
    || '<a href="' || crm_private.booking_card_html_escape(v_settings.studio_map_url)
    || '" style="color:#111;">View location</a></div>'
    || '<p style="margin:24px 0 14px;">' || case when v_grouped then 'Please confirm all sessions.' else 'Please confirm so I know to expect you.' end || '</p>'
    || '<a href="' || v_confirm_url
    || '" style="display:block;text-align:center;text-decoration:none;background:#111;color:#fff;'
    || 'padding:14px 18px;border-radius:10px;font-weight:700;margin-bottom:10px;">' || case when v_grouped then 'Confirm all sessions' else 'I&#39;ll be there' end || '</a>'
    || '<a href="' || v_reschedule_url
    || '" style="display:block;text-align:center;text-decoration:none;border:1px solid #bbb;color:#111;'
    || 'padding:13px 18px;border-radius:10px;font-weight:700;">Need another time</a>'
    || '</div></body></html>';

  return next;
end;
$function$;

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
    v_parameters := jsonb_build_array(
      v_first_name,
      v_artist.display_name,
      v_date,
      v_time,
      v_deposit,
      v_remaining
    );
    v_body :=
      case when v_grouped then 'Your ' || v_group.session_count || ' tattoo sessions are booked. ' else 'Your tattoo session is booked. ' end
      || 'Deposit paid: ' || v_deposit
      || '. Remaining balance: ' || v_remaining || '.';
  elsif v_card.card_kind = 'consultation_booked' then
    v_template_name := v_settings.whatsapp_consultation_template_name;
    v_parameters := jsonb_build_array(
      v_first_name,
      v_artist.display_name,
      v_date,
      v_time
    );
    v_body := 'Your consultation is booked.';
  else
    return null;
  end if;

  if v_template_name is null then
    return null;
  end if;

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

CREATE OR REPLACE FUNCTION crm_private.create_booking_card_instagram(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text)
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
  v_conversation public.communication_conversations%rowtype;
  v_message_id uuid;
  v_first_name text;
  v_when text;
  v_place text;
  v_money text := '';
  v_headline text;
  v_body text;
  v_text text;
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
    hashtextextended('booking-card-instagram:' || p_booking_card_id::text, 0)
  );

  select p.communication_message_id into v_message_id
  from crm_private.booking_card_instagram_payloads p
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
    and s.instagram_enabled;
  if not found then
    return null;
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_card.client_id and c.archived_at is null;
  select a.* into v_artist
  from public.artists a
  where a.id = v_card.artist_id and a.is_active;
  if v_client.id is null or v_artist.id is null then
    return null;
  end if;

  if crm_private.client_send_block_reason(
    v_card.client_id,
    'instagram'::public.message_template_channel,
    'service'::public.message_classification
  ) is not null then
    return null;
  end if;

  v_conversation := crm_private.booking_card_instagram_conversation(v_card.client_id, v_card.artist_id);
  if v_conversation.id is null
     or v_conversation.state <> 'open'::public.communication_conversation_state
     or not crm_private.instagram_window_open(v_conversation) then
    return null;
  end if;

  v_first_name := split_part(btrim(v_client.full_name), ' ', 1);
  if nullif(v_first_name, '') is null then
    return null;
  end if;

  v_when := to_char(v_card.start_at at time zone v_card.timezone, 'FMDay, FMDD FMMonth YYYY')
    || ' at ' || to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  select * into v_group from crm_private.booking_group_card_summary(v_card.id);
  v_grouped := found and v_group.session_count > 1;
  if v_grouped then v_when := v_group.dates_text; end if;
  v_place := btrim(v_settings.studio_name) || E'\n' || btrim(v_settings.studio_address)
    || case when nullif(btrim(coalesce(v_settings.studio_map_url, '')), '') is null
            then '' else E'\n' || btrim(v_settings.studio_map_url) end;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_headline := case when v_grouped then 'your ' || v_group.session_count || ' tattoo sessions with ' else 'your tattoo session with ' end || v_artist.display_name || case when v_grouped then ' are booked ✓' else ' is booked ✓' end;
    v_money := E'\n\nDeposit paid: '
      || crm_private.booking_card_money(case when v_grouped then v_group.total_deposit else v_card.deposit_paid end, v_card.currency)
      || E'\nRemaining balance: '
      || crm_private.booking_card_money(case when v_grouped then v_group.total_remaining else v_card.remaining_balance end, v_card.currency);
    v_body := case when v_grouped then 'Your ' || v_group.session_count || ' tattoo sessions are booked. ' else 'Your tattoo session is booked. ' end
      || 'Deposit paid: ' || crm_private.booking_card_money(case when v_grouped then v_group.total_deposit else v_card.deposit_paid end, v_card.currency)
      || '. Remaining balance: '
      || crm_private.booking_card_money(case when v_grouped then v_group.total_remaining else v_card.remaining_balance end, v_card.currency) || '.';
  elsif v_card.card_kind = 'consultation_booked' then
    v_headline := 'your consultation with ' || v_artist.display_name || ' is booked ✓';
    v_body := 'Your consultation is booked.';
  else
    return null;
  end if;

  v_text := 'Hi ' || v_first_name || ', ' || v_headline
    || E'\n\n' || v_when
    || E'\n' || v_place
    || v_money
    || E'\n\nPlease confirm so I know to expect you: tap a button below, or use a link.'
    || E'\n' || case when v_grouped then 'Confirm all sessions: ' else 'I''ll be there: ' end || v_settings.client_action_base_url || p_confirm_token
    || E'\nNeed another time: ' || v_settings.client_action_base_url || p_reschedule_token;

  if char_length(v_text) > 1000 then
    return null;
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, created_by
  ) values (
    v_conversation.id, v_card.artist_id,
    'instagram'::public.communication_channel,
    'outbound'::public.communication_direction,
    'automation'::public.communication_origin,
    'queued'::public.communication_status,
    'booking_card', v_body, null
  )
  returning id into v_message_id;

  insert into crm_private.booking_card_instagram_payloads (
    booking_card_id, communication_message_id, message_text,
    confirm_payload, reschedule_payload
  ) values (
    v_card.id, v_message_id, v_text,
    'booking_action:' || p_confirm_token,
    'booking_action:' || p_reschedule_token
  );

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now(),
      updated_at = now()
  where c.id = v_conversation.id;

  return v_message_id;
end;
$function$;
