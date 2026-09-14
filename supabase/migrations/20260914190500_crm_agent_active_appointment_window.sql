-- Tighten the CRM AI booking guard to appointments that are still active.
-- A historical session can remain `confirmed` until lifecycle cleanup runs;
-- it must not suppress intake for a later, unrelated enquiry forever.

create or replace function crm_private.client_has_scheduled_appointment(
  p_artist_id uuid,
  p_client_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.sessions s
    where s.artist_id = p_artist_id
      and s.client_id = p_client_id
      and s.status in ('proposed', 'confirmed')
      and s.cancelled_at is null
      and s.end_at >= clock_timestamp()
  );
$$;

revoke execute on function crm_private.client_has_scheduled_appointment(uuid, uuid)
  from public, anon, authenticated, service_role;
