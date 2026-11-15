-- The GPT read exists to link an existing booking to a free consultation.
-- Finance-bearing tattoo outcomes remain on the existing CRM surface.
create or replace function public.gpt_get_visit_outcome_context(p_session_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_artist uuid;
  v_type public.appointment_type;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  select s.artist_id, s.appointment_type into v_artist, v_type
  from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  if v_type not in ('in_person_consultation', 'video_consultation') then
    raise exception 'only consultation visit outcomes can be read here'
      using errcode = '22023';
  end if;
  return public.get_visit_outcome_context(p_session_id);
end;
$fn$;

revoke all on function public.gpt_get_visit_outcome_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_visit_outcome_context(uuid) to authenticated;
