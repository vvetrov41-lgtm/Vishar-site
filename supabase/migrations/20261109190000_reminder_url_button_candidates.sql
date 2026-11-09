-- Stage Meta-reviewed replacement identities, without activation or client sends.
-- Keep existing approved live reminder cards unchanged until Meta approves.
ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check
    CHECK (kind IN ('booking_tattoo','booking_consultation','booking_video',
      'reminder_72h','reminder_24h','reminder_consultation',
      'reminder_24h_button','reminder_consultation_button',
      'reminder_consultation_video'));
INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
VALUES
 ('a1111111-1111-4111-8111-111111111111','reminder_24h_button',
  'vishar_lifecycle_reminder_24h_v4','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','reminder_consultation_button',
  'vishar_lifecycle_consultation_v5','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','reminder_consultation_video',
  'vishar_lifecycle_consultation_video_v1','en_GB')
ON CONFLICT (artist_id,kind) DO NOTHING;
ALTER TABLE crm_private.whatsapp_template_smoke_tests
  DROP CONSTRAINT whatsapp_template_smoke_tests_body_parameters_check,
  ADD CONSTRAINT whatsapp_template_smoke_tests_body_parameters_check
    CHECK (jsonb_typeof(body_parameters)='array' AND (
      (purpose='consultation_reminder' AND jsonb_array_length(body_parameters) IN (4,5))
      OR (purpose='session_reminder_72h' AND jsonb_array_length(body_parameters)=4)
      OR (purpose='session_reminder_24h' AND jsonb_array_length(body_parameters)=3)
    ));

-- 24h reminder arity
DO $patch0$
DECLARE v_before text:=$old0$if t.template_name='vishar_lifecycle_reminder_24h_v3' then$old0$;
        v_after text:=$new0$if t.template_name in ('vishar_lifecycle_reminder_24h_v3',
                             'vishar_lifecycle_reminder_24h_v4') then$new0$;
        v_source text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure) INTO v_source;
 IF v_source IS NULL OR
    (length(v_source)-length(replace(v_source,v_before,'')))<>length(v_before)
 THEN RAISE EXCEPTION 'Existing SQL contract drifted (24h reminder arity)'; END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$patch0$;

-- private location as button not text
DO $patch1$
DECLARE v_before text:=$old1$      v_address:=crm_private.lifecycle_whatsapp_location_with_map(v_address,v_map_url);
    else
      v_address:='Video consultation: no studio visit';$old1$;
        v_after text:=$new1$      if t.template_name<>'vishar_lifecycle_consultation_v5' then
        v_address:=crm_private.lifecycle_whatsapp_location_with_map(v_address,v_map_url);
      end if;
    else
      v_address:='Video consultation: no studio visit';$new1$;
        v_source text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure) INTO v_source;
 IF v_source IS NULL OR
    (length(v_source)-length(replace(v_source,v_before,'')))<>length(v_before)
 THEN RAISE EXCEPTION 'Existing SQL contract drifted (private location as button not text)'; END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$patch1$;

-- video routing
DO $patch2$
DECLARE v_before text:=$old2$  select c.id into v_conversation_id
  from public.communication_conversations c$old2$;
        v_after text:=$new2$  -- A video consultation must never use the in-person directions URL.
  if j.message_purpose='consultation_reminder'
     and s.appointment_type='video_consultation'
     and t.template_name='vishar_lifecycle_consultation_v5' then
    if not exists (
      select 1 from crm_private.whatsapp_template_proposals prop
      where prop.artist_id=j.artist_id
        and prop.kind='reminder_consultation_video'
        and prop.template_name='vishar_lifecycle_consultation_video_v1'
        and prop.approval_status='APPROVED'
        and prop.provider_template_id is not null
        and prop.verified_at>now()-interval '24 hours'
    ) then
      update public.automation_jobs set status='failed',
        attempt_count=attempt_count+1,
        last_error_category='integration_unavailable' where id=j.id;
      return 'failed';
    end if;
    t.template_name:='vishar_lifecycle_consultation_video_v1';
  end if;

  select c.id into v_conversation_id
  from public.communication_conversations c$new2$;
        v_source text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure) INTO v_source;
 IF v_source IS NULL OR
    (length(v_source)-length(replace(v_source,v_before,'')))<>length(v_before)
 THEN RAISE EXCEPTION 'Existing SQL contract drifted (video routing)'; END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$patch2$;

-- do not reconfirm consultation
DO $patch3$
DECLARE v_before text:=$old3$    select max(x.raw_token) filter (where x.action='confirm_attendance'),
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
    end if;$old3$;
        v_after text:=$new3$    if t.template_name in ('vishar_lifecycle_consultation_v5',
                           'vishar_lifecycle_consultation_video_v1') then
      -- These appointments were confirmed on booking; only reschedule.
      select max(x.raw_token) filter (where x.action='request_reschedule')
        into v_reschedule_token
      from crm_private.issue_appointment_client_actions(s.id) x;
      if v_reschedule_token is null or nullif(v_address,'') is null then
        raise exception 'consultation reschedule unavailable' using errcode='23514';
      end if;
      v_params:=jsonb_build_array(
        v_first,v_dates,v_address,'booking_action:'||v_reschedule_token);
    else
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
      if t.template_name in ('vishar_lifecycle_consultation_v3',
                             'vishar_lifecycle_consultation_v4') then
        v_params:=jsonb_build_array(
          v_first,v_dates,v_address,
          'booking_action:'||v_token,'booking_action:'||v_reschedule_token);
      else
        v_params:=jsonb_build_array(v_first,a.display_name,v_dates,v_address,v_url);
      end if;
    end if;$new3$;
        v_source text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure) INTO v_source;
 IF v_source IS NULL OR
    (length(v_source)-length(replace(v_source,v_before,'')))<>length(v_before)
 THEN RAISE EXCEPTION 'Existing SQL contract drifted (do not reconfirm consultation)'; END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$patch3$;

