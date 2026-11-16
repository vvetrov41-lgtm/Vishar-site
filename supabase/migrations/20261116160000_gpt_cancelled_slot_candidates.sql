-- Fill a cancelled slot, stage 3: the ChatGPT plugin reads the same candidate
-- list as the CRM panel. Read-only: no write, no queue, no client send.
--
-- Forwards the current human OAuth token, requires the active GPT artist scope
-- and the appointment to belong to that artist. The inner RPC still enforces
-- view_sessions and view_clients for the appointment's artist.

create or replace function public.gpt_list_cancelled_slot_candidates(p_session_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  return public.list_cancelled_slot_candidates(p_session_id);
end;
$fn$;

revoke all on function public.gpt_list_cancelled_slot_candidates(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_cancelled_slot_candidates(uuid) to authenticated;
