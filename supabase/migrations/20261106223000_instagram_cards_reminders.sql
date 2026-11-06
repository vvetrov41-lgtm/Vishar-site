-- New Instagram card cancellation, pre-send Meta window guard, Email fallback.
-- No messages or test clients are written in production.

-- Existing cards retain their two actions; new cards add a third.
ALTER TABLE crm_private.booking_card_instagram_payloads ADD COLUMN IF NOT EXISTS cancel_payload text;
ALTER TABLE crm_private.booking_card_instagram_payloads
 ADD CONSTRAINT booking_card_instagram_cancel_payload_valid CHECK (
 cancel_payload IS NULL OR (cancel_payload ~ '^booking_action:[0-9a-f]{64}$'
 AND cancel_payload<>confirm_payload AND cancel_payload<>reschedule_payload));

CREATE OR REPLACE FUNCTION crm_private.issue_booking_card_instagram_cancel_action(p_booking_card_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,crm_private,extensions AS $fn$
DECLARE v_card crm_private.booking_cards%rowtype; v_session public.sessions%rowtype;
 v_group_id uuid; v_token text; v_token_id uuid;
BEGIN
 SELECT * INTO v_card FROM crm_private.booking_cards b
 WHERE b.id=p_booking_card_id AND b.superseded_at IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO v_session FROM public.sessions s
 JOIN crm_private.artist_state st ON st.artist_id=s.artist_id AND st.is_active
 WHERE s.id=v_card.session_id AND s.artist_id=v_card.artist_id
 AND s.client_id=v_card.client_id FOR UPDATE OF s;
 IF NOT FOUND OR v_session.status<>'confirmed' OR v_session.start_at<=now()
   OR v_session.calendar_version<>v_card.calendar_version THEN RETURN NULL; END IF;
 SELECT g.group_id INTO v_group_id FROM crm_private.booking_card_groups g
 WHERE g.anchor_card_id=v_card.id AND crm_private.booking_group_card_valid(v_card.id);
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 INSERT INTO crm_private.appointment_client_action_tokens
 (session_id,action,token_hash,session_calendar_version,expires_at,booking_card_id)
 VALUES (v_session.id,'cancel',encode(extensions.digest(v_token,'sha256'),'hex'),
 v_session.calendar_version,least(v_session.start_at,now()+interval '7 days'),v_card.id)
 RETURNING id INTO v_token_id;
 IF v_group_id IS NOT NULL THEN
 INSERT INTO crm_private.booking_card_group_action_tokens(token_id,group_id)
 VALUES (v_token_id,v_group_id); END IF;
 RETURN v_token;
END;
$fn$;
REVOKE ALL ON FUNCTION crm_private.issue_booking_card_instagram_cancel_action(uuid)
 FROM public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION crm_private.create_booking_card_instagram(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text, p_cancel_token text)
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
  v_video boolean := false;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_cancel_token,'') !~ '^[0-9a-f]{64}$'
     or p_cancel_token IN (p_confirm_token,p_reschedule_token)
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

  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;
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
    v_headline := case when v_video then 'your video consultation with ' else 'your consultation with ' end || v_artist.display_name || ' is booked ✓';
    v_body := case when v_video then 'Your video consultation is booked.' else 'Your consultation is booked.' end;
  else
    return null;
  end if;

  v_text := 'Hi ' || v_first_name || ', ' || v_headline
    || E'\n\n' || v_when
    || case when v_video then E'\nThis is an online consultation. We will agree how to connect before the call.' else E'\n' || v_place end
    || v_money
    || case when v_video then E'\n\nPlease confirm you can join the video call: tap a button or use a link.' else E'\n\nPlease confirm so I know to expect you: tap a button below, or use a link.' end
    || E'\n' || case when v_video then 'Confirm video call: ' when v_grouped then 'Confirm all sessions: ' else 'I''ll be there: ' end || v_settings.client_action_base_url || p_confirm_token
    || E'\nNeed another time: ' || v_settings.client_action_base_url || p_reschedule_token
    || E'\nCancel booking: ' || v_settings.client_action_base_url || p_cancel_token;

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
    confirm_payload, reschedule_payload, cancel_payload
  ) values (
    v_card.id, v_message_id, v_text,
    'booking_action:' || p_confirm_token,
    'booking_action:' || p_reschedule_token,
    'booking_action:' || p_cancel_token
  );

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now(),
      updated_at = now()
  where c.id = v_conversation.id;

  return v_message_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.queue_booking_card_instagram(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text, p_cancel_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_message_id uuid;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;
  if not found then
    return null;
  end if;

  select d.communication_message_id into v_message_id
  from crm_private.booking_card_deliveries d
  where d.booking_card_id = v_card.id
    and d.channel = 'instagram'::public.message_template_channel;
  if found then
    return v_message_id;
  end if;

  v_message_id := crm_private.create_booking_card_instagram(
    v_card.id, p_confirm_token, p_reschedule_token, p_cancel_token
  );
  if v_message_id is null then
    return null;
  end if;

  insert into public.integration_outbox (
    kind, dedupe_key, payload, artist_id, client_id, enquiry_id,
    project_id, session_id, communication_message_id
  ) values (
    'instagram_message'::public.outbox_kind,
    'instagram:booking_card:' || v_card.id::text,
    jsonb_build_object('communication_message_id', v_message_id),
    v_card.artist_id, v_card.client_id, v_card.enquiry_id, v_card.project_id,
    -- integration_outbox_communication_entity: message jobs carry no session.
    null,
    v_message_id
  )
  on conflict (dedupe_key) do nothing;

  insert into crm_private.booking_card_deliveries (
    booking_card_id, channel, status, communication_message_id, queued_at
  ) values (
    v_card.id, 'instagram'::public.message_template_channel, 'queued', v_message_id, now()
  )
  on conflict (booking_card_id, channel) do nothing;

  return v_message_id;
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.dispatch_booking_card_once(p_booking_card_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_choice record;
  v_confirm_token text;
  v_reschedule_token text;
  v_cancel_token text;
  v_message_id uuid;
  v_error_constraint text;
  v_error_table text;
  v_group_anchor uuid;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null
  for update;

  if not found then
    return;
  end if;

  -- Dispatch exactly the anchor when a complete paid multi-session group is ready.
  -- NULL means its sibling cards are still being generated in this transaction.
  v_group_anchor := crm_private.booking_group_card_anchor(v_card.id);
  if v_group_anchor is null then return; end if;
  if v_group_anchor <> v_card.id then
    perform crm_private.dispatch_booking_card_once(v_group_anchor);
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id;

  if not found
     or (not v_settings.email_enabled and not v_settings.whatsapp_enabled
         and not v_settings.instagram_enabled)
     or (
       v_settings.appointment_start_from is not null
       and v_card.start_at < v_settings.appointment_start_from
     )
     or (
       v_settings.appointment_created_from is not null
       and exists (
         select 1
         from public.sessions s
         where s.id = v_card.session_id
           and s.created_at < v_settings.appointment_created_from
       )
     ) then
    return;
  end if;

  -- The channel of a card is fixed by its first delivery. Retries and later
  -- conversations never add a sibling channel.
  if exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = v_card.id
  ) then
    return;
  end if;

  select * into v_choice
  from crm_private.resolve_booking_card_channel(v_card.client_id, v_card.artist_id);

  insert into crm_private.booking_card_channel_decisions (
    booking_card_id,
    channel,
    outcome,
    evidence_source,
    evidence_conversation_id,
    evidence_message_id,
    evidence_at,
    decided_at
  ) values (
    v_card.id,
    v_choice.channel,
    v_choice.outcome,
    v_choice.evidence_source,
    v_choice.evidence_conversation_id,
    v_choice.evidence_message_id,
    v_choice.evidence_at,
    now()
  )
  on conflict (booking_card_id) do update
  set channel = excluded.channel,
      outcome = excluded.outcome,
      evidence_source = excluded.evidence_source,
      evidence_conversation_id = excluded.evidence_conversation_id,
      evidence_message_id = excluded.evidence_message_id,
      evidence_at = excluded.evidence_at,
      decided_at = excluded.decided_at;

  if v_choice.outcome <> 'selected' then
    return;
  end if;

  begin
    select
      max(a.raw_token) filter (
        where a.action = 'confirm_attendance'::public.appointment_client_action
      ),
      max(a.raw_token) filter (
        where a.action = 'request_reschedule'::public.appointment_client_action
      )
    into v_confirm_token, v_reschedule_token
    from crm_private.issue_booking_card_client_actions(v_card.id) a;

    if v_confirm_token is null
       or v_reschedule_token is null
       or v_confirm_token !~ '^[0-9a-f]{64}$'
       or v_reschedule_token !~ '^[0-9a-f]{64}$'
       or v_confirm_token = v_reschedule_token then
      raise exception 'booking card action issuance failed'
        using errcode = '23514';
    end if;

    if v_choice.channel = 'email' then
      v_message_id := crm_private.queue_booking_card_email(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    elsif v_choice.channel = 'whatsapp' then
      v_message_id := crm_private.queue_booking_card_whatsapp(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    elsif v_choice.channel = 'instagram' then
      v_cancel_token := crm_private.issue_booking_card_instagram_cancel_action(v_card.id);
      if v_cancel_token is null then
        raise exception 'Instagram cancel capability unavailable' using errcode='23514';
      end if;
      v_message_id := crm_private.queue_booking_card_instagram(
        v_card.id, v_confirm_token, v_reschedule_token, v_cancel_token
      );
    end if;

    if v_message_id is null then
      -- Rolls back the token pair and any partial message with it.
      raise exception 'booking card channel is unavailable'
        using errcode = '23514';
    end if;
  exception when others then
    get stacked diagnostics v_error_constraint = constraint_name,
                            v_error_table = table_name;
    raise warning 'booking card queue failed, channel=% sqlstate=% constraint=% table=%',
      v_choice.channel, sqlstate,
      coalesce(v_error_constraint, '-'), coalesce(v_error_table, '-');

    update crm_private.booking_card_channel_decisions x
    set outcome = 'delivery_unavailable',
        decided_at = now()
    where x.booking_card_id = v_card.id;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.resolve_booking_card_channel(p_client_id uuid, p_artist_id uuid)
 RETURNS TABLE(channel text, outcome text, evidence_source text, evidence_conversation_id uuid, evidence_message_id uuid, evidence_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_evidence record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client public.clients%rowtype;
  v_conversation public.communication_conversations%rowtype;
  v_phone text;
begin
  select * into v_evidence
  from crm_private.booking_card_conversation_evidence(p_client_id, p_artist_id);

  if not found then
    return query select null::text, 'no_conversation_channel'::text,
      null::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  channel := v_evidence.channel;
  evidence_source := v_evidence.evidence_source;
  evidence_conversation_id := v_evidence.evidence_conversation_id;
  evidence_message_id := v_evidence.evidence_message_id;
  evidence_at := v_evidence.evidence_at;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = p_artist_id;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
    and c.archived_at is null;

  if v_evidence.channel = 'whatsapp' then
    if not coalesce(v_settings.whatsapp_enabled, false) then
      outcome := 'conversation_channel_disabled';
    else
      select c.* into v_conversation
      from public.communication_conversations c
      where c.id = v_evidence.evidence_conversation_id;

      v_phone := crm_private.normalize_whatsapp_phone(v_client.phone);

      -- The card must reach the same WhatsApp contact the conversation is
      -- with, never another number that merely sits on the client record.
      if v_client.id is null
         or v_phone is null
         or v_phone !~ '^\+[0-9]{6,20}$'
         or v_conversation.id is null
         or v_conversation.state <> 'open'::public.communication_conversation_state
         or v_conversation.external_contact_id is distinct from substring(v_phone from 2)
         or crm_private.client_send_block_reason(
           p_client_id,
           'whatsapp'::public.message_template_channel,
           'service'::public.message_classification
         ) is not null then
        outcome := 'conversation_channel_unreachable';
      else
        outcome := 'selected';
      end if;
    end if;
  elsif v_evidence.channel = 'email' then
    if not coalesce(v_settings.email_enabled, false) then
      outcome := 'conversation_channel_disabled';
    elsif v_client.id is null
       or nullif(lower(btrim(coalesce(v_client.email, ''))), '') is null
       or crm_private.client_send_block_reason(
         p_client_id,
         'email'::public.message_template_channel,
         'service'::public.message_classification
       ) is not null then
      outcome := 'conversation_channel_unreachable';
    else
      outcome := 'selected';
    end if;
  elsif v_evidence.channel = 'instagram' then
    if not coalesce(v_settings.instagram_enabled, false) then
      outcome := 'conversation_channel_disabled';
    else
      v_conversation := crm_private.booking_card_instagram_conversation(p_client_id, p_artist_id);
      if v_client.id is null
         or v_conversation.id is null
         or v_conversation.state <> 'open'::public.communication_conversation_state
         or crm_private.client_send_block_reason(
           p_client_id,
           'instagram'::public.message_template_channel,
           'service'::public.message_classification
         ) is not null then
        outcome := 'conversation_channel_unreachable';
      elsif not crm_private.instagram_window_open(v_conversation) then
        -- Never switched to another channel: it waits for the client to write.
        outcome := 'messaging_window_closed';
      else
        outcome := 'selected';
      end if;
    end if;
  else
    -- A future channel without a booking card transport.
    outcome := 'conversation_channel_unsupported';
  end if;

  -- Email is the safe fallback for a closed/unreachable Instagram window.
  if channel='instagram' and outcome IN
     ('messaging_window_closed','conversation_channel_unreachable','conversation_channel_disabled')
     and coalesce(v_settings.email_enabled,false)
     and nullif(lower(btrim(coalesce(v_client.email,''))), '') is not null
     and crm_private.client_send_block_reason(p_client_id,'email'::public.message_template_channel,
       'service'::public.message_classification) is null then
    channel:='email'; outcome:='selected';
    evidence_source:='instagram_unavailable_email_fallback';
  end if;
  return next;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_apply_instagram_booking_card_action(p_artist_id uuid, p_integration_key text, p_external_contact_id text, p_provider_message_id text, p_provider_timestamp timestamp with time zone, p_payload text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_token text;
  v_hash text;
  v_valid boolean;
  v_ingest jsonb;
  v_apply jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram booking action is backend-only' using errcode = '42501';
  end if;

  if p_artist_id is null
     or coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$'
     or coalesce(p_external_contact_id, '') !~ '^[0-9]{5,40}$'
     or coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./+-]{8,255}$'
     or p_provider_timestamp is null
     or p_provider_timestamp > now() + interval '5 minutes'
     or coalesce(p_payload, '') !~ '^booking_action:[0-9a-f]{64}$' then
    raise exception 'invalid Instagram booking action envelope' using errcode = '22023';
  end if;

  v_token := substring(p_payload from 16);
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  -- The capability must be the one this card sent to this Instagram contact.
  select true into v_valid
  from crm_private.appointment_client_action_tokens t
  join crm_private.booking_card_instagram_payloads p
    on p.booking_card_id = t.booking_card_id
   and (p.confirm_payload = p_payload or p.reschedule_payload = p_payload or p.cancel_payload = p_payload)
  join public.communication_messages m on m.id = p.communication_message_id
  join public.communication_conversations c on c.id = m.conversation_id
  join public.sessions s on s.id = t.session_id
  where t.token_hash = v_hash
    and t.consumed_at is null
    and t.invalidated_at is null
    and t.expires_at > now()
    and t.session_calendar_version = s.calendar_version
    and s.artist_id = p_artist_id
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and (t.booking_card_id is null or crm_private.booking_group_card_valid(t.booking_card_id))
    and c.artist_id = p_artist_id
    and c.channel = 'instagram'::public.communication_channel
    and c.integration_key = p_integration_key
    and c.external_contact_id = p_external_contact_id;

  -- The button press is the client's message either way, recorded once.
  v_ingest := public.record_communication_inbound_message(
    p_artist_id, 'instagram', p_integration_key, p_external_contact_id,
    p_provider_message_id, p_provider_timestamp,
    case when nullif(btrim(coalesce(p_body, '')), '') is null then 'unsupported' else 'text' end,
    nullif(left(btrim(coalesce(p_body, '')), 4096), ''),
    '[]'::jsonb,
    null
  );

  if not coalesce(v_valid, false) then
    return jsonb_build_object('applied', false, 'reason', 'action_unavailable');
  end if;
  if coalesce((v_ingest ->> 'changed')::boolean, false) is false then
    return jsonb_build_object('applied', false, 'replayed', true, 'reason', 'provider_event_replayed');
  end if;

  v_apply := public.service_apply_appointment_client_action(v_token);
  return jsonb_build_object(
    'applied', true,
    'replayed', false,
    'action', v_apply ->> 'action',
    'outcome', v_apply ->> 'outcome'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_instagram_booking_card_payload(p_outbox_id uuid, p_worker_id text)
 RETURNS TABLE(is_booking_card boolean, booking_card_id uuid, communication_message_id uuid, artist_id uuid, message_text text, confirm_payload text, reschedule_payload text, delivery_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram booking card resolution is backend-only' using errcode = '42501';
  end if;
  if p_outbox_id is null or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'valid Instagram lease identity is required' using errcode = '22023';
  end if;

  return query
  select
    p.booking_card_id is not null,
    p.booking_card_id,
    m.id,
    o.artist_id,
    p.message_text,
    p.confirm_payload,
    p.reschedule_payload,
    case
      when p.booking_card_id is null then true
      else (
        b.superseded_at is null
        and crm_private.booking_group_card_valid(b.id)
        and b.artist_id = o.artist_id
        and b.client_id is not distinct from o.client_id
        and s.status = 'confirmed'::public.session_status
        and s.calendar_version = b.calendar_version
        and s.start_at > now()
        and m.status = 'queued'::public.communication_status
        and coalesce(settings.instagram_enabled, false)
        and exists (
          select 1 from public.communication_conversations c
          join public.artist_integrations i on i.artist_id=c.artist_id
            and i.integration_key=c.integration_key
            and i.integration_type='instagram' and i.provider='instagram_login' and i.is_enabled
          where c.id=m.conversation_id and c.client_id=b.client_id
            and c.artist_id=b.artist_id and c.channel='instagram'
            and c.link_state='linked' and c.state='open'
            and crm_private.instagram_window_open(c)
        )
      )
    end
  from public.integration_outbox o
  join public.communication_messages m on m.id = o.communication_message_id
  left join crm_private.booking_card_instagram_payloads p on p.communication_message_id = m.id
  left join crm_private.booking_cards b on b.id = p.booking_card_id
  left join public.sessions s on s.id = b.session_id
  left join crm_private.booking_card_artist_settings settings on settings.artist_id = b.artist_id
  where o.id = p_outbox_id
    and o.kind = 'instagram_message'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status
    and o.leased_by = p_worker_id
    and o.lease_expires_at > now()
    and m.artist_id = o.artist_id
    and m.channel = 'instagram'::public.communication_channel;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_instagram_booking_card_cancel_payload(
 p_outbox_id uuid,p_worker_id text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,crm_private AS $fn$
DECLARE v_cancel text;
BEGIN
 IF NOT crm_private.is_service_backend() THEN RAISE EXCEPTION 'backend only' USING errcode='42501'; END IF;
 IF p_outbox_id IS NULL OR coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$' THEN
 RAISE EXCEPTION 'valid worker lease required' USING errcode='22023'; END IF;
 SELECT p.cancel_payload INTO v_cancel FROM public.integration_outbox o
 JOIN crm_private.booking_card_instagram_payloads p ON p.communication_message_id=o.communication_message_id
 JOIN public.communication_messages m ON m.id=p.communication_message_id
 WHERE o.id=p_outbox_id AND o.kind='instagram_message' AND o.status='leased'
 AND o.leased_by=p_worker_id AND o.lease_expires_at>now()
 AND m.artist_id=o.artist_id AND m.channel='instagram';
 RETURN v_cancel;
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_resolve_instagram_booking_card_cancel_payload(uuid,text)
 FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.service_resolve_instagram_booking_card_cancel_payload(uuid,text)
 TO service_role;

