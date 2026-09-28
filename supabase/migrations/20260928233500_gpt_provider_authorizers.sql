-- Unified GPT v2: authorizers for provider-backed operator actions.
--
-- Gmail inbox and client history, and Instagram connection status, start and
-- disconnect, are served by their own provider Workers, which already verify
-- the signed-in human and their CRM capability. These authorizers add the GPT
-- boundary in front of them: registered OAuth client, server-owned Artist
-- context, GPT client ceiling and CRM capability. The GPT Worker then calls the
-- provider Worker for the Artist returned here, never an Artist from the model.
-- Provider tokens never leave the provider Workers.
--
-- The capabilities are the ones the provider Workers themselves enforce, so the
-- GPT never advertises a read the provider then refuses: Gmail operator reads
-- need manage_communications, and the Instagram connector's status, start and
-- disconnect all need integration management.

create or replace function public.gpt_authorize_provider_action(p_action text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  if p_action = 'gmail_inbox' then
    select * into v_ctx from crm_private.require_gpt_domain_context('communications', 'manage_communications');
  elsif p_action = 'instagram_view' then
    select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  elsif p_action = 'instagram_manage' then
    select * into v_ctx from crm_private.require_gpt_domain_context('integrations', 'manage_integrations');
  else
    raise exception 'unknown GPT provider action' using errcode = '22023';
  end if;
  return jsonb_build_object('action', p_action, 'artist_id', v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_authorize_gmail_client(p_client_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('communications', 'manage_communications');
  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_ctx.artist_id) then
    raise exception 'client is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  return jsonb_build_object('action', 'gmail_client_history', 'artist_id', v_ctx.artist_id, 'client_id', p_client_id);
end;
$$;

revoke all on function public.gpt_authorize_provider_action(text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_authorize_gmail_client(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_authorize_provider_action(text) to authenticated;
grant execute on function public.gpt_authorize_gmail_client(uuid) to authenticated;
