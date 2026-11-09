-- Six WhatsApp Meta-reviewed Utility templates: sender contract + fail-closed rollout.
-- Old v1/v2 parameters remain supported for messages already enqueued.
-- Production promotion requires six real recent Meta approvals and an empty old outbox.

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
    v_parameters := case when v_template_name='booking_card_tattoo_v2'
      then jsonb_build_array(v_first_name,v_date,v_time,v_deposit,
                            'Remaining balance on the day',v_remaining)
      else jsonb_build_array(v_first_name,v_artist.display_name,v_date,
                             v_time,v_deposit,v_remaining) end;
    v_body :=
      case when v_grouped then 'Your ' || v_group.session_count || ' tattoo sessions are booked. ' else 'Your tattoo session is booked. ' end
      || 'Deposit paid: ' || v_deposit
      || '. Remaining balance: ' || v_remaining || '.';
  elsif v_card.card_kind = 'consultation_booked' then
    v_template_name := case when v_card.appointment_type = 'video_consultation'::public.appointment_type
      then v_settings.whatsapp_video_template_name
      else v_settings.whatsapp_consultation_template_name end;
    if v_card.appointment_type = 'video_consultation'::public.appointment_type
       and v_settings.whatsapp_video_template_status is distinct from 'APPROVED' then
      return null;
    end if;
    v_parameters := case when v_template_name in (
      'booking_card_consultation_v2','booking_card_video_consultation_v2')
      then jsonb_build_array(v_first_name,v_date,v_time)
      else jsonb_build_array(v_first_name,v_artist.display_name,v_date,v_time)
    end;
    v_body := case when v_card.appointment_type = 'video_consultation'::public.appointment_type then 'Your video consultation is booked.' else 'Your consultation is booked.' end;
  else
    return null;
  end if;

  if v_template_name is null then
    return null;
  end if;
  -- A reviewed template must remain Meta-approved for this exact artist
  -- and matching purpose, even if a separate settings poll drifts.
  if v_template_name in (
    'booking_card_tattoo_v2','booking_card_consultation_v2',
    'booking_card_video_consultation_v2'
  ) and not exists (
    select 1 from crm_private.whatsapp_template_proposals p
    where p.artist_id=v_card.artist_id and p.template_name=v_template_name
      and p.kind=case
        when v_template_name='booking_card_tattoo_v2' then 'booking_tattoo'
        when v_template_name='booking_card_consultation_v2' then 'booking_consultation'
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


CREATE OR REPLACE FUNCTION crm_private.queue_lifecycle_whatsapp_job(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  j public.automation_jobs%rowtype;
  s public.sessions%rowtype;
  a public.artists%rowtype;
  t crm_private.lifecycle_whatsapp_template_registry%rowtype;
  conv public.communication_conversations%rowtype;
  v_conversation_id uuid;
  v_active_route_count integer;
  v_members jsonb;
  v_first text;
  v_dates text;
  v_url text;
  v_address text;
  v_map_url text;
  v_action_base text;
  v_params jsonb;
  v_message_id uuid;
  v_token text;
  v_reschedule_token text;
  v_cancel_token text;
  v_outbox_id uuid;
  v_body text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'lifecycle WhatsApp enqueue is backend-only' using errcode='42501';
  end if;
  select * into j from public.automation_jobs where id=p_job_id for update;
  if not found or j.status<>'pending' or j.message_purpose not in
    ('session_reminder_72h','session_reminder_24h',
     'post_session_aftercare','post_session_checkin',
     'consultation_reminder') then return 'skipped'; end if;
  select * into s from public.sessions where id=j.session_id and artist_id=j.artist_id;
  select * into a from public.artists where id=j.artist_id and is_active;
  if s.id is null or a.id is null
     or crm_private.lifecycle_block_disposition(j.id) not in ('eligible','unmanaged')
  then return 'pending'; end if;
  -- A template can be approved while this artist's rollout is still off.
  -- Keep a near-due job pending rather than changing its channel or losing
  -- it permanently. An overdue message becomes an actionable failed job
  -- instead of being back-sent to a client days later.
  if not exists (
    select 1 from crm_private.lifecycle_whatsapp_delivery_gates g
    where g.artist_id=j.artist_id and g.enabled
  ) then
    if j.scheduled_at<now()-interval '15 minutes' then
      update public.automation_jobs set status='failed',
        attempt_count=attempt_count+1,
        last_error_category='integration_unavailable' where id=j.id;
      return 'failed';
    end if;
    return 'pending';
  end if;
  if crm_private.client_send_block_reason(s.client_id,'whatsapp','service') is not null then
    update public.automation_jobs set status='cancelled',cancelled_at=now(),
      last_error_category='client_blocked' where id=j.id;
    return 'blocked';
  end if;
  select * into t from crm_private.lifecycle_whatsapp_template_registry
  where artist_id=j.artist_id and purpose=j.message_purpose
    and approval_status='APPROVED' and provider_template_id is not null
    and verified_at>now()-interval '24 hours';
  if not found then
    update public.automation_jobs set status='failed',attempt_count=attempt_count+1,
      last_error_category='integration_unavailable' where id=j.id;
    return 'failed';
  end if;

  select c.id into v_conversation_id
  from public.communication_conversations c
  where c.client_id=s.client_id and c.artist_id=j.artist_id
    and c.channel='whatsapp' and c.link_state='linked' and c.state='open'
  order by c.last_message_at desc nulls last,c.created_at desc,c.id
  limit 1;
  select * into conv from public.communication_conversations c
  where c.id=v_conversation_id and c.artist_id=j.artist_id
    and c.client_id=s.client_id and c.channel='whatsapp'
    and c.link_state='linked' and c.state='open'
  for update;
  if not found then
    update public.automation_jobs set status='failed',attempt_count=attempt_count+1,
      last_error_category='destination_unavailable' where id=j.id;
    return 'failed';
  end if;

  select count(*) into v_active_route_count
  from public.artist_integrations i
  where i.artist_id=j.artist_id and i.integration_type='whatsapp'
    and i.provider='meta_cloud_api' and i.is_enabled
    and i.integration_key=conv.integration_key;
  if v_active_route_count<>1 then
    update public.automation_jobs set status='failed',attempt_count=attempt_count+1,
      last_error_category='integration_unavailable' where id=j.id;
    return 'failed';
  end if;

  select nullif(split_part(btrim(c.full_name),' ',1),'') into v_first
  from public.clients c where c.id=s.client_id and c.archived_at is null;
  v_members:=case when j.message_purpose='consultation_reminder'
    then jsonb_build_array(jsonb_build_object(
      'id',s.id,'version',s.calendar_version,'start',s.start_at,
      'end',s.end_at,'actual_end',s.actual_end_at,'status',s.status))
    else crm_private.lifecycle_email_members(s.id,j.message_purpose) end;
  if v_first is null or jsonb_array_length(v_members)=0 then
    update public.automation_jobs set status='failed',attempt_count=attempt_count+1,
      last_error_category='destination_unavailable' where id=j.id;
    return 'failed';
  end if;
  if j.message_purpose in ('session_reminder_72h','session_reminder_24h') then
    select string_agg(
      to_char(b.start_at at time zone a.timezone,'FMDD FMMonth YYYY HH24:MI'),
      ', ' order by b.start_at,b.session_id
    ) into v_dates from crm_private.session_lifecycle_block(s.id) b;
    if nullif(v_dates,'') is null or char_length(v_dates)>1024 then
      raise exception 'invalid grouped lifecycle dates' using errcode='23514';
    end if;
    v_params:=jsonb_build_array(v_first,a.display_name,v_dates);
    if j.message_purpose='session_reminder_72h'
       and t.template_name='vishar_lifecycle_reminder_72h_v3' then
      select max(x.raw_token) filter (where x.action='confirm_attendance'),
             max(x.raw_token) filter (where x.action='request_reschedule')
        into v_token,v_reschedule_token
      from crm_private.issue_appointment_client_actions(s.id) x;
      if v_token is null or v_reschedule_token is null
         or v_token=v_reschedule_token then
        raise exception '72h action capability unavailable' using errcode='23514';
      end if;
      perform crm_private.register_lifecycle_confirmation(v_token,s.id);
      v_params:=jsonb_build_array(v_first,v_dates,
        'booking_action:'||v_token,'booking_action:'||v_reschedule_token);
    end if;
    if j.message_purpose='session_reminder_24h' then
      if t.template_name='vishar_lifecycle_reminder_24h_v3' then
        select max(x.raw_token) filter (where x.action='request_reschedule')
          into v_reschedule_token
        from crm_private.issue_appointment_client_actions(s.id) x;
        if v_reschedule_token is null then
          raise exception '24h reschedule capability unavailable' using errcode='23514';
        end if;
        v_params:=jsonb_build_array(v_first,
          to_char(s.start_at at time zone a.timezone,'HH24:MI'),
          'booking_action:'||v_reschedule_token);
      else
      select nullif(btrim(c.studio_address),''),
             nullif(btrim(c.studio_map_url),''),
             nullif(btrim(c.client_action_base_url),'')
        into v_address,v_map_url,v_action_base
      from crm_private.booking_card_artist_settings c
      where c.artist_id=j.artist_id
        and (c.appointment_start_from is null or s.start_at>=c.appointment_start_from)
      limit 1;
      if v_address is null then
        raise exception 'lifecycle studio address unavailable' using errcode='23514';
      end if;
      -- Meta 24h body parameter {{4}} carries both the street address and
      -- its Google Maps link. The approved template text/arity are unchanged.
      v_address:=crm_private.lifecycle_whatsapp_location_with_map(v_address,v_map_url);
      -- One token confirms the whole current block; all capability writes
      -- roll back atomically if the WhatsApp outbox cannot be queued.
      select max(x.raw_token) filter (where x.action='confirm_attendance'),
             max(x.raw_token) filter (where x.action='request_reschedule'),
             max(x.raw_token) filter (where x.action='cancel')
      into v_token,v_reschedule_token,v_cancel_token
      from crm_private.issue_appointment_client_actions(s.id) x;
      if v_token is null or v_reschedule_token is null or v_cancel_token is null then
        raise exception 'lifecycle confirmation capability unavailable' using errcode='23514';
      end if;
      perform crm_private.register_lifecycle_confirmation(v_token,s.id);
      v_url:=crm_private.lifecycle_whatsapp_confirmation_url(v_action_base,v_token);
      if nullif(v_url,'') is null or v_url !~ '^https://' or char_length(v_url)>1024 then
        raise exception 'lifecycle confirmation URL unavailable' using errcode='23514';
      end if;
      v_params:=v_params||jsonb_build_array(v_address,v_url);
      end if;
    end if;
  elsif j.message_purpose='consultation_reminder' then
    if s.appointment_type not in ('in_person_consultation','video_consultation') then
      raise exception 'consultation type mismatch' using errcode='23514';
    end if;
    v_dates:=to_char(s.start_at at time zone a.timezone,
                     'FMDay, FMDD FMMonth YYYY HH24:MI');
    if s.appointment_type='in_person_consultation' then
      -- In-person WhatsApp consultation reminders must use the same
      -- current studio as in-person consultation Gmail reminders.
      -- Tattoo-session cards/reminders keep their own artist settings.
      select nullif(concat_ws(', ',nullif(btrim(loc.studio_name),''),
                                     nullif(btrim(loc.studio_address),'')),''),
             nullif(btrim(loc.studio_map_url),'')
        into v_address,v_map_url
      from crm_private.consultation_email_location() loc;
      select nullif(btrim(c.client_action_base_url),'') into v_action_base
      from crm_private.booking_card_artist_settings c
      where c.artist_id=j.artist_id
        and (c.appointment_start_from is null or s.start_at>=c.appointment_start_from)
      limit 1;
      -- Only in-person consultations receive a map; video calls keep the
      -- existing 'no studio visit' parameter and approved template.
      v_address:=crm_private.lifecycle_whatsapp_location_with_map(v_address,v_map_url);
    else
      v_address:='Video consultation: no studio visit';
      select nullif(btrim(c.client_action_base_url),'') into v_action_base
      from crm_private.booking_card_artist_settings c
      where c.artist_id=j.artist_id
        and (c.appointment_start_from is null or s.start_at>=c.appointment_start_from)
      limit 1;
    end if;
    select max(x.raw_token) filter (where x.action='confirm_attendance'),
           max(x.raw_token) filter (where x.action='request_reschedule'),
           max(x.raw_token) filter (where x.action='cancel')
      into v_token,v_reschedule_token,v_cancel_token
    from crm_private.issue_appointment_client_actions(s.id) x;
    if v_token is null or v_reschedule_token is null or v_cancel_token is null then
      raise exception 'consultation action capability unavailable' using errcode='23514';
    end if;
    v_url:=crm_private.lifecycle_whatsapp_confirmation_url(v_action_base,v_token);
    if v_url is null or v_url !~ '^https://' or char_length(v_url)>1024
       or nullif(v_address,'') is null then
      raise exception 'consultation parameters unavailable' using errcode='23514';
    end if;
    -- For v3, the final two private parameters are one-use WhatsApp quick
    -- reply capabilities. The provider sees only parameters 1-3 as body text.
    -- V1/V2 keep exactly their original five Meta body parameters.
    if t.template_name in ('vishar_lifecycle_consultation_v3',
                           'vishar_lifecycle_consultation_v4') then
      v_params:=jsonb_build_array(
        v_first,v_dates,v_address,
        'booking_action:'||v_token,'booking_action:'||v_reschedule_token);
    else
      v_params:=jsonb_build_array(v_first,a.display_name,v_dates,v_address,v_url);
    end if;
  else
    select substring(tmpl.body from 'https://[a-z0-9.-]+/aftercare/')
      into v_url
    from public.message_templates tmpl
    join public.artists at on at.id=j.artist_id
    where tmpl.workspace_id=at.workspace_id
      and (tmpl.artist_id=at.id or tmpl.artist_id is null)
      and tmpl.purpose='post_session_aftercare' and tmpl.channel='email'
      and tmpl.locale=j.message_locale and tmpl.status='active'
    order by (tmpl.artist_id is not null) desc,tmpl.version desc,tmpl.id
    limit 1;
    if v_url is null then
      raise exception 'approved aftercare URL unavailable' using errcode='23514';
    end if;
    v_params:=jsonb_build_array(v_first,a.display_name,v_url);
  end if;

  if exists (select 1 from crm_private.lifecycle_whatsapp_payloads p
    where p.automation_job_id=j.id) then
    return 'skipped';
  end if;

  begin
    v_body:='Automatic tattoo appointment update ('||j.message_purpose||')';
    insert into public.communication_messages(
      conversation_id,artist_id,channel,direction,origin,status,
      message_type,body,created_by)
    values(conv.id,j.artist_id,'whatsapp','outbound','automation',
      'queued','template',v_body,null)
    returning id into v_message_id;
    insert into crm_private.lifecycle_whatsapp_payloads(
      automation_job_id,communication_message_id,artist_id,session_id,
      purpose,template_name,template_language,body_parameters,members
    ) values (
      j.id,v_message_id,j.artist_id,s.id,
      j.message_purpose,t.template_name,t.template_language,
      v_params,v_members
    );
    insert into public.integration_outbox(
      kind,dedupe_key,payload,artist_id,client_id,enquiry_id,
      project_id,session_id,communication_message_id)
    values('whatsapp_message','whatsapp:lifecycle:'||j.id::text,
      jsonb_build_object('communication_message_id',v_message_id),
      j.artist_id,s.client_id,s.enquiry_id,s.project_id,null,v_message_id)
    on conflict(dedupe_key) do nothing returning id into v_outbox_id;
    if v_outbox_id is null then
      raise exception 'lifecycle WhatsApp outbox collision' using errcode='23514';
    end if;
    update public.automation_jobs set status='completed',completed_at=now(),
      attempt_count=attempt_count+1,last_error_category='none'
    where id=j.id;
    perform crm_private.log_artist_activity(
      j.artist_id,'whatsapp.lifecycle_queued','system',null,
      s.client_id,s.enquiry_id,s.project_id,s.id,null,
      jsonb_build_object('automation_job_id',j.id,
        'communication_message_id',v_message_id,'purpose',j.message_purpose)
    );
  exception when others then
    -- Subtransaction rolls back minted confirmation tokens, message and
    -- outbox; one visible retryable failure remains, never a partial send.
    update public.automation_jobs set status='failed',attempt_count=attempt_count+1,
      last_error_category='unknown' where id=j.id;
    return 'failed';
  end;
  return 'queued';
end;
$function$;


-- Promote six reviewed, Meta-approved WhatsApp templates for Vladimir only.
-- No production messages, clients, sessions, outbox rows or tokens are created here.
-- Kristina stays disabled until her Cloud API Coexistence succeeds.
CREATE OR REPLACE FUNCTION crm_private.activate_reviewed_whatsapp_six(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,crm_private
AS $activate$
DECLARE v_count integer; v_changed integer;
BEGIN
  IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
     OR NOT EXISTS (SELECT 1 FROM public.artists a
                    WHERE a.id=p_artist_id AND a.slug='vladimir')
  THEN RAISE EXCEPTION 'unapproved WhatsApp rollout artist' USING errcode='42501'; END IF;

  -- Both message production paths read one of these tables. Exclusive locks
  -- wait for all old enqueues to commit and then block new enqueues until the
  -- provider-approved six-template switch is committed atomically.
  LOCK TABLE crm_private.lifecycle_whatsapp_template_registry IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE crm_private.booking_card_artist_settings IN ACCESS EXCLUSIVE MODE;
  PERFORM 1 FROM crm_private.whatsapp_template_proposals p
    WHERE p.artist_id=p_artist_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM crm_private.booking_card_artist_settings s
    WHERE s.artist_id=p_artist_id AND s.whatsapp_enabled
      AND s.whatsapp_tattoo_template_name='booking_card_tattoo_v2'
      AND s.whatsapp_consultation_template_name='booking_card_consultation_v2'
      AND s.whatsapp_video_template_name='booking_card_video_consultation_v2'
  ) AND (SELECT count(*) FROM crm_private.lifecycle_whatsapp_template_registry r
    WHERE r.artist_id=p_artist_id
      AND (r.purpose,r.template_name) IN (
        ('session_reminder_72h','vishar_lifecycle_reminder_72h_v3'),
        ('session_reminder_24h','vishar_lifecycle_reminder_24h_v3'),
        ('consultation_reminder','vishar_lifecycle_consultation_v4')
      ))=3 THEN RETURN 'already_active'; END IF;

  -- The six identities are fixed in source. Real provider IDs and recent
  -- approvals must already exist; CI fixtures have none and stay unchanged.
  SELECT count(*) INTO v_count
  FROM (VALUES
    ('booking_tattoo','booking_card_tattoo_v2'),
    ('booking_consultation','booking_card_consultation_v2'),
    ('booking_video','booking_card_video_consultation_v2'),
    ('reminder_72h','vishar_lifecycle_reminder_72h_v3'),
    ('reminder_24h','vishar_lifecycle_reminder_24h_v3'),
    ('reminder_consultation','vishar_lifecycle_consultation_v4')
  ) AS expected(kind,name)
  JOIN crm_private.whatsapp_template_proposals p
    ON p.artist_id=p_artist_id AND p.kind=expected.kind
    AND p.template_name=expected.name AND p.template_language='en_GB'
    AND p.approval_status='APPROVED'
    AND p.provider_template_id~'^[0-9]{5,32}$'
    AND p.verified_at>now()-interval '24 hours';
  IF v_count<>6 THEN RETURN 'waiting_for_meta_approval'; END IF;

  SELECT count(*) INTO v_count
  FROM crm_private.booking_card_artist_settings s
  WHERE s.artist_id=p_artist_id AND s.whatsapp_enabled
    AND s.whatsapp_template_language='en_GB'
    AND s.whatsapp_tattoo_template_name='booking_card_tattoo_v1'
    AND s.whatsapp_consultation_template_name='booking_card_consultation_v1'
    AND s.whatsapp_video_template_name='booking_card_video_consultation_v1'
    AND s.whatsapp_tattoo_template_status='APPROVED'
    AND s.whatsapp_consultation_template_status='APPROVED'
    AND s.whatsapp_video_template_status='APPROVED'
    AND s.arrival_guide_url ~ '^https://[a-z0-9.-]+/arrival/[0-9a-f]{32}/$'
    AND s.preparation_guide_url ~ '^https://[a-z0-9.-]+/faq/$'
    AND split_part(s.arrival_guide_url,'/',3)
        =split_part(s.preparation_guide_url,'/',3);
  IF v_count<>1 THEN RAISE EXCEPTION 'booking template settings drifted'
    USING errcode='23514'; END IF;

  SELECT count(*) INTO v_count
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE r.artist_id=p_artist_id AND r.approval_status='APPROVED'
    AND r.template_language='en_GB' AND r.provider_template_id IS NOT NULL
    AND (r.purpose,r.template_name) IN (
      ('session_reminder_72h','vishar_lifecycle_reminder_72h_v2'),
      ('session_reminder_24h','vishar_lifecycle_reminder_24h_v2'),
      ('consultation_reminder','vishar_lifecycle_consultation_v2')
    );
  IF v_count<>3 THEN RAISE EXCEPTION 'lifecycle template registry drifted'
    USING errcode='23514'; END IF;

  IF EXISTS (
    SELECT 1 FROM crm_private.booking_card_whatsapp_payloads p
    JOIN public.integration_outbox o
      ON o.communication_message_id=p.communication_message_id
    WHERE o.status IN ('pending'::public.outbox_status,'leased'::public.outbox_status)
      AND p.template_name IN ('booking_card_tattoo_v1',
        'booking_card_consultation_v1','booking_card_video_consultation_v1')
  ) OR EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_payloads p
    JOIN public.integration_outbox o
      ON o.communication_message_id=p.communication_message_id
    WHERE p.artist_id=p_artist_id
      AND p.purpose IN ('session_reminder_72h','session_reminder_24h',
                        'consultation_reminder')
      AND o.status IN ('pending'::public.outbox_status,'leased'::public.outbox_status)
  ) THEN
    RAISE EXCEPTION 'old WhatsApp outbox still in flight' USING errcode='23514';
  END IF;

  UPDATE crm_private.booking_card_artist_settings s SET
    whatsapp_tattoo_template_name='booking_card_tattoo_v2',
    whatsapp_consultation_template_name='booking_card_consultation_v2',
    whatsapp_video_template_name='booking_card_video_consultation_v2',
    whatsapp_tattoo_template_status='APPROVED',
    whatsapp_consultation_template_status='APPROVED',
    whatsapp_video_template_status='APPROVED',
    whatsapp_template_checked_at=now(),whatsapp_video_template_checked_at=now(),
    whatsapp_template_last_error_code=NULL,updated_at=now()
  WHERE s.artist_id=p_artist_id;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 THEN RAISE EXCEPTION 'booking promotion count drifted'
    USING errcode='23514'; END IF;

  UPDATE crm_private.lifecycle_whatsapp_template_registry r SET
    template_name=p.template_name,template_language=p.template_language,
    approval_status=p.approval_status,provider_template_id=p.provider_template_id,
    verified_at=p.verified_at,next_retry_at=NULL,last_failure_code=NULL,updated_at=now()
  FROM crm_private.whatsapp_template_proposals p
  WHERE r.artist_id=p_artist_id AND p.artist_id=r.artist_id
    AND (r.purpose,p.kind) IN (
      ('session_reminder_72h','reminder_72h'),
      ('session_reminder_24h','reminder_24h'),
      ('consultation_reminder','reminder_consultation')
    ) AND p.approval_status='APPROVED';
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>3 THEN RAISE EXCEPTION 'reminder promotion count drifted'
    USING errcode='23514'; END IF;
  RETURN 'activated';
END;
$activate$;

REVOKE ALL ON FUNCTION crm_private.activate_reviewed_whatsapp_six(uuid)
 FROM PUBLIC,anon,authenticated,service_role;

SELECT crm_private.activate_reviewed_whatsapp_six(
 'a1111111-1111-4111-8111-111111111111'::uuid
);
