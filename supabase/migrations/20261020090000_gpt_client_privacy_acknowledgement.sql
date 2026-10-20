-- GPT parity for the client-card privacy acknowledgement
-- (record_client_privacy_acknowledgement, 20261019200000). updateClient takes
-- privacy_acknowledged: true and records it for the active artist after the
-- same CRM role and artist checks the card button runs. The database stamps
-- time and actor; an earlier acknowledgement is never changed.
create or replace function public.gpt_update_client(
  p_client_id uuid,
  p_client jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_acknowledge boolean := false;
  v_fields jsonb := coalesce(p_client, '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_artist_id) then
    raise exception 'client is outside this GPT artist scope' using errcode = '42501';
  end if;
  if crm_private.gpt_client_has_other_artist_scope(p_client_id, v_artist_id) then
    raise exception 'shared client must be edited in the CRM, not an artist-scoped GPT'
      using errcode = '42501';
  end if;

  if v_fields ? 'privacy_acknowledged' then
    if jsonb_typeof(v_fields -> 'privacy_acknowledged') <> 'boolean'
       or not (v_fields ->> 'privacy_acknowledged')::boolean then
      raise exception 'privacy_acknowledged can only be true; an acknowledgement is never withdrawn here'
        using errcode = '22023';
    end if;
    v_acknowledge := true;
    v_fields := v_fields - 'privacy_acknowledged';
  end if;

  if v_fields <> '{}'::jsonb then
    v_result := public.update_client_details(p_client_id, v_fields);
  elsif not v_acknowledge then
    raise exception 'no client fields to update' using errcode = '22023';
  end if;

  if v_acknowledge then
    v_result := coalesce(v_result, '{}'::jsonb)
      || public.record_client_privacy_acknowledgement(p_client_id, v_artist_id);
  end if;

  return v_result;
end;
$$;

revoke all on function public.gpt_update_client(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_update_client(uuid, jsonb) to authenticated;
