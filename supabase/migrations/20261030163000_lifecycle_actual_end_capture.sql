-- Optional evidence-backed finish timestamp. The scheduler must never
-- invent an actual end from a timed automatic completion. It falls back to
-- sessions.end_at until this service-only contract receives real evidence.
create or replace function public.service_record_session_actual_end(
  p_session_id uuid,
  p_actual_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_session public.sessions%rowtype;
begin
  if not crm_private.is_service_backend() then
    raise exception 'actual end capture is backend-only' using errcode='42501';
  end if;
  if p_session_id is null or p_actual_end_at is null then
    raise exception 'actual end evidence is required' using errcode='22023';
  end if;
  select * into v_session
    from public.sessions where id=p_session_id for update;
  if not found or v_session.status <> 'completed'::public.session_status
    or v_session.appointment_type not in ('tattoo_session','touch_up') then
    raise exception 'completed tattoo session is required' using errcode='22023';
  end if;
  if p_actual_end_at < v_session.start_at
     or p_actual_end_at > now()+interval '5 minutes' then
    raise exception 'actual end evidence is outside the session window'
      using errcode='22023';
  end if;
  if v_session.actual_end_at is not null then
    if v_session.actual_end_at is distinct from p_actual_end_at then
      raise exception 'actual end already recorded; correction requires review'
        using errcode='23514';
    end if;
    return jsonb_build_object('session_id',v_session.id,
      'changed',false,'actual_end_at',v_session.actual_end_at);
  end if;
  update public.sessions set actual_end_at=p_actual_end_at
    where id=v_session.id and status='completed';
  return jsonb_build_object('session_id',v_session.id,
    'changed',true,'actual_end_at',p_actual_end_at);
end;
$function$;

revoke all on function public.service_record_session_actual_end(uuid,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.service_record_session_actual_end(uuid,timestamptz)
  to service_role;
comment on function public.service_record_session_actual_end(uuid,timestamptz)
  is 'Backend-only, once-per-completed-tattoo-session actual finish evidence. Scheduled end remains fallback.';
