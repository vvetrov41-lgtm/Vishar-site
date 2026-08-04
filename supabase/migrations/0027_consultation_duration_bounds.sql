-- 0027_consultation_duration_bounds.sql
--
-- Consultation appointments are intentionally short. Enforce the product
-- policy at the authoritative table boundary as well as in CRM shortcuts.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sessions
    WHERE appointment_type IN ('in_person_consultation', 'video_consultation')
      AND (end_at - start_at) NOT BETWEEN interval '15 minutes' AND interval '30 minutes'
  ) THEN
    RAISE EXCEPTION 'existing consultation rows fall outside the 15 to 30 minute policy'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_consultation_duration_bounds
  CHECK (
    appointment_type NOT IN ('in_person_consultation', 'video_consultation')
    OR (end_at - start_at) BETWEEN interval '15 minutes' AND interval '30 minutes'
  );

COMMENT ON CONSTRAINT sessions_consultation_duration_bounds ON public.sessions IS
  'In-person and video consultations must last from 15 through 30 minutes inclusive.';
