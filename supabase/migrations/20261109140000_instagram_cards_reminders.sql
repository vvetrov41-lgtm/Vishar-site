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
    -- Keep the verified conversation as the evidence source; do not invent
    -- a new enum value for the channel-decision audit row.
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


-- Lifecycle Instagram messages use the linked participant ID and Meta's real
-- 24-hour inbound window. No unsolicited first-contact DM is possible.
CREATE TABLE crm_private.lifecycle_instagram_payloads (
  automation_job_id uuid PRIMARY KEY REFERENCES public.automation_jobs(id) ON DELETE RESTRICT,
  communication_message_id uuid NOT NULL UNIQUE REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
  artist_id uuid NOT NULL REFERENCES public.artists(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN
    ('session_reminder_72h','session_reminder_24h','consultation_reminder',
     'post_session_aftercare','post_session_checkin')),
  message_text text NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 1000),
  confirm_payload text,
  reschedule_payload text,
  cancel_payload text,
  members jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_lifecycle_buttons CHECK (
    (purpose IN ('session_reminder_24h','consultation_reminder')
      AND confirm_payload ~ '^booking_action:[0-9a-f]{64}$'
      AND reschedule_payload ~ '^booking_action:[0-9a-f]{64}$'
      AND cancel_payload ~ '^booking_action:[0-9a-f]{64}$'
      AND confirm_payload<>reschedule_payload
      AND confirm_payload<>cancel_payload
      AND reschedule_payload<>cancel_payload)
    OR (purpose NOT IN ('session_reminder_24h','consultation_reminder')
      AND confirm_payload IS NULL AND reschedule_payload IS NULL
      AND cancel_payload IS NULL)
  )
);
ALTER TABLE crm_private.lifecycle_instagram_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_private.lifecycle_instagram_payloads
 FROM public,anon,authenticated,service_role;

