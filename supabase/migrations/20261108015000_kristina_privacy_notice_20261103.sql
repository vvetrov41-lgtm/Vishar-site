-- Kristina's current public privacy notice has version 2026-11-03.
-- Her hosted booking Worker validates consent and sends this exact version.
-- Production intake must accept it to avoid rejecting legitimate submissions
-- while still requiring an explicit affirmative acknowledgement.
--
-- Preserve existing versions for open browser tabs. The replacement is
-- fail-closed against unexpected edits, and sends no messages or enquiries.
do $migration$
declare
  v_signature constant regprocedure :=
    'public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_previous_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'', ''2026-10-12'')';
  v_rolling_check constant text :=
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'', ''2026-10-12'', ''2026-11-03'')';
begin
  v_definition := pg_get_functiondef(v_signature);
  if strpos(v_definition,v_rolling_check)>0 then return; end if;
  if strpos(v_definition,v_previous_check)=0 then
    raise exception 'Kristina privacy intake check changed; manual review required'
      using errcode='23514';
  end if;
  execute replace(v_definition,v_previous_check,v_rolling_check);
end;
$migration$;
