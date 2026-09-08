-- 20260908004000_workspace_client_regex_compat.sql
--
-- Functions introduced by the workspace-client split may contain either the
-- original over-escaped regex fragment (\\.) or the one-backslash variant (\.)
-- after a corrective branch rewrites the defining migration. Normalize either
-- exact form to a literal-dot character class and fail closed if neither known
-- source form is present.

do $$
declare
  v_def text;
  v_fixed text;
begin
  select pg_get_functiondef(
    'public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure
  ) into v_def;

  v_fixed := replace(v_def, chr(92) || chr(92) || '.', '[.]');
  if v_fixed = v_def then
    v_fixed := replace(v_def, chr(92) || '.', '[.]');
  end if;
  if v_fixed = v_def then
    raise exception 'create_manual_enquiry email regex compatibility patch did not match expected source'
      using errcode = '23514';
  end if;
  execute v_fixed;

  select pg_get_functiondef(
    'crm_private.update_client_details_core(uuid,jsonb)'::regprocedure
  ) into v_def;

  v_fixed := replace(v_def, chr(92) || chr(92) || '.', '[.]');
  if v_fixed = v_def then
    v_fixed := replace(v_def, chr(92) || '.', '[.]');
  end if;
  if v_fixed = v_def then
    raise exception 'update_client_details_core email regex compatibility patch did not match expected source'
      using errcode = '23514';
  end if;
  execute v_fixed;
end;
$$;
