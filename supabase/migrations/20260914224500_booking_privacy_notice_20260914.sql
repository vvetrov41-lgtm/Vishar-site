-- Keep the durable enquiry privacy gate aligned with the Meta CAPI disclosure.
-- Retain both earlier accepted versions so a form opened before rollout can be
-- submitted without falsely changing the notice version the visitor accepted.
--
-- Fail closed if the intake function has drifted from the exact expected
-- predecessor. This prevents a blind text replacement from weakening privacy.
do $migration$
declare
  v_signature constant regprocedure :=
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_previous_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'')';
  v_rolling_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'')';
begin
  v_definition := pg_get_functiondef(v_signature);

  if strpos(v_definition, v_rolling_check) > 0 then
    return;
  end if;

  if strpos(v_definition, v_previous_check) = 0 then
    raise exception
      'create_enquiry_intake privacy gate no longer matches the expected 2026-09-09 definition';
  end if;

  execute replace(v_definition, v_previous_check, v_rolling_check);
end;
$migration$;
