-- Phase 3: a session can finish any time after it starts, including before
-- the 30-minute mark. Availability is not evidence of attendance: the artist
-- still explicitly confirms the outcome and actual work duration.
--
-- Keep rollout filtering, consultation-after-end gating, RLS and all payment,
-- lifecycle and calendar RPC rules unchanged.

create or replace function crm_private.visit_outcome_due(p_artist_id uuid, p_now timestamptz)
returns table (session_id uuid, client_id uuid, appointment_type public.appointment_type,
               status public.session_status, start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select s.id, s.client_id, s.appointment_type, s.status, s.start_at, s.end_at
  from public.sessions s
  cross join crm_private.visit_outcome_rollout r
  where r.singleton and r.enabled_from is not null
    and s.artist_id = p_artist_id
    and s.cancelled_at is null
    and s.status in ('confirmed', 'completed')
    and s.end_at >= r.enabled_from
    and (
      (s.appointment_type in ('tattoo_session', 'touch_up')
       and s.start_at <= p_now)
      or (s.appointment_type in ('in_person_consultation', 'video_consultation')
          and s.end_at <= p_now)
    )
    and not exists (
      select 1 from public.visit_outcomes o
      where o.session_id = s.id
        and (o.state = 'confirmed' or o.deferred_until > p_now)
    );
$fn$;

revoke all on function crm_private.visit_outcome_due(uuid, timestamptz)
  from public, anon, authenticated, service_role;
