-- 0045_vladimir_booking_host_source.sql
--
-- Prepare an inert trusted booking source for booking.vishartattoo.com.
-- The source is deliberately created inactive. A later explicit production
-- rollout may activate it only after the dedicated host, exact Worker Origin
-- allow-list and end-to-end intake checks are ready.

DO $$
DECLARE
  v_artist_id uuid;
  v_existing public.booking_sources%ROWTYPE;
BEGIN
  SELECT artist_id
    INTO v_artist_id
    FROM public.booking_sources
   WHERE source_key = 'vladimir-website';

  IF v_artist_id IS NULL THEN
    RAISE EXCEPTION 'baseline booking source vladimir-website is required';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.booking_sources
   WHERE source_key = 'vladimir-booking-host';

  IF FOUND THEN
    IF v_existing.artist_id <> v_artist_id
       OR v_existing.allowed_origin IS DISTINCT FROM 'https://booking.vishartattoo.com'
       OR v_existing.form_version <> 'booking-v1' THEN
      RAISE EXCEPTION 'existing vladimir-booking-host source does not match the expected trusted route';
    END IF;
  ELSE
    INSERT INTO public.booking_sources (
      artist_id,
      source_key,
      allowed_origin,
      form_version,
      is_active
    ) VALUES (
      v_artist_id,
      'vladimir-booking-host',
      'https://booking.vishartattoo.com',
      'booking-v1',
      false
    );
  END IF;
END;
$$;
