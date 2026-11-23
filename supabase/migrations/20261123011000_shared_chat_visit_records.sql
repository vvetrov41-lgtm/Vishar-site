create or replace function public.get_visit_outcome_context(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_outcome public.visit_outcomes%rowtype;
  v_view_finance boolean;
  v_is_tattoo boolean;
  v_outcome_json jsonb;
  v_finance jsonb;
  v_bookings jsonb;
  v_enquiry_status public.enquiry_status;
  v_client_name text;
begin
  if p_session_id is null then
    raise exception 'an appointment id is required' using errcode = '22023';
  end if;
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'view_sessions');

  v_view_finance := crm_private.has_artist_capability(v_session.artist_id, 'view_finance');
  v_is_tattoo := v_session.appointment_type in ('tattoo_session', 'touch_up');

  if v_view_finance and v_is_tattoo then
    v_finance := crm_private.visit_session_finance(v_session.id);
  end if;
  select * into v_outcome from public.visit_outcomes where session_id = v_session.id;
  if found then
    v_outcome_json := jsonb_build_object(
      'state', v_outcome.state, 'outcome', v_outcome.outcome,
      'work_result', v_outcome.work_result, 'worked_minutes', v_outcome.worked_minutes,
      'linked_session_id', v_outcome.linked_session_id, 'follow_up_id', v_outcome.follow_up_id,
      'enquiry_status_after', v_outcome.enquiry_status_after, 'notes', v_outcome.notes,
      'aftercare_sent_before_outcome', v_outcome.aftercare_sent_before_outcome,
      'deferred_until', v_outcome.deferred_until, 'version', v_outcome.version,
      'confirmed_at', v_outcome.confirmed_at, 'updated_at', v_outcome.updated_at
    ) || case when v_view_finance then jsonb_build_object(
      'final_price', v_outcome.final_price, 'currency', v_outcome.currency,
      'deposit_applied', v_outcome.deposit_applied,
      'previously_received', v_outcome.previously_received,
      'received_via_outcome', v_outcome.received_via_outcome,
      'outstanding', v_outcome.outstanding, 'payment_state', v_outcome.payment_state,
      'payment_method', v_outcome.payment_method, 'paid_outside_crm', v_outcome.paid_outside_crm
    ) else '{}'::jsonb end;

    -- A saved revision is historical. Current screens and the chat read the
    -- current ledger, including receipts entered after that revision.
    if v_finance is not null and v_outcome.state = 'confirmed' and v_outcome.outcome = 'attended' then
      v_outcome_json := v_outcome_json || jsonb_build_object(
        'final_price', v_finance -> 'price',
        'deposit_applied', v_finance -> 'deposit_paid',
        'previously_received', greatest(0, (v_finance ->> 'invoiced_paid')::numeric - v_outcome.received_via_outcome),
        'outstanding', case
          when v_finance ->> 'due' is null then 'null'::jsonb
          when v_outcome.paid_outside_crm then '0'::jsonb
          else v_finance -> 'due' end,
        'payment_state', case
          when v_finance ->> 'due' is null then 'needs_review'
          when v_outcome.paid_outside_crm or (v_finance ->> 'due')::numeric = 0 then 'paid'
          when (v_finance ->> 'deposit_paid')::numeric + (v_finance ->> 'invoiced_paid')::numeric > 0 then 'part_paid'
          else 'unpaid' end
      );
    end if;
  end if;

  select left(btrim(c.full_name), 80) into v_client_name from public.clients c where c.id = v_session.client_id;
  if v_session.enquiry_id is not null then
    select e.status into v_enquiry_status from public.enquiries e where e.id = v_session.enquiry_id;
  end if;

  if not v_is_tattoo then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'appointment_type', b.appointment_type, 'status', b.status,
      'start_at', b.start_at, 'end_at', b.end_at, 'project_id', b.project_id
    ) order by b.start_at, b.id), '[]'::jsonb) into v_bookings
    from public.sessions b
    where b.artist_id = v_session.artist_id and b.client_id = v_session.client_id
      and b.id <> v_session.id
      and b.appointment_type in ('tattoo_session', 'touch_up')
      and b.cancelled_at is null
      and b.status in ('proposed', 'confirmed', 'completed')
      and b.start_at >= v_session.start_at - interval '1 day';
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id, 'artist_id', v_session.artist_id, 'client_id', v_session.client_id,
      'client_name', v_client_name, 'appointment_type', v_session.appointment_type,
      'status', v_session.status, 'start_at', v_session.start_at, 'end_at', v_session.end_at,
      'scheduled_minutes', round(extract(epoch from (v_session.end_at - v_session.start_at)) / 60),
      'project_id', v_session.project_id, 'enquiry_id', v_session.enquiry_id,
      'enquiry_status', v_enquiry_status, 'currency', v_session.currency
    ) || case when v_view_finance and v_is_tattoo
      then jsonb_build_object('payment_status', v_session.payment_status) else '{}'::jsonb end,
    'outcome', v_outcome_json,
    'version', coalesce(v_outcome.version, 0),
    'finance', v_finance,
    'bookings', v_bookings,
    'aftercare_sent', case when v_is_tattoo then exists (
      select 1 from public.automation_jobs j
      where j.session_id = v_session.id and j.message_purpose = 'post_session_aftercare'
        and j.status = 'completed') end,
    'can', jsonb_build_object(
      'record', crm_private.has_artist_capability(v_session.artist_id, 'manage_sessions'),
      'finance', crm_private.has_artist_capability(v_session.artist_id, 'manage_finance'),
      'follow_up', crm_private.has_artist_capability(v_session.artist_id, 'manage'),
      'view_finance', v_view_finance
    ),
    'needs_review', exists (select 1 from crm_private.visit_outcome_due(v_session.artist_id, clock_timestamp()) d
                            where d.session_id = v_session.id),
    'server_time', clock_timestamp()
  );