-- An email may replace an unavailable Instagram route before sending, or
-- a provider rejection known to be definitive. Unknown sends never fall back.
CREATE TABLE crm_private.lifecycle_instagram_email_fallbacks (
 job_id uuid PRIMARY KEY REFERENCES public.automation_jobs(id) ON DELETE RESTRICT,
 artist_id uuid NOT NULL REFERENCES public.artists(id) ON DELETE RESTRICT,
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(reason IN ('instagram_unavailable','instagram_rejected')),
 instagram_outbox_id uuid UNIQUE REFERENCES public.integration_outbox(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT instagram_fallback_evidence CHECK(
   (reason='instagram_unavailable' AND instagram_outbox_id IS NULL)
   OR (reason='instagram_rejected' AND instagram_outbox_id IS NOT NULL))
);
ALTER TABLE crm_private.lifecycle_instagram_email_fallbacks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_private.lifecycle_instagram_email_fallbacks
 FROM public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION crm_private.lifecycle_instagram_send_ready(
 p_client_id uuid,p_artist_id uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm_private AS $fn$
 SELECT coalesce(
   crm_private.client_send_block_reason(p_client_id,'instagram','service') IS NULL
   AND EXISTS (SELECT 1 FROM public.clients c
      WHERE c.id=p_client_id AND c.archived_at IS NULL)
   AND EXISTS (SELECT 1 FROM crm_private.booking_card_artist_settings s
      WHERE s.artist_id=p_artist_id AND s.instagram_enabled)
   AND EXISTS (
     SELECT 1 FROM public.communication_conversations c
     JOIN public.artist_integrations i ON i.artist_id=c.artist_id
       AND i.integration_key=c.integration_key AND i.integration_type='instagram'
       AND i.provider='instagram_login' AND i.is_enabled
     WHERE c.artist_id=p_artist_id AND c.client_id=p_client_id
       AND c.channel='instagram' AND c.link_state='linked' AND c.state='open'
       AND c.external_contact_id ~ '^[0-9]{5,40}$'
       AND crm_private.instagram_window_open(c)
   ),false);
$fn$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_instagram_send_ready(uuid,uuid)
 FROM public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION crm_private.lifecycle_instagram_email_fallback_allowed(
 p_job_id uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm_private AS $fn$
 SELECT EXISTS(
   SELECT 1 FROM crm_private.lifecycle_instagram_email_fallbacks f
   JOIN public.automation_jobs j ON j.id=f.job_id
   JOIN public.sessions s ON s.id=j.session_id AND s.artist_id=j.artist_id
   LEFT JOIN public.integration_outbox o ON o.id=f.instagram_outbox_id
   WHERE f.job_id=p_job_id AND f.artist_id=j.artist_id
     AND f.client_id=s.client_id
     AND crm_private.lifecycle_selected_channel(s.client_id,j.artist_id)='instagram'
     AND (
       (f.reason='instagram_unavailable' AND f.instagram_outbox_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM crm_private.lifecycle_instagram_payloads p
                          WHERE p.automation_job_id=j.id))
       OR
       (f.reason='instagram_rejected' AND o.kind='instagram_message'
         AND o.status='dead' AND o.artist_id=j.artist_id
         AND o.client_id=s.client_id
         AND o.last_error_code IN (
           'instagram_outside_messaging_window','instagram_rejected',
           'instagram_credentials_rejected','instagram_destination_invalid',
           'instagram_account_invalid','instagram_provider_unsupported',
           'instagram_lifecycle_window_closed')
         AND EXISTS(
           SELECT 1 FROM crm_private.lifecycle_instagram_payloads p
           WHERE p.automation_job_id=j.id
             AND p.communication_message_id=o.communication_message_id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM crm_private.lifecycle_instagram_payloads p
       JOIN public.integration_outbox earlier
         ON earlier.communication_message_id=p.communication_message_id
       WHERE p.automation_job_id=j.id AND earlier.status='succeeded'
     )
 );
$fn$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_instagram_email_fallback_allowed(uuid)
 FROM public,anon,authenticated,service_role;

-- Queue once, against the already-authorised lifecycle job and its session.
-- The final provider send is still governed by leased pre-send readback.
CREATE OR REPLACE FUNCTION crm_private.queue_lifecycle_instagram_job(p_job_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm_private,extensions AS $fn$
DECLARE
 j public.automation_jobs%rowtype;
 s public.sessions%rowtype;
 a public.artists%rowtype;
 c public.communication_conversations%rowtype;
 cfg crm_private.booking_card_artist_settings%rowtype;
 v_first text;
 v_dates text;
 v_place text;
 v_guide text;
 v_text text;
 v_members jsonb;
 v_confirm_token text;
 v_reschedule_token text;
 v_cancel_token text;
 v_confirm_url text;
 v_reschedule_url text;
 v_cancel_url text;
 v_message_id uuid;
 v_outbox_id uuid;
BEGIN
 IF NOT crm_private.is_service_backend() THEN
   RAISE EXCEPTION 'Instagram lifecycle enqueue is backend-only' USING errcode='42501'; END IF;
 SELECT * INTO j FROM public.automation_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'pending' OR j.message_purpose NOT IN (
  'session_reminder_72h','session_reminder_24h','consultation_reminder',
  'post_session_aftercare','post_session_checkin') THEN RETURN 'skipped'; END IF;
 SELECT * INTO s FROM public.sessions
 WHERE id=j.session_id AND artist_id=j.artist_id;
 SELECT * INTO a FROM public.artists WHERE id=j.artist_id AND is_active;
 SELECT * INTO cfg FROM crm_private.booking_card_artist_settings
 WHERE artist_id=j.artist_id AND instagram_enabled;
 IF s.id IS NULL OR a.id IS NULL OR cfg.artist_id IS NULL
    OR crm_private.lifecycle_block_disposition(j.id) NOT IN ('eligible','unmanaged')
    OR crm_private.lifecycle_selected_channel(s.client_id,j.artist_id)<>'instagram'
    OR NOT crm_private.lifecycle_instagram_send_ready(s.client_id,j.artist_id)
 THEN RETURN 'unavailable'; END IF;

 SELECT cc.* INTO c FROM public.communication_conversations cc
 JOIN public.artist_integrations i ON i.artist_id=cc.artist_id
   AND i.integration_key=cc.integration_key
   AND i.integration_type='instagram' AND i.provider='instagram_login' AND i.is_enabled
 WHERE cc.artist_id=j.artist_id AND cc.client_id=s.client_id
   AND cc.channel='instagram' AND cc.link_state='linked' AND cc.state='open'
   AND crm_private.instagram_window_open(cc)
 ORDER BY cc.last_inbound_at DESC,cc.id LIMIT 1 FOR UPDATE OF cc;
 IF NOT FOUND THEN RETURN 'unavailable'; END IF;

 SELECT nullif(split_part(btrim(cl.full_name),' ',1),'') INTO v_first
 FROM public.clients cl WHERE cl.id=s.client_id AND cl.archived_at IS NULL;
 IF v_first IS NULL THEN RETURN 'unavailable'; END IF;
 v_members:=CASE WHEN j.message_purpose='consultation_reminder' THEN
   jsonb_build_array(jsonb_build_object(
     'id',s.id,'version',s.calendar_version,'start',s.start_at,
     'end',s.end_at,'actual_end',s.actual_end_at,'status',s.status))
 ELSE crm_private.lifecycle_email_members(s.id,j.message_purpose) END;
 IF v_members IS NULL OR jsonb_array_length(v_members)=0 THEN RETURN 'unavailable'; END IF;

 IF j.message_purpose IN ('session_reminder_72h','session_reminder_24h') THEN
   SELECT string_agg(to_char(b.start_at AT TIME ZONE a.timezone,'FMDD FMMonth YYYY HH24:MI'),
      ', ' ORDER BY b.start_at,b.session_id) INTO v_dates
   FROM crm_private.session_lifecycle_block(s.id) b;
   IF nullif(v_dates,'') IS NULL THEN RETURN 'unavailable'; END IF;
 END IF;

 IF j.message_purpose IN ('session_reminder_24h','consultation_reminder') THEN
   SELECT max(x.raw_token) FILTER (WHERE x.action='confirm_attendance'),
          max(x.raw_token) FILTER (WHERE x.action='request_reschedule'),
          max(x.raw_token) FILTER (WHERE x.action='cancel')
     INTO v_confirm_token,v_reschedule_token,v_cancel_token
   FROM crm_private.issue_appointment_client_actions(s.id) x;
   v_confirm_url:=crm_private.lifecycle_whatsapp_confirmation_url(
     cfg.client_action_base_url,v_confirm_token);
   v_reschedule_url:=crm_private.lifecycle_whatsapp_confirmation_url(
     cfg.client_action_base_url,v_reschedule_token);
   v_cancel_url:=crm_private.lifecycle_whatsapp_confirmation_url(
     cfg.client_action_base_url,v_cancel_token);
   IF v_confirm_url IS NULL OR v_reschedule_url IS NULL OR v_cancel_url IS NULL
      THEN RAISE EXCEPTION 'Instagram lifecycle actions unavailable' USING errcode='23514'; END IF;
   IF j.message_purpose='session_reminder_24h' THEN
     PERFORM crm_private.register_lifecycle_confirmation(v_confirm_token,s.id);
   END IF;
 END IF;

 IF j.message_purpose IN ('session_reminder_24h','consultation_reminder')
    AND s.appointment_type<>'video_consultation' THEN
   IF nullif(btrim(cfg.studio_address),'') IS NULL THEN RETURN 'unavailable'; END IF;
   v_place:=concat_ws(', ',nullif(btrim(cfg.studio_name),''),btrim(cfg.studio_address));
   v_place:=crm_private.lifecycle_whatsapp_location_with_map(v_place,cfg.studio_map_url);
 END IF;

 IF j.message_purpose='session_reminder_72h' THEN
   v_text:='Hi '||v_first||', your tattoo sessions with '||a.display_name
      ||' are coming up. Dates and times: '||v_dates
      ||'. Each session has its own 72-hour cancellation period.';
 ELSIF j.message_purpose='session_reminder_24h' THEN
   v_text:='Hi '||v_first||', your tattoo sessions with '||a.display_name
      ||' start tomorrow. Booked dates: '||v_dates||E'\nStudio: '||v_place
      ||E'\nConfirm: '||v_confirm_url
      ||E'\nReschedule: '||v_reschedule_url
      ||E'\nCancel: '||v_cancel_url;
 ELSIF j.message_purpose='consultation_reminder' THEN
   IF s.appointment_type NOT IN ('in_person_consultation','video_consultation')
     THEN RETURN 'unavailable'; END IF;
   v_dates:=to_char(s.start_at AT TIME ZONE a.timezone,'FMDay, FMDD FMMonth YYYY HH24:MI');
   v_text:='Hi '||v_first||', your '
     ||CASE WHEN s.appointment_type='video_consultation'
       THEN 'video consultation' ELSE 'consultation' END
     ||' with '||a.display_name||' is tomorrow at '||v_dates||'.'
     ||E'\n'||CASE WHEN s.appointment_type='video_consultation'
       THEN 'Online consultation. No studio visit.'
       ELSE 'Studio: '||v_place END
     ||E'\nConfirm: '||v_confirm_url
     ||E'\nReschedule: '||v_reschedule_url
     ||E'\nCancel: '||v_cancel_url;
 ELSE
   SELECT substring(tmpl.body from 'https://[a-z0-9.-]+/aftercare/')
     INTO v_guide
   FROM public.message_templates tmpl
   JOIN public.artists ar ON ar.id=j.artist_id
   WHERE tmpl.workspace_id=ar.workspace_id
     AND (tmpl.artist_id=ar.id OR tmpl.artist_id IS NULL)
     AND tmpl.purpose='post_session_aftercare'
     AND tmpl.channel='email' AND tmpl.locale=j.message_locale
     AND tmpl.status='active'
   ORDER BY (tmpl.artist_id IS NOT NULL) DESC,tmpl.version DESC,tmpl.id
   LIMIT 1;
   IF v_guide IS NULL THEN RETURN 'unavailable'; END IF;
   IF j.message_purpose='post_session_aftercare' THEN
     v_text:='Hi '||v_first||', thank you for your tattoo session with '
       ||a.display_name||'. Your aftercare guide: '||v_guide
       ||'. Reply here if you need advice.';
   ELSE
     v_text:='Hi '||v_first||', how is your tattoo healing after your session with '
       ||a.display_name||'? Your aftercare guide: '||v_guide
       ||'. No need to reply if everything is fine.';
   END IF;
 END IF;
 IF nullif(btrim(v_text),'') IS NULL
    OR octet_length(convert_to(v_text,'UTF8'))>1000
 THEN RETURN 'unavailable'; END IF;
 IF EXISTS (SELECT 1 FROM crm_private.lifecycle_instagram_payloads p
   WHERE p.automation_job_id=j.id) THEN RETURN 'skipped'; END IF;

 INSERT INTO public.communication_messages (
   conversation_id,artist_id,channel,direction,origin,status,
   message_type,body,created_by
 ) VALUES (c.id,j.artist_id,'instagram','outbound','automation','queued',
   'template','Automatic appointment update ('||j.message_purpose||')',NULL)
 RETURNING id INTO v_message_id;

 INSERT INTO crm_private.lifecycle_instagram_payloads(
   automation_job_id,communication_message_id,artist_id,session_id,
   purpose,message_text,confirm_payload,reschedule_payload,cancel_payload,members
 ) VALUES (
   j.id,v_message_id,j.artist_id,s.id,j.message_purpose,v_text,
   CASE WHEN v_confirm_token IS NOT NULL THEN 'booking_action:'||v_confirm_token END,
   CASE WHEN v_reschedule_token IS NOT NULL THEN 'booking_action:'||v_reschedule_token END,
   CASE WHEN v_cancel_token IS NOT NULL THEN 'booking_action:'||v_cancel_token END,
   v_members
 );

 INSERT INTO public.integration_outbox(
   kind,dedupe_key,payload,artist_id,client_id,enquiry_id,
   project_id,session_id,communication_message_id,max_attempts
 ) VALUES ('instagram_message','instagram:lifecycle:'||j.id::text,
   jsonb_build_object('communication_message_id',v_message_id),
   j.artist_id,s.client_id,s.enquiry_id,s.project_id,NULL,v_message_id,1)
 ON CONFLICT(dedupe_key) DO NOTHING RETURNING id INTO v_outbox_id;
 IF v_outbox_id IS NULL THEN RAISE EXCEPTION 'Instagram lifecycle outbox collision' USING errcode='23514'; END IF;

 UPDATE public.automation_jobs SET status='completed',completed_at=now(),
  attempt_count=attempt_count+1,last_error_category='none' WHERE id=j.id;
 RETURN 'queued';
END;
$fn$;
REVOKE ALL ON FUNCTION crm_private.queue_lifecycle_instagram_job(uuid)
 FROM public,anon,authenticated,service_role;

-- Leased payloads are revalidated at the moment of sending. A changed session,
-- closed Instagram window, suppression or identity mismatch prevents delivery.
CREATE OR REPLACE FUNCTION public.service_resolve_instagram_lifecycle_payload(
 p_outbox_id uuid,p_worker_id text
) RETURNS TABLE(is_lifecycle boolean,communication_message_id uuid,artist_id uuid,
 purpose text,message_text text,quick_replies jsonb,delivery_allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm_private AS $fn$
BEGIN
 IF NOT crm_private.is_service_backend() THEN
   RAISE EXCEPTION 'Instagram lifecycle readback is backend-only' USING errcode='42501'; END IF;
 IF p_outbox_id IS NULL OR coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$' THEN
   RAISE EXCEPTION 'valid Instagram worker lease required' USING errcode='22023'; END IF;
 RETURN QUERY
 SELECT p.automation_job_id IS NOT NULL,m.id,o.artist_id,
   p.purpose,p.message_text,
   CASE WHEN p.purpose IN ('session_reminder_24h','consultation_reminder')
     THEN jsonb_build_array(
       jsonb_build_object('title','Confirm','payload',p.confirm_payload),
       jsonb_build_object('title','Reschedule','payload',p.reschedule_payload),
       jsonb_build_object('title','Cancel booking','payload',p.cancel_payload))
     ELSE '[]'::jsonb END AS quick_replies,
   (
     p.automation_job_id IS NOT NULL
     AND m.status='queued' AND m.artist_id=o.artist_id
     AND o.client_id=s.client_id AND o.artist_id=s.artist_id
     AND j.id=p.automation_job_id AND j.artist_id=o.artist_id
     AND j.status='completed' AND j.message_purpose=p.purpose
     AND j.session_id=p.session_id
     AND ((p.purpose='consultation_reminder'
       AND s.appointment_type IN ('in_person_consultation','video_consultation'))
        OR (p.purpose<>'consultation_reminder'
       AND s.appointment_type IN ('tattoo_session','touch_up')))
     AND ((p.purpose IN ('session_reminder_72h','session_reminder_24h','consultation_reminder')
            AND s.status='confirmed' AND s.start_at>now())
          OR (p.purpose IN ('post_session_aftercare','post_session_checkin')
            AND s.status='completed'))
     AND p.members=(CASE WHEN p.purpose='consultation_reminder'
       THEN jsonb_build_array(jsonb_build_object(
         'id',s.id,'version',s.calendar_version,'start',s.start_at,
         'end',s.end_at,'actual_end',s.actual_end_at,'status',s.status))
       ELSE crm_private.lifecycle_email_members(p.session_id,p.purpose) END)
     AND crm_private.client_send_block_reason(s.client_id,'instagram','service') IS NULL
     AND crm_private.lifecycle_selected_channel(s.client_id,o.artist_id)='instagram'
     AND c.id=m.conversation_id AND c.client_id=s.client_id
     AND c.artist_id=o.artist_id AND c.channel='instagram'
     AND c.state='open' AND c.link_state='linked'
     AND crm_private.instagram_window_open(c)
     AND EXISTS(SELECT 1 FROM crm_private.booking_card_artist_settings cfg
       WHERE cfg.artist_id=o.artist_id AND cfg.instagram_enabled)
     AND EXISTS(SELECT 1 FROM public.artist_integrations i
       WHERE i.artist_id=o.artist_id AND i.integration_key=c.integration_key
       AND i.integration_type='instagram' AND i.provider='instagram_login'
       AND i.is_enabled)
   ) AS delivery_allowed
 FROM public.integration_outbox o
 JOIN public.communication_messages m ON m.id=o.communication_message_id
 LEFT JOIN crm_private.lifecycle_instagram_payloads p
   ON p.communication_message_id=m.id AND p.artist_id=o.artist_id
 LEFT JOIN public.automation_jobs j ON j.id=p.automation_job_id
 LEFT JOIN public.sessions s ON s.id=p.session_id
 LEFT JOIN public.communication_conversations c ON c.id=m.conversation_id
 WHERE o.id=p_outbox_id AND o.kind='instagram_message'
   AND o.status='leased' AND o.leased_by=p_worker_id
   AND o.lease_expires_at>now()
   AND m.artist_id=o.artist_id AND m.channel='instagram';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_resolve_instagram_lifecycle_payload(uuid,text)
 FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.service_resolve_instagram_lifecycle_payload(uuid,text)
 TO service_role;

-- A confirmed provider rejection is different from an ambiguous timeout.
-- Wake the SAME automation job for one Email send when it is safe to do so.
CREATE OR REPLACE FUNCTION crm_private.lifecycle_instagram_terminal_email_fallback()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm_private AS $fn$
DECLARE p crm_private.lifecycle_instagram_payloads%rowtype;
 s public.sessions%rowtype;
BEGIN
 IF old.status='dead' OR new.status<>'dead'
   OR new.kind<>'instagram_message'
   OR new.last_error_code NOT IN (
     'instagram_outside_messaging_window','instagram_rejected',
     'instagram_credentials_rejected','instagram_destination_invalid',
     'instagram_account_invalid','instagram_provider_unsupported',
     'instagram_lifecycle_window_closed')
 THEN RETURN new; END IF;
 SELECT * INTO p FROM crm_private.lifecycle_instagram_payloads x
 WHERE x.communication_message_id=new.communication_message_id
   AND x.artist_id=new.artist_id;
 IF NOT FOUND THEN RETURN new; END IF;
 SELECT * INTO s FROM public.sessions x WHERE x.id=p.session_id
 AND x.artist_id=p.artist_id;
 IF NOT FOUND OR s.client_id IS DISTINCT FROM new.client_id
   OR crm_private.lifecycle_selected_channel(s.client_id,p.artist_id)<>'instagram'
   THEN RETURN new; END IF;
 INSERT INTO crm_private.lifecycle_instagram_email_fallbacks(
   job_id,artist_id,client_id,reason,instagram_outbox_id)
 VALUES(p.automation_job_id,p.artist_id,s.client_id,'instagram_rejected',new.id)
 ON CONFLICT(job_id) DO NOTHING;
 UPDATE public.automation_jobs SET status='pending',completed_at=NULL,
  last_error_category='none',updated_at=now()
 WHERE id=p.automation_job_id AND status='completed'
 AND EXISTS(SELECT 1 FROM crm_private.lifecycle_instagram_email_fallbacks f
            WHERE f.job_id=p.automation_job_id AND f.instagram_outbox_id=new.id);
 RETURN new;
END;
$fn$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_instagram_terminal_email_fallback()
 FROM public,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS instagram_lifecycle_terminal_email_fallback ON public.integration_outbox;
CREATE TRIGGER instagram_lifecycle_terminal_email_fallback
 AFTER UPDATE OF status ON public.integration_outbox
 FOR EACH ROW WHEN (new.kind='instagram_message')
 EXECUTE FUNCTION crm_private.lifecycle_instagram_terminal_email_fallback();

CREATE OR REPLACE FUNCTION crm_private.execute_client_lifecycle_job(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_template record;
  v_block_reason text;
  v_to_email text;
  v_subject text;
  v_body text;
  v_message_id uuid;
  v_outbox_id uuid;
  v_actions_required boolean := false;
  v_confirm_token text;
  v_reschedule_token text;
  v_cancel_token text;
  v_block_count integer;
  v_block_dates text;
  v_artist_timezone text;
  v_studio_address text;
  v_aftercare_url text;
  v_expected_members integer;
  v_locked_members integer;
  v_instagram_result text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'client lifecycle execution is backend-only' using errcode = '42501';
  end if;

  select j.* into v_job
  from public.automation_jobs j
  where j.id = p_job_id
  for update;

  if not found
     or v_job.status <> 'pending'::public.automation_job_status
     or v_job.action_type <> 'send_client_message'::public.automation_action_type then
    return 'skipped';
  end if;

  if not crm_private.automations_enabled_for_artist(v_job.artist_id) then
    return 'paused';
  end if;

  -- 0098's mint/apply concurrency contract locks the authoritative session
  -- before the capability row. Keep the lifecycle executor on the same order.
  select s.* into v_session
  from public.sessions s
  where s.id = v_job.session_id
    and s.artist_id = v_job.artist_id
  for update;

  if not found
     or v_session.appointment_type <> v_job.condition_appointment_type then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'appointment_ineligible'
    where id = p_job_id;
    return 'cancelled';
  end if;

  if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h',
      'post_session_aftercare','post_session_checkin')
     and v_session.appointment_type in ('tattoo_session','touch_up') then
    -- Booking/rescheduling uses this same artist advisory lock. Try rather
    -- than wait while holding an appointment row: reschedule locks its row
    -- before acquiring the artist lock, so waiting here could deadlock.
    if not pg_try_advisory_xact_lock(
      hashtextextended('crm:artist-schedule:' || v_job.artist_id::text,0)) then
      return 'pending';
    end if;

    select count(*) into v_expected_members
    from crm_private.session_lifecycle_block(v_session.id);
    -- Cancellation/completion can lock a different day without the schedule
    -- advisory lock. Skip that row and retry on a later tick; after acquiring
    -- every member row, all block decisions and the enqueue share one commit.
    with locked as materialized (
      select s.id from public.sessions s
      join crm_private.session_lifecycle_block(v_session.id) b on b.session_id=s.id
      order by s.id for update of s skip locked
    ) select count(*) into v_locked_members from locked;
    if v_expected_members=0 or v_locked_members<>v_expected_members then
      return 'pending';
    end if;
  end if;

  if v_job.schedule_anchor = 'session_start'::public.automation_schedule_anchor then
    if v_session.status in ('cancelled', 'no_show', 'completed') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'confirmed' then
      return 'pending';
    end if;
  else
    if v_session.status in ('cancelled', 'no_show') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'completed' then
      return 'pending';
    end if;
  end if;

  if v_job.scheduled_at > now() then
    return 'pending';
  end if;

  -- An independently invoked executor must not trust a stale job timestamp
  -- after an appointment is moved. The scheduler normally reconciles this.
  if v_job.schedule_anchor = 'session_start'::public.automation_schedule_anchor
     and v_session.start_at + make_interval(mins => v_job.anchor_offset_minutes) > now() then
    return 'pending';
  end if;
  if v_job.schedule_anchor = 'session_end'::public.automation_schedule_anchor
     and coalesce(v_session.actual_end_at,v_session.end_at) + make_interval(mins => v_job.anchor_offset_minutes) > now() then
    return 'pending';
  end if;

  -- Recheck immediately before materialising a message. Full serialization
  -- against schedule mutation and in-flight delivery is still required.
  if crm_private.lifecycle_block_disposition(p_job_id) not in ('eligible','unmanaged') then
    return 'pending';
  end if;

  -- If an appointment was made late and both windows are already due,
  -- the 24h reminder takes precedence. Never deliver two same-tick
  -- reminders or create competing confirmation capabilities.
  if v_job.message_purpose='session_reminder_72h'
     and exists (
       select 1 from crm_private.booking_card_artist_settings b
       where b.artist_id=v_job.artist_id
         and b.arrival_guide_url is not null
     )
     and v_session.start_at <= now()+interval '24 hours'
     and crm_private.client_send_block_reason(
       v_session.client_id,v_job.message_channel,
       'service'::public.message_classification
     ) is null
     and exists (
       select 1 from public.automation_jobs j24
       where j24.session_id=v_session.id
         and j24.artist_id=v_job.artist_id
         and j24.message_purpose='session_reminder_24h'
         and j24.status='pending'
         and j24.scheduled_at<=now()
     ) then
    update public.automation_jobs
    set status='cancelled',cancelled_at=now(),
        last_error_category='appointment_ineligible'
    where id=p_job_id;
    return 'cancelled';
  end if;

  -- For Instagram, send only inside Meta's standard 24-hour window and
  -- only to a provider-scoped linked contact. Unknown send results never retry.
  if v_job.message_purpose in (
       'session_reminder_72h','session_reminder_24h',
       'post_session_aftercare','post_session_checkin','consultation_reminder')
     and crm_private.lifecycle_selected_channel(
       v_session.client_id,v_job.artist_id)='instagram' then
    if crm_private.lifecycle_instagram_email_fallback_allowed(v_job.id) then
      null;
    elsif exists(select 1 from crm_private.lifecycle_instagram_payloads p
                 where p.automation_job_id=v_job.id) then
      return 'pending'; -- no provider replay after an ambiguous result
    elsif crm_private.lifecycle_instagram_send_ready(
       v_session.client_id,v_job.artist_id) then
      v_instagram_result:=crm_private.queue_lifecycle_instagram_job(p_job_id);
      if v_instagram_result in ('queued','skipped') then
        return v_instagram_result;
      end if;
    end if;
    insert into crm_private.lifecycle_instagram_email_fallbacks (
      job_id,artist_id,client_id,reason
    ) values (v_job.id,v_job.artist_id,v_session.client_id,
      'instagram_unavailable') on conflict(job_id) do nothing;
  end if;

  -- Resolve at the scheduled execution time, not only on enrolment.
  -- A previously recorded one-time fallback must not retry the same WhatsApp
  -- job or create a second provider message.
  if v_job.message_purpose in
       ('session_reminder_72h','session_reminder_24h',
        'post_session_aftercare','post_session_checkin',
        'consultation_reminder')
     and crm_private.lifecycle_selected_channel(
       v_session.client_id,v_job.artist_id)='whatsapp' then
    if crm_private.lifecycle_email_fallback_allowed(v_job.id) then
      null; -- WhatsApp already failed definitively; continue with Email.
    elsif exists (
      select 1 from crm_private.lifecycle_whatsapp_payloads p
      where p.automation_job_id=v_job.id
    ) then
      -- An outbox result is ambiguous or still in flight. Do not duplicate.
      return 'pending';
    elsif crm_private.lifecycle_whatsapp_send_ready(
      v_session.client_id,v_job.artist_id,v_job.message_purpose) then
      return crm_private.queue_lifecycle_whatsapp_job(p_job_id);
    else
      insert into crm_private.lifecycle_email_fallbacks (
        job_id,artist_id,client_id,reason
      ) values (
        v_job.id,v_job.artist_id,v_session.client_id,'whatsapp_unavailable'
      ) on conflict(job_id) do nothing;
    end if;
  end if;

  -- Instagram has no unrestricted unattended provider route. Keep the
  -- existing operational Email reminder rather than silently dropping it.

  select lower(btrim(c.email)) into v_to_email
  from public.clients c
  where c.id = v_session.client_id
    and c.archived_at is null
    and c.email is not null
    and btrim(c.email) <> '';

  if v_to_email is null then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'destination_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  select t.id, t.purpose, t.version, t.subject, t.body, p.classification
    into v_template
  from public.message_templates t
  join public.artists a on a.id = v_job.artist_id
  join public.message_template_purposes p on p.purpose = t.purpose
  where t.workspace_id = a.workspace_id
    and (t.artist_id = v_job.artist_id or t.artist_id is null)
    and t.purpose = v_job.message_purpose
    and t.channel = v_job.message_channel
    and t.locale = v_job.message_locale
    and t.status = 'active'
  order by (t.artist_id is not null) desc, t.version desc, t.id
  limit 1;

  if v_template.id is null or v_template.classification <> 'service'::public.message_classification then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  v_block_reason := crm_private.client_send_block_reason(
    v_session.client_id,
    v_job.message_channel,
    v_template.classification
  );

  if v_block_reason is not null then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'client_blocked'
    where id = p_job_id;
    return 'blocked';
  end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_job.artist_id
      and i.integration_type = 'email'::public.artist_integration_type
      and i.provider = 'google'
      and i.is_enabled
      and i.external_account_label is not null
      and btrim(i.external_account_label) <> ''
  ) then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'integration_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  -- A lifecycle retry that already materialised its email must reuse the exact
  -- stored body. Minting again here would invalidate links already present in
  -- that idempotent message.
  select m.id into v_message_id
  from public.email_messages m
  where m.automation_job_id = v_job.id;

  -- Workspace defaults opt into action links by carrying all three catalogued
  -- variables. Artist-authored overrides that carry none remain valid ordinary
  -- reminders. A partial opt-in fails closed rather than creating an email with
  -- a missing or ambiguous action.
  if position('{{confirm_link}}' in coalesce(v_template.subject, '')) > 0
     or position('{{reschedule_link}}' in coalesce(v_template.subject, '')) > 0
     or position('{{cancel_link}}' in coalesce(v_template.subject, '')) > 0 then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  -- Preserve old three-action templates for already scheduled jobs, but
  -- enable the reviewed action shapes: 72h C+R, 24h R, consultation C+R.
  v_actions_required := v_template.purpose in (
      'session_reminder_72h',
      'session_reminder_24h',
      'consultation_reminder'
    )
    and (
      position('{{confirm_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{reschedule_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{cancel_link}}' in coalesce(v_template.body, '')) > 0
    );

  if v_actions_required and not (
    (
      v_template.purpose='session_reminder_72h'
      and position('{{confirm_link}}' in v_template.body)>0
      and position('{{reschedule_link}}' in v_template.body)>0
      and position('{{cancel_link}}' in v_template.body)=0
    ) or (
      v_template.purpose='session_reminder_24h'
      and position('{{reschedule_link}}' in v_template.body)>0
      and (
        (position('{{confirm_link}}' in v_template.body)=0
         and position('{{cancel_link}}' in v_template.body)=0)
        or
        (position('{{confirm_link}}' in v_template.body)>0
         and position('{{cancel_link}}' in v_template.body)>0)
      )
    ) or (
      v_template.purpose='consultation_reminder'
      and position('{{confirm_link}}' in v_template.body)>0
      and position('{{reschedule_link}}' in v_template.body)>0
      -- Legacy 3-action consultation messages are still valid for fallback.
    )
  ) then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  if v_message_id is null then
    v_subject := crm_private.render_lifecycle_template_text(v_template.subject, v_session.id);

    if v_actions_required then
      -- Validate all ordinary variables before minting a real capability set.
      v_body := crm_private.render_lifecycle_action_template_text(
        v_template.body,
        v_session.id,
        repeat('a', 64),
        repeat('b', 64),
        repeat('c', 64)
      );
    else
      v_body := crm_private.render_lifecycle_template_text(v_template.body, v_session.id);
    end if;

    if v_subject is null or btrim(v_subject) = ''
       or v_body is null or btrim(v_body) = '' then
      update public.automation_jobs
      set status = 'failed', attempt_count = attempt_count + 1,
          last_error_category = 'template_unavailable'
      where id = p_job_id;
      return 'failed';
    end if;
  end if;

  begin
    if v_message_id is null then
      if v_actions_required then
        select
          max(x.raw_token) filter (where x.action = 'confirm_attendance'::public.appointment_client_action),
          max(x.raw_token) filter (where x.action = 'request_reschedule'::public.appointment_client_action),
          max(x.raw_token) filter (where x.action = 'cancel'::public.appointment_client_action)
        into v_confirm_token, v_reschedule_token, v_cancel_token
        from crm_private.issue_appointment_client_actions(v_session.id) x;

        if v_confirm_token is null or v_confirm_token !~ '^[0-9a-f]{64}$'
           or v_reschedule_token is null or v_reschedule_token !~ '^[0-9a-f]{64}$'
           or v_cancel_token is null or v_cancel_token !~ '^[0-9a-f]{64}$' then
          raise exception 'appointment action capability issuance failed'
            using errcode = '23514';
        end if;

        -- Group snapshots are issued only for an exposed confirmation URL.
        -- The legacy 24h three-link email remains supported during rollout.
        if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h')
           and position('{{confirm_link}}' in v_template.body)>0 then
          perform crm_private.register_lifecycle_confirmation(v_confirm_token,v_session.id);
        end if;

        v_body := crm_private.render_lifecycle_action_template_text(
          v_template.body,
          v_session.id,
          v_confirm_token,
          v_reschedule_token,
          v_cancel_token
        );

        if v_body is null or btrim(v_body) = '' then
          raise exception 'appointment action rendering failed'
            using errcode = '23514';
        end if;
      end if;

      if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h') then
        select a.timezone into v_artist_timezone from public.artists a where a.id=v_job.artist_id;
        select count(*)::integer, string_agg(
          to_char(b.start_at at time zone v_artist_timezone,'FMDay, FMDD FMMonth YYYY')
            || ' at ' || to_char(b.start_at at time zone v_artist_timezone,'HH24:MI'),
          E'\n' order by b.start_at,b.session_id)
        into v_block_count,v_block_dates from crm_private.session_lifecycle_block(v_session.id) b;
        if v_block_count>1 then
          v_body := v_body || E'\n\nYour appointment dates:\n' || v_block_dates
            || E'\n\nIf a deposit applies, the 72-hour cancellation period is calculated separately for each appointment date.';
        end if;
        if v_job.message_purpose='session_reminder_24h' then
          select nullif(btrim(c.studio_address),'') into v_studio_address
          from crm_private.booking_card_artist_settings c where c.artist_id=v_job.artist_id
            and (c.appointment_start_from is null or v_session.start_at>=c.appointment_start_from);
          if v_studio_address is not null then
            v_body := v_body || E'\n\nStudio address: ' || v_studio_address;
          end if;
        end if;
      end if;

      if v_job.message_purpose='post_session_checkin' then
        select substring(t.body from 'https://[a-z0-9.-]+/aftercare/') into v_aftercare_url
        from public.message_templates t
        join public.artists a on a.id=v_job.artist_id
        where t.workspace_id=a.workspace_id and (t.artist_id=a.id or t.artist_id is null)
          and t.purpose='post_session_aftercare' and t.channel='email'
          and t.locale=v_job.message_locale and t.status='active'
        order by (t.artist_id is not null) desc,t.version desc,t.id limit 1;
        if v_aftercare_url is null then
          raise exception 'approved artist aftercare link is unavailable' using errcode='23514';
        end if;
        v_body := v_body || E'\n\nYour aftercare guide: ' || v_aftercare_url;
      end if;

      insert into public.email_messages (
        status, artist_id, client_id, enquiry_id, project_id,
        to_email, subject, body,
        template_key, template_version,
        created_by, created_by_kind, approved_by, approved_at,
        automation_job_id
      ) values (
        'approved', v_job.artist_id, v_session.client_id,
        v_session.enquiry_id, v_session.project_id,
        v_to_email, v_subject, v_body,
        v_template.purpose, v_template.version,
        null, 'system', null, now(),
        v_job.id
      )
      on conflict do nothing
      returning id into v_message_id;

      if v_message_id is null then
        select m.id into v_message_id
        from public.email_messages m
        where m.automation_job_id = v_job.id;
      end if;
    end if;

    if v_message_id is null then
      raise exception 'lifecycle email idempotency could not resolve a message';
    end if;

    v_outbox_id := crm_private.enqueue_outbox(
      'approved_email',
      'email:automation:' || v_job.id::text,
      jsonb_build_object('email_message_id', v_message_id),
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      v_message_id
    );

    update public.automation_jobs
    set status = 'completed', completed_at = now(),
        attempt_count = attempt_count + 1,
        last_error_category = 'none'
    where id = p_job_id;

    perform crm_private.log_artist_activity(
      v_job.artist_id,
      'email.automation_queued',
      'system',
      null,
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      null,
      jsonb_build_object(
        'automation_job_id', v_job.id,
        'email_message_id', v_message_id,
        'purpose', v_template.purpose
      )
    );
  exception when others then
    -- The exception block is a PostgreSQL subtransaction. Any capability set
    -- minted above is rolled back before the failed job state is recorded.
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'unknown'
    where id = p_job_id;
    return 'failed';
  end;

  return 'queued';
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.guard_lifecycle_email_conversation_channel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare v_channel text;
begin
  if new.automation_job_id is null or new.template_key not in
    ('session_reminder_72h','session_reminder_24h',
     'post_session_aftercare','post_session_checkin') then return new; end if;
  v_channel:=crm_private.lifecycle_selected_channel(new.client_id,new.artist_id);
  if v_channel='whatsapp'
     and not crm_private.lifecycle_email_fallback_allowed(new.automation_job_id) then
    raise exception 'lifecycle WhatsApp utility template is unavailable'
      using errcode='23514';
  end if;
  if v_channel='instagram'
     and not crm_private.lifecycle_instagram_email_fallback_allowed(new.automation_job_id) then
    raise exception 'Instagram lifecycle send is pending or unconfirmed'
      using errcode='23514';
  end if;
  return new;
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

  -- Accept only the exact one-time capability sent to this same provider
  -- participant, whether it came from a booking card or a reminder.
  select true into v_valid
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id=t.session_id
  where t.token_hash=v_hash AND t.consumed_at IS NULL
    AND t.invalidated_at IS NULL AND t.expires_at>now()
    AND t.session_calendar_version=s.calendar_version
    AND s.artist_id=p_artist_id AND s.status='confirmed'
    AND s.start_at>now()
    AND (
      EXISTS(
        SELECT 1 FROM crm_private.booking_card_instagram_payloads p
        JOIN public.communication_messages m ON m.id=p.communication_message_id
        JOIN public.communication_conversations c ON c.id=m.conversation_id
        WHERE p.booking_card_id=t.booking_card_id
          AND crm_private.booking_group_card_valid(t.booking_card_id)
          AND p_payload IN (p.confirm_payload,p.reschedule_payload,p.cancel_payload)
          AND c.artist_id=p_artist_id AND c.channel='instagram'
          AND c.integration_key=p_integration_key
          AND c.external_contact_id=p_external_contact_id)
      OR EXISTS(
        SELECT 1 FROM crm_private.lifecycle_instagram_payloads p
        JOIN public.communication_messages m ON m.id=p.communication_message_id
        JOIN public.communication_conversations c ON c.id=m.conversation_id
        WHERE p.session_id=t.session_id AND p.artist_id=p_artist_id
          AND p.purpose IN ('session_reminder_24h','consultation_reminder')
          AND p_payload IN (p.confirm_payload,p.reschedule_payload,p.cancel_payload)
          AND c.artist_id=p_artist_id AND c.channel='instagram'
          AND c.integration_key=p_integration_key
          AND c.external_contact_id=p_external_contact_id)
    );

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

-- Four-argument booking-card send functions are new overloads and would
-- otherwise inherit PostgreSQL's default PUBLIC EXECUTE permission.
REVOKE ALL ON FUNCTION crm_private.create_booking_card_instagram(uuid,text,text,text)
 FROM public,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION crm_private.queue_booking_card_instagram(uuid,text,text,text)
 FROM public,anon,authenticated,service_role;
