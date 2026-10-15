-- Group dispatch and atomic confirmations for Email, WhatsApp and Instagram.
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
      v_message_id := crm_private.queue_booking_card_instagram(
        v_card.id, v_confirm_token, v_reschedule_token
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

CREATE OR REPLACE FUNCTION crm_private.issue_booking_card_client_actions(p_booking_card_id uuid)
 RETURNS TABLE(action appointment_client_action, raw_token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_status public.session_status;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_action public.appointment_client_action;
  v_raw text;
  v_expiry timestamptz;
  v_token_id uuid;
  v_group_id uuid;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    raise exception 'booking card is not eligible for client actions'
      using errcode = '42501';
  end if;

  select s.status, s.start_at, s.calendar_version
    into v_status, v_start_at, v_calendar_version
  from public.sessions s
  join crm_private.artist_state st
    on st.artist_id = s.artist_id
   and st.is_active
  where s.id = v_card.session_id
    and s.artist_id = v_card.artist_id
    and s.client_id = v_card.client_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now()
     or v_calendar_version <> v_card.calendar_version then
    raise exception 'booking card is not eligible for client actions'
      using errcode = '42501';
  end if;

  -- Booking-card links are intentionally short-lived even when the appointment
  -- is months away. A later lifecycle reminder can issue a fresh set.
  v_expiry := least(v_start_at, now() + interval '7 days');

  select g.group_id into v_group_id from crm_private.booking_card_groups g
  where g.anchor_card_id=v_card.id and crm_private.booking_group_card_valid(v_card.id);

  -- Do not invalidate an already queued sibling channel here. If Email queued
  -- successfully and WhatsApp becomes reachable later, WhatsApp must be able
  -- to mint its own pair without breaking the Email buttons already delivered.
  -- service_apply_appointment_client_action invalidates every remaining live
  -- sibling after the first successful response.
  foreach v_action in array array[
    'confirm_attendance'::public.appointment_client_action,
    'request_reschedule'::public.appointment_client_action
  ]
  loop
    v_raw := encode(extensions.gen_random_bytes(32), 'hex');

    insert into crm_private.appointment_client_action_tokens (
      session_id,
      action,
      token_hash,
      session_calendar_version,
      expires_at,
      booking_card_id
    ) values (
      v_card.session_id,
      v_action,
      encode(extensions.digest(v_raw, 'sha256'), 'hex'),
      v_calendar_version,
      v_expiry,
      v_card.id
    ) returning id into v_token_id;

    if v_group_id is not null then
      insert into crm_private.booking_card_group_action_tokens(token_id,group_id)
      values (v_token_id,v_group_id);
    end if;

    action := v_action;
    raw_token := v_raw;
    expires_at := v_expiry;
    return next;
  end loop;
end;
$function$;


-- Called from the existing backend-only action RPC. The first click is a
-- transactional all-or-nothing confirmation; no extra client links are minted.
create or replace function crm_private.apply_group_booking_card_action(p_token text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private,extensions
as $$
declare v_token crm_private.appointment_client_action_tokens%rowtype;
 v_group crm_private.booking_card_groups%rowtype; v_action_result jsonb;
 v_sid uuid; v_s public.sessions%rowtype; v_response public.appointment_client_response;
 v_count integer;
begin
 if not crm_private.is_service_backend() then
   raise exception 'group booking action is backend-only' using errcode='42501';
 end if;
 select t.* into v_token from crm_private.appointment_client_action_tokens t
 join crm_private.booking_card_group_action_tokens gt on gt.token_id=t.id
 where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 if not found or v_token.consumed_at is not null or v_token.invalidated_at is not null
   or v_token.expires_at<=now()
   or v_token.action not in ('confirm_attendance','request_reschedule') then
   raise exception 'appointment action is unavailable' using errcode='42501';
 end if;
 select g.* into v_group from crm_private.booking_card_group_action_tokens gt
 join crm_private.booking_card_groups g on g.group_id=gt.group_id
 where gt.token_id=v_token.id and g.anchor_card_id=v_token.booking_card_id;
 if not found then raise exception 'appointment action is unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('booking-group-action:' || v_group.group_id::text,0));
 -- Sort session locks before token locks (same lock order used by single actions).
 for v_sid in
   select s.id from jsonb_to_recordset(v_group.member_snapshot) as m(
     session_id uuid,card_id uuid,calendar_version integer,start_at timestamptz,end_at timestamptz
   ) join public.sessions s on s.id=m.session_id order by s.id for update of s
 loop null; end loop;
 if not crm_private.booking_group_card_valid(v_group.anchor_card_id) then
   raise exception 'appointment action is unavailable' using errcode='42501';
 end if;
 select count(*) into v_count from jsonb_array_elements(v_group.member_snapshot);
 if v_count<2 then raise exception 'appointment action is unavailable' using errcode='42501'; end if;
 -- The canonical single-session implementation consumes the actual anchor
 -- capability and sends one operator notification. Its own security checks stay intact.
 perform set_config('vishar.group_booking_action_inner','on',true);
 begin
   v_action_result:=public.service_apply_appointment_client_action(p_token);
 exception when others then
   perform set_config('vishar.group_booking_action_inner','off',true);
   raise;
 end;
 perform set_config('vishar.group_booking_action_inner','off',true);
 v_response:=case when v_token.action='confirm_attendance'
   then 'attendance_confirmed'::public.appointment_client_response
   else 'reschedule_requested'::public.appointment_client_response end;
 for v_s in
   select s.* from jsonb_to_recordset(v_group.member_snapshot) as m(
     session_id uuid,card_id uuid,calendar_version integer,start_at timestamptz,end_at timestamptz
   ) join public.sessions s on s.id=m.session_id
   where s.id<>v_token.session_id order by s.id
 loop
   update public.sessions set client_response=v_response,
      client_response_at=now(),client_response_calendar_version=v_s.calendar_version
   where id=v_s.id;
   perform crm_private.log_artist_activity(
      v_s.artist_id,'appointment.client_response','worker',null,
      v_s.client_id,v_s.enquiry_id,v_s.project_id,v_s.id,null,
      jsonb_build_object('response',v_response,'calendar_version',v_s.calendar_version,
        'source','group_booking_card','group_id',v_group.group_id)
   );
 end loop;
 -- Stale individual reminder capabilities must not contradict the group click.
 update crm_private.appointment_client_action_tokens t set invalidated_at=now()
 where t.session_id in (
   select x.session_id from jsonb_to_recordset(v_group.member_snapshot) as x(
     session_id uuid,card_id uuid,calendar_version integer,start_at timestamptz,end_at timestamptz
   )
 ) and t.id<>v_token.id and t.consumed_at is null and t.invalidated_at is null;
 return v_action_result || jsonb_build_object('grouped',true,'session_count',v_count);
end;
$$;
revoke all on function crm_private.apply_group_booking_card_action(text)
from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.service_apply_appointment_client_action(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_hash text;
  v_token_id uuid;
  v_session_id uuid;
  v_action public.appointment_client_action;
  v_token_version integer;
  v_expires_at timestamptz;
  v_consumed_at timestamptz;
  v_invalidated_at timestamptz;
  v_status public.session_status;
  v_artist_id uuid;
  v_workspace_id uuid;
  v_artist_name text;
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_type public.appointment_type;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_calendar_event_id text;
  v_response public.appointment_client_response;
  v_notification_type text;
  v_notification_title text;
  v_notification_body text;
  v_notification_priority public.notification_priority;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action mutation is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  -- A group token is applied to every snapshotted session atomically.
  if coalesce(current_setting('vishar.group_booking_action_inner',true),'')<>'on'
     and exists (select 1 from crm_private.appointment_client_action_tokens t
       join crm_private.booking_card_group_action_tokens gt on gt.token_id=t.id
       where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')) then
    return crm_private.apply_group_booking_card_action(p_token);
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- First resolve only the immutable token -> session identity without taking
  -- a token-row lock. Every path that can mutate these capabilities locks the
  -- session first, then a token row. Keeping one lock order avoids a deadlock
  -- between reminder minting and a client POST arriving at the same moment.
  select t.id, t.session_id
    into v_token_id, v_session_id
  from crm_private.appointment_client_action_tokens t
  where t.token_hash = v_hash;

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  select s.status, s.artist_id, a.workspace_id, a.display_name,
         s.client_id, s.enquiry_id, s.project_id, s.appointment_type,
         s.start_at, s.calendar_version, s.calendar_event_id
    into v_status, v_artist_id, v_workspace_id, v_artist_name,
         v_client_id, v_enquiry_id, v_project_id, v_type,
         v_start_at, v_calendar_version, v_calendar_event_id
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where s.id = v_session_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now() then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  -- Re-read and lock the capability only after the session lock. This closes
  -- the race between the initial lookup and lock acquisition, while preserving
  -- the same session -> token lock order used by the minting primitive.
  select t.action, t.session_calendar_version, t.expires_at,
         t.consumed_at, t.invalidated_at
    into v_action, v_token_version, v_expires_at,
         v_consumed_at, v_invalidated_at
  from crm_private.appointment_client_action_tokens t
  where t.id = v_token_id
    and t.session_id = v_session_id
    and t.token_hash = v_hash
  for update;

  if not found
     or v_consumed_at is not null
     or v_invalidated_at is not null
     or v_expires_at <= now()
     or v_token_version <> v_calendar_version then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action = 'confirm_attendance'::public.appointment_client_action then
    v_response := 'attendance_confirmed'::public.appointment_client_response;
    v_notification_type := 'appointment.attendance_confirmed';
    v_notification_title := 'Client confirmed attendance';
    v_notification_body := 'The client confirmed they plan to attend this appointment.';
    v_notification_priority := 'low'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'request_reschedule'::public.appointment_client_action then
    v_response := 'reschedule_requested'::public.appointment_client_response;
    v_notification_type := 'appointment.reschedule_requested';
    v_notification_title := 'Client requested a reschedule';
    v_notification_body := 'The appointment time has not changed. Contact the client and choose a new slot before rescheduling it in CRM.';
    v_notification_priority := 'high'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'cancel'::public.appointment_client_action then
    v_notification_type := 'appointment.cancelled_by_client';
    v_notification_title := 'Client cancelled an appointment';
    v_notification_body := 'The client cancelled this appointment from the secure reminder link.';
    v_notification_priority := 'high'::public.notification_priority;

    -- Exact confirmed -> cancelled semantics from public.set_appointment_status:
    -- increment the calendar version, preserve the activity projection and
    -- enqueue a provider cancellation only when a calendar event already exists.
    update public.sessions s
    set status = 'cancelled'::public.session_status,
        cancelled_at = now(),
        calendar_version = s.calendar_version + 1
    where s.id = v_session_id;

    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.status_changed',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'appointment_type', v_type,
        'from_status', v_status,
        'to_status', 'cancelled',
        'source', 'client_action_link'
      )
    );

    if v_calendar_event_id is not null then
      perform crm_private.enqueue_outbox(
        'calendar_cancel',
        public.calendar_outbox_dedupe_key('cancel', v_session_id, v_calendar_version + 1),
        jsonb_build_object(
          'session_id', v_session_id,
          'appointment_type', v_type,
          'calendar_version', v_calendar_version + 1
        ),
        v_client_id, v_enquiry_id, v_project_id, v_session_id, null
      );
    end if;
  else
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action <> 'cancel'::public.appointment_client_action then
    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.client_response',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'response', v_response,
        'calendar_version', v_calendar_version,
        'source', 'client_action_link'
      )
    );
  end if;

  insert into public.notifications (
    recipient_profile_id,
    artist_id,
    workspace_id,
    notification_type,
    title,
    body,
    entity_type,
    entity_id,
    priority,
    status,
    dedupe_key,
    scheduled_at,
    delivered_at
  )
  select
    r.profile_id,
    v_artist_id,
    v_workspace_id,
    v_notification_type,
    v_notification_title,
    v_notification_body,
    'session',
    v_session_id,
    v_notification_priority,
    'delivered'::public.notification_status,
    'appointment_client_action:' || v_session_id::text || ':'
      || v_calendar_version::text || ':' || v_action::text || ':' || r.profile_id::text,
    now(),
    now()
  from crm_private.automation_notification_recipients(v_artist_id) r
  on conflict (dedupe_key) do nothing;

  -- Consume the chosen capability and invalidate its siblings atomically. A
  -- retry or a contradictory click from the same reminder cannot mutate twice.
  update crm_private.appointment_client_action_tokens t
  set consumed_at = now()
  where t.id = v_token_id;

  update crm_private.appointment_client_action_tokens t
  set invalidated_at = now()
  where t.session_id = v_session_id
    and t.id <> v_token_id
    and t.consumed_at is null
    and t.invalidated_at is null;

  return jsonb_build_object(
    'action', v_action,
    'outcome', case v_action
      when 'confirm_attendance'::public.appointment_client_action then 'attendance_confirmed'
      when 'request_reschedule'::public.appointment_client_action then 'reschedule_requested'
      when 'cancel'::public.appointment_client_action then 'cancelled'
    end,
    'artist_display_name', v_artist_name
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_appointment_client_action(p_token text)
 RETURNS TABLE(action appointment_client_action, artist_display_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_hash text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action resolution is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  return query
  select t.action, a.display_name
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id = t.session_id
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where t.token_hash = v_hash
    and t.consumed_at is null
    and t.invalidated_at is null
    and t.expires_at > now()
    and t.session_calendar_version = s.calendar_version
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and (t.booking_card_id is null or crm_private.booking_group_card_valid(t.booking_card_id));

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_apply_whatsapp_booking_card_action(p_artist_id uuid, p_integration_key text, p_contact_wa_id text, p_provider_message_id text, p_provider_timestamp timestamp with time zone, p_payload text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_token text;
  v_hash text;
  v_session_id uuid;
  v_action public.appointment_client_action;
  v_client_id uuid;
  v_client_phone text;
  v_ingest jsonb;
  v_apply jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp booking action is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null
     or coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$'
     or coalesce(p_contact_wa_id, '') !~ '^[0-9]{6,20}$'
     or coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$'
     or p_provider_timestamp is null
     or p_provider_timestamp > now() + interval '5 minutes'
     or coalesce(p_payload, '') !~ '^booking_action:[0-9a-f]{64}$' then
    raise exception 'invalid WhatsApp booking action envelope'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.provider = 'meta_cloud_api'
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist WhatsApp route is unavailable'
      using errcode = '23503';
  end if;

  v_token := substring(p_payload from 16);
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  select
    t.session_id,
    t.action,
    s.client_id,
    crm_private.normalize_whatsapp_phone(c.phone)
  into
    v_session_id,
    v_action,
    v_client_id,
    v_client_phone
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id = t.session_id
  join public.clients c on c.id = s.client_id and c.archived_at is null
  where t.token_hash = v_hash
    and t.action in (
      'confirm_attendance'::public.appointment_client_action,
      'request_reschedule'::public.appointment_client_action
    )
    and s.artist_id = p_artist_id
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and t.session_calendar_version = s.calendar_version
    and t.expires_at > now()
    and t.consumed_at is null
    and t.invalidated_at is null
    and (t.booking_card_id is null or crm_private.booking_group_card_valid(t.booking_card_id));

  if not found or v_client_phone is distinct from '+' || p_contact_wa_id then
    return jsonb_build_object(
      'applied', false,
      'reason', 'action_unavailable'
    );
  end if;

  -- Inbound persistence and action application live in this one transaction.
  -- If applying the appointment capability fails, the provider message insert
  -- rolls back too, so Meta can safely retry the same webhook.
  v_ingest := public.record_whatsapp_inbound_message(
    p_artist_id,
    p_integration_key,
    p_contact_wa_id,
    p_provider_message_id,
    p_provider_timestamp,
    'button',
    null
  );

  if coalesce((v_ingest ->> 'changed')::boolean, false) is false then
    return jsonb_build_object(
      'applied', false,
      'replayed', true,
      'reason', 'provider_event_replayed'
    );
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
   and (p.confirm_payload = p_payload or p.reschedule_payload = p_payload)
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
