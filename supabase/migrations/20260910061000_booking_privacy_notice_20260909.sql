-- Keep the durable intake privacy gate aligned with the live public booking
-- notice. Retain the previous notice version so forms opened before the
-- rollout can still be submitted safely.
--
-- This migration patches only the known pre-migration predicate and fails
-- closed if the intake function has drifted unexpectedly.
do $migration$
declare
  v_signature constant regprocedure :=
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_legacy_check constant text :=
    'v_privacy_version <> ''2026-07-29''';
  v_rolling_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'')';
begin
  v_definition := pg_get_functiondef(v_signature);

  if strpos(v_definition, v_rolling_check) > 0 then
    return;
  end if;

  if strpos(v_definition, v_legacy_check) = 0 then
    raise exception
      'create_enquiry_intake privacy gate no longer matches the expected pre-migration definition';
  end if;

  execute replace(v_definition, v_legacy_check, v_rolling_check);
end;
$migration$;
