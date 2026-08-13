-- 0034_gpt_oauth_consent_guard.sql
--
-- Allow the CRM consent page to verify an OAuth client before the user can
-- approve it. The database remains authoritative for client identity, artist
-- scope and required human capability.

create or replace function public.get_gpt_action_consent_summary(
  p_oauth_client_id text
)
returns table (
  integration_key text,
  client_display_name text,
  artist_id uuid,
  artist_display_name text,
  can_read_appointments boolean,
  can_manage_appointments boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated CRM user is required'
      using errcode = '42501';
  end if;

  if nullif(btrim(p_oauth_client_id), '') is null then
    raise exception 'OAuth client id is required'
      using errcode = '22023';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.oauth_client_id = btrim(p_oauth_client_id)
    and c.is_active;

  if not found then
    raise exception 'this GPT OAuth client is not enabled'
      using errcode = '42501';
  end if;

  perform crm_private.require_active_artist(v_client.artist_id);
  if v_client.can_manage_appointments then
    perform crm_private.require_artist_access(v_client.artist_id, 'manage_sessions');
  elsif v_client.can_read_appointments then
    perform crm_private.require_artist_access(v_client.artist_id, 'view');
  else
    raise exception 'this GPT OAuth client has no appointment access'
      using errcode = '42501';
  end if;

  return query
  select
    v_client.integration_key,
    v_client.display_name,
    a.id,
    a.display_name,
    v_client.can_read_appointments,
    v_client.can_manage_appointments
  from public.artists a
  where a.id = v_client.artist_id;
end;
$$;

revoke all on function public.get_gpt_action_consent_summary(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_gpt_action_consent_summary(text)
  to authenticated;

comment on function public.get_gpt_action_consent_summary(text) is
  'Validates that the signed-in human may consent to one active OAuth client fixed to one artist. Returns no OAuth secret or client data.';
