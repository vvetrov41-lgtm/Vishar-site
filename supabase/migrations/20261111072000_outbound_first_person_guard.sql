-- Client-facing artist voice: every automated message must read as if
-- Vladimir/Kristina wrote it. Provider-approved Meta v1 is immutable.
-- No client messages, bookings, payments, sessions or outbox rows are changed.
-- Fail closed on concurrent template/function edits.
DO $subjects$
DECLARE v_count integer; v_updated integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.message_templates t
  WHERE t.status='active'
    AND t.artist_id IS NULL
    AND t.channel='email'
    AND t.purpose IN ('consultation_reminder','deposit_request',
       'deposit_confirmation','session_reminder_24h','session_reminder_72h')
    AND t.subject=CASE t.purpose
      WHEN 'consultation_reminder' THEN 'Tomorrow: your consultation with {{artist_display_name}}'
      WHEN 'deposit_request' THEN 'Deposit for your tattoo booking with {{artist_display_name}}'
      WHEN 'deposit_confirmation' THEN 'Deposit received for your tattoo booking with {{artist_display_name}}'
      WHEN 'session_reminder_24h' THEN 'Tomorrow: your tattoo appointment with {{artist_display_name}}'
      WHEN 'session_reminder_72h' THEN 'Your tattoo appointment with {{artist_display_name}} on {{appointment_date}}'
    END;
  IF v_count<>10 THEN
    RAISE EXCEPTION 'First-person email subjects drift: expected 10, got %',v_count;
  END IF;

  UPDATE public.message_templates t
  SET subject=CASE t.purpose
    WHEN 'consultation_reminder' THEN 'Our consultation tomorrow | {{appointment_date}}'
    WHEN 'deposit_request' THEN 'Deposit to secure your tattoo booking'
    WHEN 'deposit_confirmation' THEN 'I''ve received your tattoo deposit'
    WHEN 'session_reminder_24h' THEN 'See you tomorrow | Tattoo session'
    WHEN 'session_reminder_72h' THEN 'Our tattoo session in three days | {{appointment_date}}'
  END
  WHERE t.status='active'
    AND t.artist_id IS NULL
    AND t.channel='email'
    AND t.purpose IN ('consultation_reminder','deposit_request',
       'deposit_confirmation','session_reminder_24h','session_reminder_72h');
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>10 THEN RAISE EXCEPTION 'Email template update raced with another writer'; END IF;
END;
$subjects$;

-- Booking confirmations already have first-person bodies; remove the
-- third-person subject suffix appended by the shared renderer.
DO $booking_email$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure);
  v_old:=$o$  subject := v_title || ' with ' || v_artist_name;$o$;
  v_new:=$n$  subject := v_title;$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'Booking email subject changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$booking_email$;

-- Retired three-parameter Instagram builder remains callable by legacy
-- jobs. Make both legacy headline variants first-person, like the modern
-- four-parameter booking-card builder, without changing controls or routing.
DO $instagram_legacy$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('crm_private.create_booking_card_instagram(uuid,text,text)'::regprocedure);
  v_old:=$o$    v_headline := case when v_grouped then 'your ' || v_group.session_count || ' tattoo sessions with ' else 'your tattoo session with ' end || v_artist.display_name || case when v_grouped then ' are booked ✓' else ' is booked ✓' end;$o$;
  v_new:=$n$    v_headline := case when v_grouped then 'your ' || v_group.session_count || ' tattoo sessions with me are booked ✓' else 'your tattoo session with me is booked ✓' end;$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'Legacy Instagram tattoo booking changed concurrently'; END IF;
  v_fn:=replace(v_fn,v_old,v_new);

  v_old:=$o$    v_headline := case when v_video then 'your video consultation with ' else 'your consultation with ' end || v_artist.display_name || ' is booked ✓';$o$;
  v_new:=$n$    v_headline := case when v_video then 'your video consultation with me is booked ✓' else 'your consultation with me is booked ✓' end;$n$;
  IF (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'Legacy Instagram consultation booking changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$instagram_legacy$;

-- Never queue a Meta v1 booking card, even if someone later marks
-- Kristina's dormant template APPROVED. Both artists retain Email fallback.
DO $whatsapp_booking_queue$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure);
  v_old:=$o$  if v_template_name is null then
    return null;
  end if;$o$;
  v_new:=$n$  if v_template_name is null or v_template_name not in
    ('booking_card_tattoo_v2','booking_card_consultation_v2',
     'booking_card_consultation_v3','booking_card_video_consultation_v2') then
    return null; -- fail closed for third-person legacy v1
  end if;$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'WhatsApp booking composer changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$whatsapp_booking_queue$;

