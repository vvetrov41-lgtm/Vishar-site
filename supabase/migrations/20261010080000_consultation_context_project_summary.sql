-- 20261010080000_consultation_context_project_summary.sql
--
-- The consultation-preparation read used by the GPT/MCP plugin
-- (gpt_get_consultation_context) built its enquiry section from project_type
-- and placement only, and the plugin is told not to make a second enquiry
-- read. A full sleeve with a forearm cover-up plus a leg tattoo was therefore
-- still reduced to 'Cover-up' while preparing a consultation.
--
-- The public wrapper (rebuilt from the production definition of
-- 20261004170000) now adds project_summary and project_details to the
-- enquiry section it already returns. It reads them only when the core has
-- returned that enquiry, i.e. under exactly the same artist scope and
-- enquiry permission; every existing field is unchanged.

create or replace function public.gpt_get_consultation_context(p_appointment_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context jsonb;
  v_enquiry_id uuid;
  v_structure jsonb;
begin
  v_context := crm_private.gpt_get_consultation_context_core(p_appointment_id);
  begin
    v_enquiry_id := nullif(v_context -> 'enquiry' ->> 'enquiry_id', '')::uuid;
  exception when invalid_text_representation then
    v_enquiry_id := null;
  end;
  -- The enquiry section is present only when the caller may read the
  -- enquiry, so the analyses and the structure follow exactly the same
  -- permission.
  if v_enquiry_id is null or jsonb_typeof(v_context) is distinct from 'object' then
    return v_context;
  end if;

  select jsonb_build_object(
    'project_summary', e.project_summary,
    'project_details', e.project_details)
    into v_structure
  from public.enquiries e
  where e.id = v_enquiry_id;

  return jsonb_set(v_context, '{enquiry}', (v_context -> 'enquiry') || coalesce(v_structure, '{}'::jsonb))
    || jsonb_build_object('reference_analyses', crm_private.enquiry_reference_analyses(v_enquiry_id));
end;
$$;

revoke all on function public.gpt_get_consultation_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_consultation_context(uuid) to authenticated;
