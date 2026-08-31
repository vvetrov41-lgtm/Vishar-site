-- 0128_gpt_web_research.sql
--
-- Adds a dedicated GPT client ceiling for public-web research. The capability
-- is intentionally separate from CRM/finance/communications management: a
-- caller must still be a registered OAuth GPT client, an active CRM profile,
-- and hold current view access to the active Artist context on every request.

begin;

alter table crm_private.gpt_action_clients
  add column can_use_web_research boolean not null default false;

comment on column crm_private.gpt_action_clients.can_use_web_research is
  'Server-owned ceiling for bounded public-web search/scrape actions. Human Artist membership remains authoritative.';

create or replace function public.gpt_authorize_web_research()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
  v_enabled boolean;
begin
  select * into v_context
  from crm_private.require_gpt_client_context();

  select c.can_use_web_research
    into v_enabled
  from crm_private.gpt_action_clients c
  where c.id = v_context.gpt_client_id;

  if not found or not coalesce(v_enabled, false) then
    raise exception 'this GPT client cannot use web research'
      using errcode = '42501';
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.gpt_authorize_web_research()
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_authorize_web_research()
  to authenticated;

create or replace function public.configure_gpt_web_research_access(
  p_integration_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT web research access'
      using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'unknown GPT action integration %', p_integration_key
      using errcode = '22023';
  end if;

  if coalesce(p_enabled, false) then
    if not v_client.is_active or v_client.oauth_client_id is null then
      raise exception 'the GPT OAuth client must be active before web research is enabled'
        using errcode = '22023';
    end if;

    if v_client.binding_mode = 'artist' then
      perform crm_private.require_active_artist(v_client.artist_id);
      perform crm_private.require_artist_access(v_client.artist_id, 'view');
    end if;
  end if;

  update crm_private.gpt_action_clients c
  set can_use_web_research = coalesce(p_enabled, false)
  where c.id = v_client.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured', auth.uid(), 'owner', v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'binding_mode', v_client.binding_mode,
      'web_research_access', coalesce(p_enabled, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'binding_mode', v_client.binding_mode,
    'artist_id', v_client.artist_id,
    'can_use_web_research', coalesce(p_enabled, false)
  );
end;
$$;

revoke all on function public.configure_gpt_web_research_access(text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_web_research_access(text,boolean)
  to authenticated;

-- The two existing private Artist GPTs are the reviewed production clients for
-- this release. The dormant profile-bound unified GPT remains disabled and its
-- new capability remains false until its separate activation workstream.
update crm_private.gpt_action_clients
set can_use_web_research = true
where integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions')
  and is_active
  and oauth_client_id is not null;

commit;
