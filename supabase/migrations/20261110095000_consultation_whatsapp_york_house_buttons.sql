-- Prevent another booking card from sending Vladimir's old tattoo-arrival
-- link for a consultation. The approved v2 Meta template itself is immutable.
-- Stage replacement identities; never claim Meta approval or send a message.
DO $consultation_location_guard$
BEGIN
 IF (SELECT count(*) FROM crm_private.consultation_email_location() l
     WHERE l.studio_name='Label Tattoo Kensington'
       AND l.studio_address='Unit B, York House, Avonmore Place, London W14 8RL'
       AND l.studio_map_url='https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic')<>1 THEN
    RAISE EXCEPTION 'Consultation pin changed since Meta review design';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM crm_private.booking_card_artist_settings s
   WHERE s.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
     AND s.studio_name='Label Tattoo Private'
     AND s.studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP'
     AND s.whatsapp_consultation_template_name IN ('booking_card_consultation_v1','booking_card_consultation_v2')) THEN
    RAISE EXCEPTION 'Booking contract or tattoo studio changed concurrently';
 END IF;
END;
$consultation_location_guard$;

ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check CHECK (kind IN (
    'booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation',
    'reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video','reminder_72h_button',
    'booking_consultation_directions','reminder_consultation_directions'
  ));
INSERT INTO crm_private.whatsapp_template_proposals
 (artist_id,kind,template_name,template_language)
VALUES
 ('a1111111-1111-4111-8111-111111111111','booking_consultation_directions',
  'booking_card_consultation_v3','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','reminder_consultation_directions',
  'vishar_lifecycle_consultation_v6','en_GB')
ON CONFLICT (artist_id,kind) DO NOTHING;
DO $new_identity_guard$
BEGIN
 IF (SELECT count(*) FROM crm_private.whatsapp_template_proposals
   WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    AND ((kind='booking_consultation_directions' AND template_name='booking_card_consultation_v3')
      OR (kind='reminder_consultation_directions' AND template_name='vishar_lifecycle_consultation_v6'))
    AND approval_status='UNKNOWN' AND provider_template_id IS NULL)=2 THEN
   RETURN;
 END IF;
 RAISE EXCEPTION 'New Meta candidate identity/state differs from review contract';
END;
$new_identity_guard$;

DO $patch_booking_consultation$
DECLARE v_source text; v_before text; v_after text;
BEGIN
 SELECT pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure) INTO v_source;
 IF v_source IS NULL THEN RAISE EXCEPTION 'patch_booking_consultation source missing'; END IF;
 v_before:=$before0$  if v_template_name is null then
    return null;
  end if;$before0$;
 v_after:=$after0$  if v_template_name is null then
    return null;
  end if;
  -- Block only Vladimir's in-person v2, whose static Meta URL leads to
  -- the tattoo-session studio. Correct Gmail booking still goes out.
  if v_card.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
     and v_card.card_kind='consultation_booked'
     and v_card.appointment_type='in_person_consultation'::public.appointment_type
     and v_template_name='booking_card_consultation_v2' then
    return null;
  end if;$after0$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_booking_consultation source changed at patch 0';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 v_before:=$before1$'booking_card_consultation_v2','booking_card_video_consultation_v2'$before1$;
 v_after:=$after1$'booking_card_consultation_v2','booking_card_consultation_v3',
      'booking_card_video_consultation_v2'$after1$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_booking_consultation source changed at patch 1';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 v_before:=$before2$'booking_card_tattoo_v2','booking_card_consultation_v2',
    'booking_card_video_consultation_v2'$before2$;
 v_after:=$after2$'booking_card_tattoo_v2','booking_card_consultation_v2',
    'booking_card_consultation_v3','booking_card_video_consultation_v2'$after2$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_booking_consultation source changed at patch 2';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 v_before:=$before3$when v_template_name='booking_card_consultation_v2' then 'booking_consultation'$before3$;
 v_after:=$after3$when v_template_name='booking_card_consultation_v2' then 'booking_consultation'
        when v_template_name='booking_card_consultation_v3' then 'booking_consultation_directions'$after3$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_booking_consultation source changed at patch 3';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 EXECUTE v_source;
END;
$patch_booking_consultation$;

DO $patch_booking_resolve$
DECLARE v_source text; v_before text; v_after text;
BEGIN
 SELECT pg_get_functiondef('public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure) INTO v_source;
 IF v_source IS NULL THEN RAISE EXCEPTION 'patch_booking_resolve source missing'; END IF;
 v_before:=$before0$        and s.start_at > now()$before0$;
 v_after:=$after0$        and s.start_at > now()
        and not (b.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
          and b.card_kind='consultation_booked'
          and b.appointment_type='in_person_consultation'::public.appointment_type
          and p.template_name='booking_card_consultation_v2')$after0$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_booking_resolve source changed at patch 0';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 EXECUTE v_source;
END;
$patch_booking_resolve$;

DO $patch_consultation_reminder$
DECLARE v_source text; v_before text; v_after text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure) INTO v_source;
 IF v_source IS NULL THEN RAISE EXCEPTION 'patch_consultation_reminder source missing'; END IF;
 v_before:=$before0$and t.template_name='vishar_lifecycle_consultation_v5' then$before0$;
 v_after:=$after0$and t.template_name in ('vishar_lifecycle_consultation_v5',
                              'vishar_lifecycle_consultation_v6') then$after0$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_consultation_reminder source changed at patch 0';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 v_before:=$before1$if t.template_name<>'vishar_lifecycle_consultation_v5' then$before1$;
 v_after:=$after1$if t.template_name not in ('vishar_lifecycle_consultation_v5',
                               'vishar_lifecycle_consultation_v6') then$after1$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_consultation_reminder source changed at patch 1';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 v_before:=$before2$if t.template_name in ('vishar_lifecycle_consultation_v5',$before2$;
 v_after:=$after2$if t.template_name in ('vishar_lifecycle_consultation_v5',
                           'vishar_lifecycle_consultation_v6',$after2$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_consultation_reminder source changed at patch 2';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 EXECUTE v_source;
END;
$patch_consultation_reminder$;

DO $patch_lifecycle_resolve$
DECLARE v_source text; v_before text; v_after text;
BEGIN
 SELECT pg_get_functiondef('public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure) INTO v_source;
 IF v_source IS NULL THEN RAISE EXCEPTION 'patch_lifecycle_resolve source missing'; END IF;
 v_before:=$before0$and t.template_name='vishar_lifecycle_consultation_v5'$before0$;
 v_after:=$after0$and t.template_name in ('vishar_lifecycle_consultation_v5',
                                     'vishar_lifecycle_consultation_v6')$after0$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'patch_lifecycle_resolve source changed at patch 0';
 END IF;
 v_source:=replace(v_source,v_before,v_after);
 EXECUTE v_source;
END;
$patch_lifecycle_resolve$;

