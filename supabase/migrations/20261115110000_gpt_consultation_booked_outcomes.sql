-- Owner-approved ChatGPT plugin support for recording an already-completed
-- consultation linked to an existing tattoo booking.
--
-- Both functions forward the current human OAuth token and enforce the active
-- GPT artist scope. No service-role token, raw SQL, generic RPC, payment input,
-- new appointment or automatic messaging is accepted.

create or replace function public.gpt_get_visit_outcome_context(p_session_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  return public.get_visit_outcome_context(p_session_id);
end;
$fn$;

revoke all on function public.gpt_get_visit_outcome_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_visit_outcome_context(uuid) to authenticated;

create or replace function public.gpt_record_consultation_booked_outcome(
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_linked_session_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_session public.sessions%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  select * into v_session from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_session.artist_id, v_ctx.artist_id, 'consultation');

  if v_session.appointment_type not in ('video_consultation', 'in_person_consultation')
     or v_session.status <> 'completed'
     or v_session.end_at > clock_timestamp() then
    raise exception 'only an already completed consultation can be recorded here'
      using errcode = '22023';
  end if;
  if p_request_id is null or p_linked_session_id is null or p_expected_version <> 0 then
    raise exception 'provide a fresh request id, one linked booking and expected version zero'
      using errcode = '22023';
  end if;

  -- Read and record are individually artist-scoped. The underlying outcome
  -- RPC validates that the linked booking belongs to the SAME artist/client.
  if exists (
    select 1 from public.visit_outcomes o
    where o.session_id = p_session_id
  ) and not exists (
    select 1 from public.visit_outcome_revisions r
    where r.session_id = p_session_id and r.operation_id = p_request_id
  ) then
    raise exception 'this consultation already has an outcome; use the CRM correction form'
      using errcode = '23514';
  end if;

  -- The existing audited workflow provides idempotency, version locking,
  -- status synchronization and immutable revision history. A booked,
  -- free consultation has NO payment, fee, follow-up or calendar mutations.
  return public.record_visit_outcome(
    p_session_id, p_request_id, p_expected_version, 'booked',
    jsonb_build_object('linked_session_id', p_linked_session_id)
  );
end;
$fn$;

revoke all on function public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)
  to authenticated;
