-- Include the configured Google Maps link in the EXISTING address parameter
-- for 24-hour tattoo reminders and in-person consultations. No Meta template
-- edit, no new template variable, no messages or appointments are generated.
-- The map URL comes from artist-scoped booking settings for the booking date.
-- A missing/malformed/overlong URL falls back to the original street address.
CREATE OR REPLACE FUNCTION crm_private.lifecycle_whatsapp_location_with_map(
  p_address text,p_map_url text
) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,public,crm_private
AS $map$
  SELECT CASE WHEN nullif(btrim(p_address),'') IS NOT NULL
     AND nullif(btrim(p_map_url),'') IS NOT NULL
     AND btrim(p_map_url) ~ '^https://((www[.])?google[.]com/maps/|maps[.]app[.]goo[.]gl/[A-Za-z0-9])'
     AND btrim(p_map_url) !~ '[[:space:]]'
     AND char_length(p_address)+char_length(E'\\nGoogle Maps: ')+char_length(btrim(p_map_url))<=1024
    THEN p_address || E'\\nGoogle Maps: ' || btrim(p_map_url)
    ELSE p_address END;
$map$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_whatsapp_location_with_map(text,text)
 FROM public,anon,authenticated,service_role;

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
    if j.message_purpose='session_reminder_24h' then
      select nullif(btrim(c.studio_address),''),
             nullif(btrim(c.studio_map_url),'')
        into v_address,v_map_url
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
      v_url:=crm_private.render_lifecycle_action_template_text(
        '{{confirm_link}}',s.id,v_token,v_reschedule_token,v_cancel_token);
      if nullif(v_url,'') is null or v_url !~ '^https://' or char_length(v_url)>1024 then
        raise exception 'lifecycle confirmation URL unavailable' using errcode='23514';
      end if;
      v_params:=v_params||jsonb_build_array(v_address,v_url);
    end if;
  elsif j.message_purpose='consultation_reminder' then
    if s.appointment_type not in ('in_person_consultation','video_consultation') then
      raise exception 'consultation type mismatch' using errcode='23514';
    end if;
    v_dates:=to_char(s.start_at at time zone a.timezone,
                     'FMDay, FMDD FMMonth YYYY HH24:MI');
    if s.appointment_type='in_person_consultation' then
      select l.studio_name || ', ' || l.studio_address into v_address
      from crm_private.consultation_email_location() l;
      select nullif(btrim(c.studio_map_url),'') into v_map_url
      from crm_private.booking_card_artist_settings c
      where c.artist_id=j.artist_id
        and (c.appointment_start_from is null or s.start_at>=c.appointment_start_from)
      limit 1;
      -- Only in-person consultations receive a map; video calls keep the
      -- existing 'no studio visit' parameter and approved template.
      v_address:=crm_private.lifecycle_whatsapp_location_with_map(v_address,v_map_url);
    else
      v_address:='Video consultation: no studio visit';
    end if;
    select max(x.raw_token) filter (where x.action='confirm_attendance'),
           max(x.raw_token) filter (where x.action='request_reschedule'),
           max(x.raw_token) filter (where x.action='cancel')
      into v_token,v_reschedule_token,v_cancel_token
    from crm_private.issue_appointment_client_actions(s.id) x;
    if v_token is null or v_reschedule_token is null or v_cancel_token is null then
      raise exception 'consultation action capability unavailable' using errcode='23514';
    end if;
    v_url:=crm_private.render_lifecycle_action_template_text(
      '{{confirm_link}}',s.id,v_token,v_reschedule_token,v_cancel_token);
    if v_url is null or v_url !~ '^https://' or char_length(v_url)>1024
       or nullif(v_address,'') is null then
      raise exception 'consultation parameters unavailable' using errcode='23514';
    end if;
    v_params:=jsonb_build_array(v_first,a.display_name,v_dates,v_address,v_url);
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
$function$
