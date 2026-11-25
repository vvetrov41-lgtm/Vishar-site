-- Use the verified consultation venue across reminder channels. No past sends are rewritten.

DO $venue0$
DECLARE
 v_def text := pg_get_functiondef('crm_private.decorate_consultation_reminder_email()'::regprocedure);
 v_old text := $old$    SELECT b.studio_address,b.arrival_guide_url INTO v_address,v_arrival
    FROM crm_private.booking_card_artist_settings b
    WHERE b.artist_id=new.artist_id;$old$;
 v_new text := $new$    SELECT l.studio_address,l.studio_map_url INTO v_address,v_arrival
    FROM crm_private.consultation_email_location() l;$new$;
BEGIN
 IF v_def IS NULL OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Consultation venue patch anchor drift: crm_private.decorate_consultation_reminder_email()'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END;
$venue0$;

DO $venue1$
DECLARE
 v_def text := pg_get_functiondef('crm_private.render_approved_lifecycle_email_html(uuid,text,text)'::regprocedure);
 v_old text := $old$    IF v_kind='in_person_consultation' THEN
      IF nullif(btrim(v_settings.studio_address),'') IS NULL THEN RETURN NULL; END IF;$old$;
 v_new text := $new$    IF v_kind='in_person_consultation' THEN
      SELECT l.studio_address,l.studio_map_url INTO v_settings.studio_address,v_settings.arrival_guide_url
      FROM crm_private.consultation_email_location() l;
      IF nullif(btrim(v_settings.studio_address),'') IS NULL OR nullif(btrim(v_settings.arrival_guide_url),'') IS NULL THEN RETURN NULL; END IF;$new$;
BEGIN
 IF v_def IS NULL OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Consultation venue patch anchor drift: crm_private.render_approved_lifecycle_email_html(uuid,text,text)'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END;
$venue1$;

DO $venue2$
DECLARE
 v_def text := pg_get_functiondef('crm_private.queue_lifecycle_instagram_job(uuid)'::regprocedure);
 v_old text := $old$ IF j.message_purpose IN ('session_reminder_72h','session_reminder_24h','consultation_reminder')
    AND s.appointment_type<>'video_consultation' THEN$old$;
 v_new text := $new$ IF j.message_purpose='consultation_reminder' AND s.appointment_type='in_person_consultation' AND j.artist_id IN ('a1111111-1111-4111-8111-111111111111'::uuid,'a2222222-2222-4222-8222-222222222222'::uuid) THEN
   SELECT l.studio_name,l.studio_address,l.studio_map_url,l.studio_map_url INTO cfg.studio_name,cfg.studio_address,cfg.studio_map_url,cfg.arrival_guide_url
   FROM crm_private.consultation_email_location() l;
 END IF;
 IF j.message_purpose IN ('session_reminder_72h','session_reminder_24h','consultation_reminder')
    AND s.appointment_type<>'video_consultation' THEN$new$;
BEGIN
 IF v_def IS NULL OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Consultation venue patch anchor drift: crm_private.queue_lifecycle_instagram_job(uuid)'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END;
$venue2$;

DO $venue3$
DECLARE
 v_def text := pg_get_functiondef('crm_private.create_booking_card_instagram(uuid,text,text)'::regprocedure);
 v_old text := $old$  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;$old$;
 v_new text := $new$  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;
  if v_card.card_kind='consultation_booked' and v_card.appointment_type='in_person_consultation' and v_card.artist_id in ('a1111111-1111-4111-8111-111111111111'::uuid,'a2222222-2222-4222-8222-222222222222'::uuid) then
    select l.studio_name,l.studio_address,l.studio_map_url,l.studio_map_url into v_settings.studio_name,v_settings.studio_address,v_settings.studio_map_url,v_settings.arrival_guide_url
    from crm_private.consultation_email_location() l;
  end if;$new$;
BEGIN
 IF v_def IS NULL OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Consultation venue patch anchor drift: crm_private.create_booking_card_instagram(uuid,text,text)'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END;
$venue3$;

DO $venue4$
DECLARE
 v_def text := pg_get_functiondef('crm_private.create_booking_card_instagram(uuid,text,text,text)'::regprocedure);
 v_old text := $old$  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;$old$;
 v_new text := $new$  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;
  if v_card.card_kind='consultation_booked' and v_card.appointment_type='in_person_consultation' and v_card.artist_id in ('a1111111-1111-4111-8111-111111111111'::uuid,'a2222222-2222-4222-8222-222222222222'::uuid) then
    select l.studio_name,l.studio_address,l.studio_map_url,l.studio_map_url into v_settings.studio_name,v_settings.studio_address,v_settings.studio_map_url,v_settings.arrival_guide_url
    from crm_private.consultation_email_location() l;
  end if;$new$;
BEGIN
 IF v_def IS NULL OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Consultation venue patch anchor drift: crm_private.create_booking_card_instagram(uuid,text,text,text)'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END;
$venue4$;