-- Sender-level check closes the race for already-queued old v1 booking
-- cards, without altering any communication or outbox row.
DO $whatsapp_booking_resolve$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure);
  v_old:=$o$        and m.status = 'queued'::public.communication_status$o$;
  v_new:=$n$        and m.status = 'queued'::public.communication_status
        and p.template_name in
          ('booking_card_tattoo_v2','booking_card_consultation_v2',
           'booking_card_consultation_v3','booking_card_video_consultation_v2')$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'WhatsApp booking sender changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$whatsapp_booking_resolve$;

-- Only provider-approved first-person lifecycle identities can send.
-- Prevent dormant v1 reminders for Kristina from silently activating on
-- future Cloud API onboarding. Email fallback remains unchanged.
DO $whatsapp_lifecycle_ready$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure);
  v_old:=$o$        -- The provider-approved v1 bodies speak about the artist in third
        -- person. Keep the email fallback until the reviewed v2 is active.
        and not (
          (t.purpose='post_session_aftercare'
           and t.template_name='vishar_lifecycle_aftercare_v1')
          or (t.purpose='post_session_checkin'
           and t.template_name='vishar_lifecycle_checkin_v1')
        )$o$;
  v_new:=$n$        -- Explicit first-person allowlist. Old Meta v1 identities
        -- cannot become active when a dormant WABA is connected later.
        and (
          (t.purpose='session_reminder_72h' and t.template_name in
            ('vishar_lifecycle_reminder_72h_v3','vishar_lifecycle_reminder_72h_v4'))
          or (t.purpose='session_reminder_24h' and t.template_name in
            ('vishar_lifecycle_reminder_24h_v3','vishar_lifecycle_reminder_24h_v4'))
          or (t.purpose='consultation_reminder' and t.template_name in
            ('vishar_lifecycle_consultation_v3','vishar_lifecycle_consultation_v4',
             'vishar_lifecycle_consultation_v5','vishar_lifecycle_consultation_v6'))
          or (t.purpose='post_session_aftercare'
              and t.template_name='vishar_lifecycle_aftercare_v2')
          or (t.purpose='post_session_checkin'
              and t.template_name='vishar_lifecycle_checkin_v2')
        )$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'WhatsApp lifecycle readiness changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$whatsapp_lifecycle_ready$;

-- Apply the same allowlist at the provider send boundary. The approved
-- WhatsApp video-consultation identity is a separate exception verified by
-- the existing provider proposal gate in this resolver.
DO $whatsapp_lifecycle_resolve$
DECLARE v_fn text; v_old text; v_new text;
BEGIN
  v_fn:=pg_get_functiondef('public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure);
  v_old:=$o$     and j.message_purpose=p.purpose
     and j.session_id=p.session_id$o$;
  v_new:=$n$     and j.message_purpose=p.purpose
     and (
       (p.purpose='session_reminder_72h' and p.template_name in
         ('vishar_lifecycle_reminder_72h_v3','vishar_lifecycle_reminder_72h_v4'))
       or (p.purpose='session_reminder_24h' and p.template_name in
         ('vishar_lifecycle_reminder_24h_v3','vishar_lifecycle_reminder_24h_v4'))
       or (p.purpose='consultation_reminder' and p.template_name in
         ('vishar_lifecycle_consultation_v3','vishar_lifecycle_consultation_v4',
          'vishar_lifecycle_consultation_v5','vishar_lifecycle_consultation_v6',
          'vishar_lifecycle_consultation_video_v1'))
       or (p.purpose='post_session_aftercare' and p.template_name='vishar_lifecycle_aftercare_v2')
       or (p.purpose='post_session_checkin' and p.template_name='vishar_lifecycle_checkin_v2')
     )
     and j.session_id=p.session_id$n$;
  IF v_fn IS NULL OR (length(v_fn)-length(replace(v_fn,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'WhatsApp lifecycle provider resolver changed concurrently'; END IF;
  EXECUTE replace(v_fn,v_old,v_new);
END;
$whatsapp_lifecycle_resolve$;