-- video payload approval
DO $patch4$
DECLARE v_before text:=$old4$     and exists (
       select 1 from crm_private.lifecycle_whatsapp_template_registry t
       where t.artist_id=o.artist_id and t.purpose=p.purpose
         and t.template_name=p.template_name
         and t.template_language=p.template_language
         and t.approval_status='APPROVED' and t.provider_template_id is not null
         and t.verified_at>now()-interval '24 hours'
     )$old4$;
        v_after text:=$new4$     and (
       exists (
         select 1 from crm_private.lifecycle_whatsapp_template_registry t
         where t.artist_id=o.artist_id and t.purpose=p.purpose
           and t.template_name=p.template_name
           and t.template_language=p.template_language
           and t.approval_status='APPROVED'
           and t.provider_template_id is not null
           and t.verified_at>now()-interval '24 hours'
       )
       or (
         p.purpose='consultation_reminder'
         and s.appointment_type='video_consultation'
         and p.template_name='vishar_lifecycle_consultation_video_v1'
         and exists (
           select 1 from crm_private.lifecycle_whatsapp_template_registry t
           where t.artist_id=o.artist_id and t.purpose=p.purpose
             and t.template_name='vishar_lifecycle_consultation_v5'
             and t.approval_status='APPROVED'
             and t.verified_at>now()-interval '24 hours'
         )
         and exists (
           select 1 from crm_private.whatsapp_template_proposals prop
           where prop.artist_id=o.artist_id
             and prop.kind='reminder_consultation_video'
             and prop.template_name=p.template_name
             and prop.template_language=p.template_language
             and prop.approval_status='APPROVED'
             and prop.provider_template_id is not null
             and prop.verified_at>now()-interval '24 hours'
         )
       )
     )$new4$;
        v_source text;
BEGIN
 SELECT pg_get_functiondef('public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure) INTO v_source;
 IF v_source IS NULL OR
    (length(v_source)-length(replace(v_source,v_before,'')))<>length(v_before)
 THEN RAISE EXCEPTION 'Existing SQL contract drifted (video payload approval)'; END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$patch4$;

-- Only promote after all three exact Meta identities have recent approvals.
CREATE OR REPLACE FUNCTION crm_private.activate_reminder_url_buttons(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private AS $promo$
DECLARE v_approved integer;
BEGIN
  IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
    OR NOT EXISTS (SELECT 1 FROM public.artists a
      WHERE a.id=p_artist_id AND a.slug='vladimir') THEN
    RAISE EXCEPTION 'Only Vladimir approved reminder templates can be activated'
      USING errcode='42501';
  END IF;
  LOCK TABLE crm_private.whatsapp_template_proposals,
    crm_private.lifecycle_whatsapp_template_registry,
    public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM crm_private.lifecycle_whatsapp_template_registry r
       WHERE r.artist_id=p_artist_id
         AND ((r.purpose='session_reminder_24h'
               AND r.template_name='vishar_lifecycle_reminder_24h_v4')
           OR (r.purpose='consultation_reminder'
               AND r.template_name='vishar_lifecycle_consultation_v5'))) = 2
  THEN RETURN 'already_active'; END IF;
  SELECT count(*) INTO v_approved
  FROM crm_private.whatsapp_template_proposals p
  WHERE p.artist_id=p_artist_id AND p.template_language='en_GB'
    AND p.approval_status='APPROVED'
    AND p.provider_template_id ~ '^[0-9]{5,32}$'
    AND p.verified_at>now()-interval '24 hours'
    AND (p.kind,p.template_name) IN (
      ('reminder_24h_button','vishar_lifecycle_reminder_24h_v4'),
      ('reminder_consultation_button','vishar_lifecycle_consultation_v5'),
      ('reminder_consultation_video','vishar_lifecycle_consultation_video_v1')
    );
  IF v_approved<>3 THEN RETURN 'waiting_for_meta_approval'; END IF;
  IF (SELECT count(*) FROM crm_private.lifecycle_whatsapp_template_registry r
       WHERE r.artist_id=p_artist_id
         AND ((r.purpose='session_reminder_24h'
               AND r.template_name='vishar_lifecycle_reminder_24h_v3')
           OR (r.purpose='consultation_reminder'
               AND r.template_name='vishar_lifecycle_consultation_v4')))<>2
  THEN RETURN 'active_template_drift'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_outbox o
      WHERE o.artist_id=p_artist_id AND o.kind='whatsapp_message'
        AND o.status IN ('pending','leased'))
  THEN RETURN 'outbox_not_drained'; END IF;
  UPDATE crm_private.lifecycle_whatsapp_template_registry r
  SET template_name=p.template_name,template_language=p.template_language,
      approval_status=p.approval_status,
      provider_template_id=p.provider_template_id,verified_at=p.verified_at
  FROM crm_private.whatsapp_template_proposals p
  WHERE r.artist_id=p_artist_id AND p.artist_id=r.artist_id
    AND ((r.purpose='session_reminder_24h' AND p.kind='reminder_24h_button')
      OR (r.purpose='consultation_reminder' AND p.kind='reminder_consultation_button'));
  RETURN 'activated';
END;
$promo$;
REVOKE ALL ON FUNCTION crm_private.activate_reminder_url_buttons(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
