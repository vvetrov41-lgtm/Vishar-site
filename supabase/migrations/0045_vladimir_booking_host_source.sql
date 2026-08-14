-- 0045_vladimir_booking_host_source.sql
--
-- Prepare an inert trusted booking source for booking.vishartattoo.com only
-- when the existing Vladimir production source is already present.
--
-- Fresh/local CRM databases intentionally have no production artist/source
-- bootstrap data, so this migration is a no-op there. The new source is never
-- activated here. Activation remains an explicit production rollout step after
-- the dedicated host and exact Origin boundary have been verified.

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
    RAISE NOTICE 'vladimir-website booking source is absent; skipping production booking host source';
    RETURN;
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
    RETURN;
  END IF;

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
END;
$$;
