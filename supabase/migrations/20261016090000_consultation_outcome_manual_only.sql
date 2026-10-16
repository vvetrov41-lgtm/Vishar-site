-- Consultations: the outcome is recorded by a person, never inferred.
--
-- 20261015180000 completed an ended consultation automatically when the same
-- client later booked a tattoo. Owner review (2026-10-16): a later booking is
-- not proof that the consultation took place (the client may have booked by
-- message, after a missed or moved consultation). Where the fact cannot be
-- established, the consultation stays unverified.
--
-- * crm_private.auto_complete_due_tattoo_sessions returns to its body from
--   20261009171143 exactly (tattoo work only), without the evidence step.
-- * crm_private.resolve_evidenced_consultations is dropped. It never completed
--   anything in production (no activity_log row with
--   completion_source = 'follow_on_booking' as of 2026-10-16), so no status
--   needs to be put back.
-- * A later tattoo booking is still shown to the operator as a hint next to
--   the outcome buttons; it decides nothing.
--
-- Statistics is unchanged: held = completed, unverified and no-show apart.
-- No table, grant or policy change.

create or replace function crm_private.auto_complete_due_tattoo_sessions(p_limit integer default 100)
returns integer language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $fn$
declare
  v public.sessions%rowtype;
  n integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'post-session completion is backend-only' using errcode='42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid post-session batch size' using errcode='22023';
  end if;

  for v in
    select s.* from public.sessions s
    join crm_private.artist_state st on st.artist_id=s.artist_id and st.is_active
    where s.status='confirmed'
      and s.appointment_type in ('tattoo_session','touch_up')
      and s.start_at < s.end_at
      and s.end_at <= now()
      -- No retrospective change to old appointments after the rollout.
      and s.end_at >= now() - interval '36 hours'
      and exists (
        select 1 from public.automation_rules r
        where r.artist_id=s.artist_id
          and r.message_purpose='post_session_aftercare'
      )
    order by s.end_at,s.id
    for update of s skip locked
    limit p_limit
  loop
    update public.sessions
    set status='completed',calendar_version=v.calendar_version+1
    where id=v.id and status='confirmed';
    if not found then continue; end if;

    perform crm_private.log_artist_activity(
      v.artist_id,'appointment.status_changed','system',null,
      v.client_id,v.enquiry_id,v.project_id,v.id,null,
      jsonb_build_object('appointment_type',v.appointment_type,
        'from_status','confirmed','to_status','completed',
        'completion_source','scheduled_end')
    );
    if public.session_is_calendar_eligible('completed'::public.session_status) then
      if v.calendar_event_id is null then
        perform crm_private.enqueue_outbox(
          'calendar_create',
          public.calendar_outbox_dedupe_key('create',v.id,v.calendar_version+1),
          jsonb_build_object('session_id',v.id,'appointment_type',v.appointment_type,
            'calendar_version',v.calendar_version+1),
          v.client_id,v.enquiry_id,v.project_id,v.id,null
        );
      else
        perform crm_private.enqueue_outbox(
          'calendar_update',
          public.calendar_outbox_dedupe_key('update',v.id,v.calendar_version+1),
          jsonb_build_object('session_id',v.id,'appointment_type',v.appointment_type,
            'calendar_version',v.calendar_version+1),
          v.client_id,v.enquiry_id,v.project_id,v.id,null
        );
      end if;
    end if;
    n := n+1;
  end loop;
  return n;
end;
$fn$;

revoke all on function crm_private.auto_complete_due_tattoo_sessions(integer)
  from public, anon, authenticated, service_role;

drop function if exists crm_private.resolve_evidenced_consultations(integer);
