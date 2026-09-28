-- Unified GPT v2: foundation for full CRM operator parity.
--
-- The fresh operator-parity inventory (docs/gpt-actions/operator-parity.current.mjs)
-- lists 125 CRM actions that already have a safe server contract but no GPT
-- operation. Every one of them is exposed through a named public.gpt_* wrapper
-- that:
--   1. resolves the registered GPT OAuth client and the server-owned Artist
--      context (never an Artist id from the model);
--   2. checks the GPT client ceiling for the domain;
--   3. checks the signed-in human's CRM capability for that Artist;
--   4. proves any record id belongs to the active Artist;
--   5. calls the same public RPC the CRM screen calls, which re-checks
--      auth.uid() itself.
--
-- This migration adds the shared pieces. Domain wrappers follow in their own
-- migrations.

-- ---------------------------------------------------------------------------
-- 1. New ceilings. All default false. Only the profile-bound unified client
--    can receive them; the legacy artist-bound clients stay on their current
--    surface.
-- ---------------------------------------------------------------------------

alter table crm_private.gpt_action_clients
  add column if not exists can_manage_automations boolean not null default false,
  add column if not exists can_manage_integrations boolean not null default false,
  add column if not exists can_administer_workspace boolean not null default false;

alter table crm_private.gpt_action_clients
  drop constraint if exists gpt_action_clients_unified_ceilings_profile_only;
alter table crm_private.gpt_action_clients
  add constraint gpt_action_clients_unified_ceilings_profile_only
  check (
    binding_mode = 'profile'
    or not (can_manage_automations or can_manage_integrations or can_administer_workspace)
  );

-- ---------------------------------------------------------------------------
-- 2. Ceiling check by name. An unknown name is a programming error.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_ceiling(p_gpt_client_id uuid, p_ceiling text)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
  v_allowed boolean;
begin
  select c.* into v_client from crm_private.gpt_action_clients c where c.id = p_gpt_client_id;
  if not found then
    raise exception 'this GPT OAuth client is not enabled' using errcode = '42501';
  end if;

  v_allowed := case p_ceiling
    when 'crm_read' then v_client.can_manage_crm or v_client.can_read_enquiries
    when 'crm' then v_client.can_manage_crm
    when 'appointments_read' then v_client.can_read_appointments
    when 'appointments' then v_client.can_manage_appointments
    when 'finance' then v_client.can_manage_finance
    when 'communications' then v_client.can_manage_communications
    when 'automations' then v_client.can_manage_automations
    when 'integrations' then v_client.can_manage_integrations
    when 'administration' then v_client.can_administer_workspace
    else null
  end;

  if v_allowed is null then
    raise exception 'unknown GPT ceiling %', p_ceiling using errcode = '22023';
  end if;
  if not v_allowed then
    raise exception 'this GPT client is not enabled for % actions', p_ceiling using errcode = '42501';
  end if;
end;
$$;

