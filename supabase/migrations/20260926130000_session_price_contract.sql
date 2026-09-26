-- 20260926130000_session_price_contract.sql
--
-- One authoritative price source for every paid appointment: sessions.price.
-- Consultations are free and therefore cannot carry a session price.

alter table public.sessions
  drop constraint if exists sessions_consultations_are_free;

alter table public.sessions
  add constraint sessions_consultations_are_free
  check (
    appointment_type not in (
      'in_person_consultation'::public.appointment_type,
      'video_consultation'::public.appointment_type
    )
    or price is null
  );

alter table public.sessions
  drop constraint if exists sessions_price_upper_bound;

alter table public.sessions
  add constraint sessions_price_upper_bound
  check (price is null or price <= 100000.00);

create or replace function public.set_appointment_price(
  p_appointment_id uuid,
  p_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist uuid;
  v_client uuid;
  v_enquiry uuid;
  v_project uuid;
  v_type public.appointment_type;
  v_status public.session_status;
  v_currency text;
  v_previous numeric;
  v_price numeric;
  v_actor_kind text;
begin
  if p_appointment_id is null then
    raise exception 'an appointment id is required' using errcode = '22023';
  end if;
  if p_price is null or p_price <= 0 or p_price > 100000.00 then
    raise exception 'session price must be between 0.01 and 100000.00'
      using errcode = '22023';
  end if;

  v_price := round(p_price, 2);
  if v_price <> p_price then
    raise exception 'session price may have at most two decimal places'
      using errcode = '22023';
  end if;

  select s.artist_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.status, s.currency, s.price
    into v_artist, v_client, v_enquiry, v_project,
         v_type, v_status, v_currency, v_previous
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist, 'manage_finance');
  perform crm_private.require_active_artist(v_artist);

  if v_type in (
    'in_person_consultation'::public.appointment_type,
    'video_consultation'::public.appointment_type
  ) then
    raise exception 'consultations are free and cannot have a session price'
      using errcode = '23514';
  end if;

  if v_status in ('completed', 'cancelled', 'no_show') then
    raise exception 'a terminal appointment price cannot be changed'
      using errcode = '42501';
  end if;

  if v_previous is not distinct from v_price then
    return jsonb_build_object(
      'appointment_id', p_appointment_id,
      'price', v_price,
      'currency', v_currency,
      'changed', false
    );
  end if;

  update public.sessions
  set price = v_price,
      updated_at = now()
  where id = p_appointment_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    v_artist,
    'appointment.price_changed',
    v_actor_kind,
    auth.uid(),
    v_client,
    v_enquiry,
    v_project,
    p_appointment_id,
    null,
    jsonb_build_object(
      'currency', v_currency,
      'previous_price', v_previous,
      'price', v_price
    )
  );

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'price', v_price,
    'currency', v_currency,
    'changed', true
  );
end;
$$;

revoke all on function public.set_appointment_price(uuid, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.set_appointment_price(uuid, numeric)
  to authenticated;


-- Atomic booking + explicit price path used by the shared booking panel. The
-- existing schedule_appointment RPC remains unchanged for callers that do not
-- manage finance. If setting the price fails, the whole booking transaction
-- rolls back rather than leaving a partially configured session.
create or replace function public.schedule_appointment_with_price(
  p_artist_id uuid,
  p_client_id uuid,
  p_appointment_type public.appointment_type,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_status public.session_status,
  p_enquiry_id uuid,
  p_project_id uuid,
  p_notes text,
  p_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_result jsonb;
  v_appointment_id uuid;
begin
  if p_price is null then
    raise exception 'an explicit session price is required for this booking path'
      using errcode = '22023';
  end if;

  if p_appointment_type in (
    'in_person_consultation'::public.appointment_type,
    'video_consultation'::public.appointment_type
  ) then
    raise exception 'consultations are free and cannot have a session price'
      using errcode = '23514';
  end if;

  v_result := public.schedule_appointment(
    p_artist_id,
    p_client_id,
    p_appointment_type,
    p_start_at,
    p_end_at,
    p_status,
    p_enquiry_id,
    p_project_id,
    p_notes
  );

  -- A replay is an already-existing booking. Do not let a retry become a
  -- hidden price-edit operation.
  if coalesce((v_result ->> 'replayed')::boolean, false) then
    return v_result;
  end if;

  v_appointment_id := nullif(v_result ->> 'appointment_id', '')::uuid;
  if v_appointment_id is null then
    raise exception 'scheduled appointment id is missing'
      using errcode = '23514';
  end if;

  perform public.set_appointment_price(v_appointment_id, p_price);

  return v_result || jsonb_build_object(
    'price', round(p_price, 2),
    'currency', 'GBP'
  );
end;
$$;

revoke all on function public.schedule_appointment_with_price(
  uuid, uuid, public.appointment_type, timestamptz, timestamptz,
  public.session_status, uuid, uuid, text, numeric
) from public, anon, authenticated, service_role;
grant execute on function public.schedule_appointment_with_price(
  uuid, uuid, public.appointment_type, timestamptz, timestamptz,
  public.session_status, uuid, uuid, text, numeric
) to authenticated;
