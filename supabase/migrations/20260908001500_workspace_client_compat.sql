-- 20260908001500_workspace_client_compat.sql
--
-- Canonical production code now supplies workspace_id explicitly. A small
-- number of legacy service/test paths still insert a bare client first and link
-- it to an artist in the next statement. Keep those paths deterministic without
-- weakening tenant isolation: an entirely unlinked card may be adopted by its
-- first artist workspace; once any business row owns it, cross-workspace links
-- remain forbidden.

create or replace function crm_private.legacy_default_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.workspace_id
  from public.artists a
  where a.id = crm_private.legacy_default_artist_id()
    and a.is_active
  limit 1;
$$;

revoke all on function crm_private.legacy_default_workspace_id()
  from public, anon, authenticated, service_role;

alter table public.clients
  alter column workspace_id set default crm_private.legacy_default_workspace_id();

create or replace function crm_private.guard_client_workspace_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_client_id uuid;
  v_artist_id uuid;
  v_artist_workspace_id uuid;
  v_client_workspace_id uuid;
begin
  v_client_id := nullif(v_row ->> 'client_id', '')::uuid;
  v_artist_id := nullif(v_row ->> 'artist_id', '')::uuid;

  if v_client_id is null or v_artist_id is null then
    return new;
  end if;

  select a.workspace_id into v_artist_workspace_id
  from public.artists a
  where a.id = v_artist_id and a.is_active;

  select c.workspace_id into v_client_workspace_id
  from public.clients c
  where c.id = v_client_id and c.archived_at is null
  for update;

  if v_artist_workspace_id is null or v_client_workspace_id is null then
    raise exception 'client or artist workspace is unavailable'
      using errcode = '23503';
  end if;

  if v_client_workspace_id = v_artist_workspace_id then
    return new;
  end if;

  -- Compatibility for backend/test code that creates the card before it knows
  -- which artist owns it. Adoption is legal only while the card has no CRM
  -- relationship at all. The first relationship fixes the tenant permanently.
  if not exists (select 1 from public.enquiries e where e.client_id = v_client_id)
     and not exists (select 1 from public.projects p where p.client_id = v_client_id)
     and not exists (select 1 from public.sessions s where s.client_id = v_client_id)
     and not exists (
       select 1 from public.communication_conversations c
       where c.client_id = v_client_id
     ) then
    update public.clients c
    set workspace_id = v_artist_workspace_id,
        updated_at = now()
    where c.id = v_client_id;
    return new;
  end if;

  raise exception 'client belongs to a different workspace'
    using errcode = '23514';
end;
$$;

revoke all on function crm_private.guard_client_workspace_link()
  from public, anon, authenticated, service_role;
