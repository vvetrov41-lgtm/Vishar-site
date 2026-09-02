-- 0130_gpt_cloudflare_control.sql
--
-- Adds a dedicated owner-only GPT client ceiling for the private Cloudflare
-- control plane. The Cloudflare credential remains outside Postgres in the
-- vishar-cloudflare-gateway Worker secret store.

begin;

alter table crm_private.gpt_action_clients
  add column can_use_cloudflare_control boolean not null default false;

comment on column crm_private.gpt_action_clients.can_use_cloudflare_control is
  'Server-owned ceiling for owner-only bounded Cloudflare control-plane actions. Provider credentials remain Worker-side.';

create or replace function public.gpt_authorize_cloudflare_control()
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

  if not public.is_owner() then
    raise exception 'only the owner may use Cloudflare control actions'
      using errcode = '42501';
  end if;

  select c.can_use_cloudflare_control
    into v_enabled
  from crm_private.gpt_action_clients c
  where c.id = v_context.gpt_client_id;

  if not found or not coalesce(v_enabled, false) then
    raise exception 'this GPT client cannot use Cloudflare control actions'
      using errcode = '42501';
  end if;

  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.gpt_authorize_cloudflare_control()
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_authorize_cloudflare_control()
  to authenticated;

create or replace function public.configure_gpt_cloudflare_control_access(
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
    raise exception 'only the owner may configure GPT Cloudflare control access'
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
      raise exception 'the GPT OAuth client must be active before Cloudflare control is enabled'
        using errcode = '22023';
    end if;

    -- Initial rollout is intentionally bound to the reviewed owner GPT. Future
    -- clients require an explicit migration/review rather than caller input.
    if v_client.integration_key <> 'vladimir-gpt-actions' then
      raise exception 'Cloudflare control is not reviewed for GPT integration %', v_client.integration_key
        using errcode = '42501';
    end if;
  end if;

  update crm_private.gpt_action_clients c
  set can_use_cloudflare_control = coalesce(p_enabled, false)
  where c.id = v_client.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured', auth.uid(), 'owner', v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'binding_mode', v_client.binding_mode,
      'cloudflare_control_access', coalesce(p_enabled, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'binding_mode', v_client.binding_mode,
    'artist_id', v_client.artist_id,
    'can_use_cloudflare_control', coalesce(p_enabled, false)
  );
end;
$$;

revoke all on function public.configure_gpt_cloudflare_control_access(text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_cloudflare_control_access(text,boolean)
  to authenticated;

-- Only the reviewed Vladimir owner GPT receives the server-owned ceiling in
-- this release. Other private/unified GPT clients remain fail-closed.
update crm_private.gpt_action_clients
set can_use_cloudflare_control = true
where integration_key = 'vladimir-gpt-actions'
  and is_active
  and oauth_client_id is not null;

commit;