end;
$fn$;

create or replace function public.list_client_visit_outcomes(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id', o.session_id, 'state', o.state, 'outcome', o.outcome,
    'work_result', o.work_result, 'worked_minutes', o.worked_minutes, 'confirmed_at', o.confirmed_at, 'version', o.version
  ) order by o.confirmed_at desc nulls last), '[]'::jsonb)
  from public.visit_outcomes o
  where o.client_id = p_client_id
    and crm_private.has_artist_capability(o.artist_id, 'view_sessions');
$fn$;

-- Chat and the CRM use the same versioned outcome and immutable receipt writer.
create or replace function public.gpt_get_visit_outcome_context(p_session_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_artist uuid;
  v_type public.appointment_type;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  select s.artist_id, s.appointment_type into v_artist, v_type from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');

  if v_type in ('tattoo_session', 'touch_up') then
    if not exists (
      select 1 from crm_private.gpt_action_clients as c
      where c.id = v_ctx.gpt_client_id and c.can_manage_finance
    ) then
      raise exception 'only consultation visit outcomes can be read here' using errcode = '22023';
    end if;
    perform crm_private.require_artist_access(v_ctx.artist_id, 'view_finance');
  end if;
  return public.get_visit_outcome_context(p_session_id);
end;
$fn$;

create function public.gpt_record_tattoo_visit(
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_worked_minutes integer default null,
  p_final_price numeric default null,
  p_received_now numeric default null,
  p_payment_method text default null,
  p_work_result text default null,
  p_notes text default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_session public.sessions%rowtype;
  v_saved public.visit_outcomes%rowtype;
  v_pricing crm_private.artist_session_pricing%rowtype;
  v_request jsonb;
  v_result jsonb;
  v_price numeric;
  v_project_rate numeric;
  v_minutes integer;
  v_hours numeric;
  v_method text;
  v_operation_id uuid;
  v_finance jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  perform crm_private.require_gpt_ceiling(v_ctx.gpt_client_id, 'finance');
  perform crm_private.require_artist_access(v_ctx.artist_id, 'manage_finance');

  select * into v_session from public.sessions where id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_session.artist_id, v_ctx.artist_id, 'session');
  if v_session.appointment_type not in ('tattoo_session', 'touch_up') then
    raise exception 'a tattoo session or touch-up is required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 0
     or (p_worked_minutes is null and p_final_price is null and p_received_now is null
         and p_work_result is null and p_notes is null)
     or (p_final_price is not null and p_final_price <> round(p_final_price, 2))
     or (p_received_now is not null and (p_received_now <= 0 or p_received_now <> round(p_received_now, 2)))
     or (p_payment_method is not null and p_received_now is null) then
    raise exception 'provide the current outcome version and valid confirmed visit details' using errcode = '22023';
  end if;

  v_request := jsonb_build_object('session_id', p_session_id, 'expected_version', p_expected_version,
    'worked_minutes', p_worked_minutes, 'final_price', p_final_price, 'received_now', p_received_now,
    'payment_method', p_payment_method, 'work_result', p_work_result, 'notes', p_notes);
  v_result := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'record_tattoo_visit', v_request);
  if v_result is not null then return v_result; end if;

  v_operation_id := md5(v_ctx.gpt_client_id::text || ':' || auth.uid()::text || ':' || p_request_id::text || ':tattoo-visit')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('visit-outcome-op:' || v_operation_id::text, 0));
  select * into v_session from public.sessions where id = p_session_id for update;
  perform crm_private.require_gpt_record_artist(v_session.artist_id, v_ctx.artist_id, 'session');
  if v_session.appointment_type not in ('tattoo_session', 'touch_up') then
    raise exception 'a tattoo session or touch-up is required' using errcode = '22023';
  end if;
  select * into v_saved from public.visit_outcomes where session_id = p_session_id;
  if p_expected_version <> coalesce(v_saved.version, 0) then
    raise exception 'this visit outcome was changed in another session; reload and try again' using errcode = '40001';
  end if;
  if p_received_now is not null and (v_saved.paid_outside_crm or v_session.payment_status in ('paid', 'refunded')) then
    raise exception 'this session is already marked paid or refunded; review the existing payment first' using errcode = '23514';
  end if;

  v_minutes := coalesce(p_worked_minutes, v_saved.worked_minutes);
  if v_minutes is null or v_minutes not between 1 and 1440 then
    raise exception 'provide the actual working time in minutes' using errcode = '22023';
  end if;

  v_price := coalesce(p_final_price, v_saved.final_price);
  if v_price is null then
    v_hours := v_minutes::numeric / 60;
    select p.hourly_rate into v_project_rate from public.projects p
      where p.id = v_session.project_id and p.currency = v_session.currency;
    select * into v_pricing from crm_private.artist_session_pricing p
      where p.artist_id = v_session.artist_id and p.currency = v_session.currency;
    if v_pricing.full_day_rate is not null
       and (v_project_rate is null or v_project_rate = v_pricing.hourly_rate)
       and (v_hours > v_pricing.full_day_hours or
          (v_hours = v_pricing.full_day_hours and (v_pricing.hourly_rate is null or
              v_pricing.full_day_rate <= v_pricing.hourly_rate * v_hours))) then
      v_price := v_pricing.full_day_rate;
    else
      v_price := round(coalesce(v_project_rate, v_pricing.hourly_rate) * v_hours, 2);
    end if;
    if v_price is null then
      raise exception 'provide the final session price; a rate is not configured in this currency' using errcode = '22023';
    end if;
  end if;

  v_method := case when p_received_now is not null then coalesce(p_payment_method, 'other') end;
  v_result := public.record_visit_outcome(p_session_id, v_operation_id, p_expected_version, 'attended',
    jsonb_strip_nulls(jsonb_build_object(
      'worked_minutes', v_minutes, 'final_price', v_price, 'received_now', p_received_now,
      'payment_method', v_method, 'work_result', coalesce(p_work_result, v_saved.work_result, 'work_complete'),
      'notes', coalesce(p_notes, v_saved.notes), 'paid_outside_crm', case when v_saved.paid_outside_crm then true end
    )));
  v_finance := crm_private.visit_session_finance(p_session_id);
  v_result := v_result || jsonb_build_object('worked_minutes', v_minutes, 'final_price', v_price,
    'received_now', p_received_now, 'currency', v_session.currency, 'deposit_applied', v_finance->'deposit_paid',
    'outstanding', case when v_saved.paid_outside_crm then '0'::jsonb else v_finance->'due' end,
    'warnings', v_finance->'warnings');
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'record_tattoo_visit', v_request, v_result);
end;
$fn$;

revoke all on function public.gpt_record_tattoo_visit(uuid,uuid,integer,integer,numeric,numeric,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_record_tattoo_visit(uuid,uuid,integer,integer,numeric,numeric,text,text,text)
  to authenticated;
