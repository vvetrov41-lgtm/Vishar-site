-- Kristina Vishar's own privacy notice (kristinavishar.com/privacy/, version
-- 2026-10-12). Her booking Worker sends this version from server config, so the
-- durable intake gate must accept it alongside the earlier versions, which stay
-- valid for forms opened before rollout.
--
-- Fail closed if the intake function has drifted from the exact expected
-- predecessor, as in 20260915083800_booking_privacy_notice_20260914.sql.
do $migration$
declare
  v_signature constant regprocedure :=
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_previous_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'')';
  v_rolling_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'', ''2026-10-12'')';
begin
  v_definition := pg_get_functiondef(v_signature);

  if strpos(v_definition, v_rolling_check) > 0 then
    return;
  end if;

  if strpos(v_definition, v_previous_check) = 0 then
    raise exception
      'create_enquiry_intake privacy gate no longer matches the expected 2026-09-14 definition';
  end if;

  execute replace(v_definition, v_previous_check, v_rolling_check);
end;
$migration$;
