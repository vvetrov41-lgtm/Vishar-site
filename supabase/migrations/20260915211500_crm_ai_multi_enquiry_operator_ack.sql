-- Preserve operator acknowledgement semantics across clients with multiple enquiries.
--
-- A request_information recommendation is client-scoped, while acknowledgement
-- happens on one enquiry at a time. A later update to a converted/closed sibling
-- must therefore not hide a separate brand-new enquiry for the same client.

create or replace function crm_private.client_request_information_is_actionable(
  p_artist_id uuid,
  p_client_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ack_at timestamptz;
begin
  if not exists (
    select 1
    from public.enquiries e
    where e.artist_id = p_artist_id
      and e.client_id = p_client_id
      and e.archived_at is null
  ) then
    return true;
  end if;

  -- Any still-new enquiry is an independent intake surface. A later workflow
  -- update on a sibling enquiry must not acknowledge this new enquiry for it.
  if exists (
    select 1
    from public.enquiries e
    where e.artist_id = p_artist_id
      and e.client_id = p_client_id
      and e.archived_at is null
      and e.status = 'new'::public.enquiry_status
  ) then
    return true;
  end if;

  -- Ignore terminal siblings when choosing the acknowledgement watermark. If
  -- every enquiry is terminal, there is no intake question left to reopen.
  select e.updated_at
  into v_ack_at
  from public.enquiries e
  where e.artist_id = p_artist_id
    and e.client_id = p_client_id
    and e.archived_at is null
    and e.status not in (
      'declined'::public.enquiry_status,
      'converted'::public.enquiry_status,
      'closed'::public.enquiry_status
    )
  order by e.updated_at desc, e.created_at desc, e.id desc
  limit 1;

  if not found then
    return false;
  end if;

  -- reviewing / waiting_for_client / accepted / quote_sent /
  -- deposit_requested / deposit_paid are explicit operator workflow moves.
  -- They acknowledge everything known at that point. A new request for client
  -- information becomes actionable only after a newer inbound interaction.
  return exists (
    select 1
    from crm_private.client_timeline_items(p_artist_id, p_client_id) t
    where t.direction = 'inbound'
      and t.source <> 'enquiry'
      and t.occurred_at > v_ack_at
  );
end;
$$;

revoke execute on function crm_private.client_request_information_is_actionable(uuid, uuid)
  from public, anon, authenticated, service_role;