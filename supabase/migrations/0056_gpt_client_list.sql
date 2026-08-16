-- 0056_gpt_client_list.sql
--
-- Add the missing bulk client-list view for full operational CRM management.
-- The list stays PII-minimised. Full contact detail remains a single-record RPC.

create or replace function public.gpt_list_clients(p_limit integer default 25)
returns table (
  client_id uuid,
  client_name text,
  preferred_contact text,
  travelling_from text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  v_limit := least(greatest(coalesce(p_limit, 25), 1), 50);

  return query
  select c.id, c.full_name, c.preferred_contact, c.travelling_from, c.updated_at
  from public.clients c
  where c.archived_at is null
    and crm_private.gpt_client_in_artist_scope(c.id, v_artist_id)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
$$;

revoke all on function public.gpt_list_clients(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_clients(integer)
  to authenticated;

comment on function public.gpt_list_clients(integer) is
  'Lists PII-minimised clients linked to the OAuth client fixed artist. Full contact detail remains single-record only.';