revoke all on function crm_private.require_gpt_ceiling(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Artist-scoped domain context: registered client + Artist context +
--    ceiling + the human's capability on that Artist.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_domain_context(p_ceiling text, p_capability text)
returns table (gpt_client_id uuid, artist_id uuid, integration_key text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
begin
  select * into v_context from crm_private.require_gpt_client_context();
  perform crm_private.require_gpt_ceiling(v_context.gpt_client_id, p_ceiling);
  if p_capability is not null then
    perform crm_private.require_artist_access(v_context.artist_id, p_capability);
  end if;
  return query select v_context.gpt_client_id, v_context.artist_id, v_context.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_domain_context(text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Profile-scoped context for actions about the signed-in person or the
--    workspace/team they administer. No Artist selection is needed; the
--    called CRM RPC keeps its own role/membership checks.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_profile_scope(p_ceiling text)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_registration record;
begin
  select * into v_registration from crm_private.require_gpt_registered_client();
  if p_ceiling is not null then
    perform crm_private.require_gpt_ceiling(v_registration.gpt_client_id, p_ceiling);
  end if;
  return v_registration.gpt_client_id;
end;
$$;

revoke all on function crm_private.require_gpt_profile_scope(text)
  from public, anon, authenticated, service_role;

-- The workspace that owns the active Artist. Workspace administration through
-- the GPT acts on this workspace only, so the model never supplies a
-- workspace id.
create or replace function crm_private.require_gpt_context_workspace(p_ceiling text, p_capability text)
returns table (gpt_client_id uuid, artist_id uuid, workspace_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
  v_workspace_id uuid;
begin
  select * into v_context from crm_private.require_gpt_domain_context(p_ceiling, p_capability);
  select a.workspace_id into v_workspace_id from public.artists a where a.id = v_context.artist_id;
  if v_workspace_id is null then
    raise exception 'the active Artist has no workspace' using errcode = '42501';
  end if;
  return query select v_context.gpt_client_id, v_context.artist_id, v_workspace_id;
end;
$$;

revoke all on function crm_private.require_gpt_context_workspace(text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Record ownership. Every record id from the model must belong to the
--    active Artist, so a multi-Artist human cannot act on Artist B's records
--    while the GPT context says Artist A.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_record_artist(
  p_record_artist_id uuid,
  p_context_artist_id uuid,
  p_label text
)
returns void
language plpgsql
immutable
as $$
begin
  if p_record_artist_id is null or p_record_artist_id is distinct from p_context_artist_id then
    raise exception '% is outside the active GPT Artist scope', p_label using errcode = '42501';
  end if;
end;
$$;

revoke all on function crm_private.require_gpt_record_artist(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- A client is in scope when it has work with the active Artist. Editing a
-- client shared with another Artist stays a CRM action (same rule as
-- gpt_update_client).
create or replace function crm_private.require_gpt_client_exclusive(p_client_id uuid, p_artist_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.gpt_client_in_artist_scope(p_client_id, p_artist_id) then
    raise exception 'client is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  if crm_private.gpt_client_has_other_artist_scope(p_client_id, p_artist_id) then
    raise exception 'shared client must be changed in the CRM, not an Artist-scoped GPT'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function crm_private.require_gpt_client_exclusive(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Idempotency receipts for GPT writes whose CRM RPC has no idempotency
--    key of its own. Same table and rules as gpt_schedule_appointment.
-- ---------------------------------------------------------------------------

create or replace function crm_private.gpt_receipt_begin(
  p_gpt_client_id uuid,
  p_request_id uuid,
  p_operation text,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_hash text;
  v_existing crm_private.gpt_action_receipts%rowtype;
begin
  if p_request_id is null then
    raise exception 'request_id is required' using errcode = '22023';
  end if;
  v_hash := encode(digest(p_request::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    p_gpt_client_id::text || ':' || auth.uid()::text || ':' || p_request_id::text, 0));

  select r.* into v_existing
  from crm_private.gpt_action_receipts r
  where r.gpt_client_id = p_gpt_client_id
    and r.actor_profile_id = auth.uid()
    and r.request_id = p_request_id;

  if found then
    if v_existing.operation <> p_operation or v_existing.request_hash <> v_hash then
      raise exception 'request_id was already used for a different GPT action' using errcode = '22023';
    end if;
    return v_existing.response || jsonb_build_object('idempotent_replay', true);
  end if;
  return null;
end;
$$;

create or replace function crm_private.gpt_receipt_finish(
  p_gpt_client_id uuid,
  p_request_id uuid,
  p_operation text,
  p_request jsonb,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_response jsonb := coalesce(p_response, '{}'::jsonb);
  v_stored jsonb;
begin
  if jsonb_typeof(v_response) <> 'object' then
    v_response := jsonb_build_object('result', v_response);
  end if;
  v_stored := case when pg_column_size(v_response) <= 3500 then v_response
                   else jsonb_build_object('receipt', 'stored', 'response_truncated', true) end;

  insert into crm_private.gpt_action_receipts (
    gpt_client_id, actor_profile_id, request_id, operation, request_hash, response
  ) values (
    p_gpt_client_id, auth.uid(), p_request_id, p_operation,
    encode(digest(p_request::text, 'sha256'), 'hex'), v_stored
  );
  return v_response || jsonb_build_object('idempotent_replay', false);
end;
$$;

revoke all on function crm_private.gpt_receipt_begin(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.gpt_receipt_finish(uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Owner-only activation of the new ceilings, for the profile-bound client
--    only. The unified client must already be active.
-- ---------------------------------------------------------------------------

create or replace function public.configure_gpt_unified_domain_access(
  p_integration_key text,
  p_manage_automations boolean,
  p_manage_integrations boolean,
  p_administer_workspace boolean
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
    raise exception 'only the owner may configure unified GPT domain access' using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'unknown GPT action integration %', p_integration_key using errcode = '22023';
  end if;
  if v_client.binding_mode <> 'profile' then
    raise exception 'unified domain ceilings are only for the profile-bound GPT client' using errcode = '42501';
  end if;
  if coalesce(p_manage_automations, false) or coalesce(p_manage_integrations, false)
     or coalesce(p_administer_workspace, false) then
    if not v_client.is_active or v_client.oauth_client_id is null then
      raise exception 'the GPT OAuth client must be active before domain ceilings are enabled' using errcode = '42501';
    end if;
  end if;

  update crm_private.gpt_action_clients c
     set can_manage_automations = coalesce(p_manage_automations, false),
         can_manage_integrations = coalesce(p_manage_integrations, false),
         can_administer_workspace = coalesce(p_administer_workspace, false),
         updated_at = now()
   where c.id = v_client.id;

  insert into public.activity_log (event_type, actor_profile_id, actor_kind, metadata)
  values ('gpt.client_configured', auth.uid(), 'owner', jsonb_build_object(
    'change', 'unified_domains',
    'integration', p_integration_key,
    'automations', coalesce(p_manage_automations, false),
    'integrations', coalesce(p_manage_integrations, false),
    'administration', coalesce(p_administer_workspace, false)
  ));

  return jsonb_build_object(
    'integration_key', p_integration_key,
    'can_manage_automations', coalesce(p_manage_automations, false),
    'can_manage_integrations', coalesce(p_manage_integrations, false),
    'can_administer_workspace', coalesce(p_administer_workspace, false)
  );
end;
$$;

revoke all on function public.configure_gpt_unified_domain_access(text, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_unified_domain_access(text, boolean, boolean, boolean)
  to authenticated;
