-- Fill a cancelled slot: who could take a freed appointment time.
--
-- When a client cancels, the time is usually lost: nobody remembers in the
-- moment which other clients have paid a deposit and still have no date, or
-- are due a touch-up, or are waiting for a consultation. In production on
-- 2026-11-16, 10 appointments were cancelled in the last 90 days (7 of them
-- 30-minute consultations, 3 tattoo sessions of 6-7 hours), and 2 projects had
-- a paid deposit and no future session.
--
-- public.list_cancelled_slot_candidates(session) reads, for a cancelled
-- appointment of the caller's artist whose time is still ahead and not taken
-- by another appointment, up to five clients who could take it, each with the
-- reason, how well the slot length fits, a contact and a draft message.
--
-- It is read-only. It sends nothing, queues nothing, books nothing and writes
-- no row: the artist copies the draft and sends it themselves. Access needs
-- view_sessions and view_clients on the appointment's artist. Clients who
-- unsubscribed, complained, were blocked or manually suppressed are left out.

-- English draft (clients write in English). Dates use the artist's time zone.
create or replace function crm_private.slot_fill_draft(
  p_reason text,
  p_client_name text,
  p_artist_name text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text
)
returns text
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare
  v_first text := nullif(split_part(btrim(coalesce(p_client_name, '')), ' ', 1), '');
  v_tz text := coalesce(nullif(p_timezone, ''), 'Europe/London');
  v_day text := to_char(p_start_at at time zone v_tz, 'FMDay FMDD FMMonth');
  v_from text := to_char(p_start_at at time zone v_tz, 'HH24:MI');
  v_to text := to_char(p_end_at at time zone v_tz, 'HH24:MI');
  v_hi text := 'Hi' || coalesce(' ' || v_first, '') || ', ';
  v_sign text := coalesce(E'\n' || nullif(btrim(p_artist_name), ''), '');
begin
  return case p_reason
    when 'touch_up_due' then
      v_hi || 'a slot has just opened up on ' || v_day || ' at ' || v_from
        || '. If your tattoo has healed, it would be a good time for a touch-up. Would that suit you?'
        || v_sign
    when 'enquiry_awaiting_consultation' then
      v_hi || 'a consultation slot has just opened up on ' || v_day || ' at ' || v_from
        || '. Would you like to come in and talk through your tattoo idea?'
        || v_sign
    else
      v_hi || 'a slot has just opened up on ' || v_day || ' from ' || v_from || ' to ' || v_to
        || '. Would you like to take it for your next session? Let me know and I will book you in.'
        || v_sign
  end;
end;
$fn$;

create or replace function crm_private.slot_fill_candidates(
  p_session_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  with slot as materialized (
    select
      s.id, s.artist_id, s.appointment_type, s.status, s.start_at, s.end_at,
      coalesce(s.duration_hours, extract(epoch from (s.end_at - s.start_at)) / 3600.0)::numeric as hours,
      coalesce(s.client_id, p.client_id) as own_client_id,
      a.timezone, a.display_name as artist_name,
      s.appointment_type in ('in_person_consultation', 'video_consultation') as is_consultation
    from public.sessions s
    join public.artists a on a.id = s.artist_id
    left join public.projects p on p.id = s.project_id
    where s.id = p_session_id
  ),
  state as materialized (
    select sl.*,
      case
        when sl.status <> 'cancelled' then 'not_cancelled'
        when sl.start_at <= p_now then 'past'
        when exists (
          select 1 from public.sessions o
          where o.artist_id = sl.artist_id
            and o.id <> sl.id
            and o.status in ('draft', 'proposed', 'confirmed')
            and o.cancelled_at is null
            and o.start_at < sl.end_at
            and o.end_at > sl.start_at
        ) then 'taken'
        else 'open'
      end as slot_state
    from slot sl
  ),
  -- Clients already holding a future appointment with this artist do not need
  -- the slot offered to them.
  booked as materialized (
    select distinct coalesce(f.client_id, fp.client_id) as client_id
    from state st
    join public.sessions f on f.artist_id = st.artist_id
    left join public.projects fp on fp.id = f.project_id
    where f.status in ('draft', 'proposed', 'confirmed')
      and f.cancelled_at is null
      and f.start_at > p_now
  ),
  project_hours as (
    select p.id as project_id,
      coalesce(
        case when p.estimated_hours > 0 and p.estimated_sessions > 0
          then round(p.estimated_hours / p.estimated_sessions, 1) end,
        (select x.duration_hours from public.sessions x
          where x.project_id = p.id and x.appointment_type = 'tattoo_session'
            and x.status in ('completed', 'confirmed')
          order by x.start_at desc limit 1)
      ) as needed_hours
    from public.projects p
    join state st on st.artist_id = p.artist_id
  ),
  raw as (
    -- 1. Paid deposit on a project, no date yet.
    select 1 as priority, 'deposit_paid_no_date'::text as reason,
      p.client_id, p.id as project_id, p.enquiry_id, null::uuid as follow_up_id,
      ph.needed_hours, coalesce(p.updated_at, p.created_at) as waiting_since
    from state st
    join public.projects p on p.artist_id = st.artist_id
    join project_hours ph on ph.project_id = p.id
    where not st.is_consultation
      and p.archived_at is null
      and p.status in ('draft', 'active', 'on_hold')
      and p.deposit_status = 'paid'

    union all
    -- 1b. Paid deposit recorded on the enquiry before a project exists.
    select 1, 'deposit_paid_no_date', e.client_id, null, e.id, null, null,
      coalesce(e.last_action_at, e.created_at)
    from state st
    join public.enquiries e on e.artist_id = st.artist_id
    where not st.is_consultation
      and e.archived_at is null
      and e.status = 'deposit_paid'
      and not exists (select 1 from public.projects p where p.enquiry_id = e.id and p.archived_at is null)

    union all
    -- 2. An open follow-up the artist already planned for this client.
    -- A follow-up created from an enquiry or project may carry no client id
    -- of its own, so resolve the client through the linked record.
    select 2, 'open_follow_up',
      coalesce(fu.client_id, fp.client_id, fe.client_id), fu.project_id, fu.enquiry_id, fu.id,
      ph.needed_hours, fu.due_at
    from state st
    join public.follow_ups fu on fu.artist_id = st.artist_id
    left join public.projects fp on fp.id = fu.project_id
    left join public.enquiries fe on fe.id = fu.enquiry_id
    left join project_hours ph on ph.project_id = fu.project_id
    where fu.status = 'open'
      and coalesce(fu.client_id, fp.client_id, fe.client_id) is not null
      and fu.due_at <= st.start_at + interval '14 days'

    union all
    -- 3. Touch-up due: last tattoo session of a project 4-16 weeks before the
    --    slot, and no touch-up booked or done after it.
    select 3, 'touch_up_due', p.client_id, p.id, p.enquiry_id, null, 1.0, last_s.start_at
    from state st
    join public.projects p on p.artist_id = st.artist_id
    join lateral (
      select x.start_at from public.sessions x
      where x.project_id = p.id and x.appointment_type = 'tattoo_session' and x.status = 'completed'
      order by x.start_at desc limit 1
    ) last_s on true
    where not st.is_consultation
      and p.archived_at is null
      and p.status <> 'cancelled'
      and last_s.start_at between st.start_at - interval '16 weeks' and st.start_at - interval '4 weeks'
      and not exists (
        select 1 from public.sessions t
        where t.project_id = p.id and t.appointment_type = 'touch_up'
          and t.status <> 'cancelled' and t.start_at > last_s.start_at
      )

    union all
    -- 4. Active project with no date and no paid deposit yet.
    select 4, 'project_no_date', p.client_id, p.id, p.enquiry_id, null,
      ph.needed_hours, coalesce(p.updated_at, p.created_at)
    from state st
    join public.projects p on p.artist_id = st.artist_id
    join project_hours ph on ph.project_id = p.id
    where not st.is_consultation
      and p.archived_at is null
      and p.status = 'active'
      and p.deposit_status in ('not_required', 'requested')
      and coalesce(p.updated_at, p.created_at) > p_now - interval '180 days'

    union all
    -- 5. Consultation slot: a recent enquiry still waiting for a consultation.
    select 5, 'enquiry_awaiting_consultation', e.client_id, null, e.id, null, 0.5,
      coalesce(e.last_action_at, e.created_at)
    from state st
    join public.enquiries e on e.artist_id = st.artist_id
    where st.is_consultation
      and e.archived_at is null
      and e.status in ('new', 'reviewing', 'accepted', 'quote_sent')
      and e.created_at > p_now - interval '60 days'
      and not exists (
        select 1 from public.sessions c
        where c.enquiry_id = e.id and c.status <> 'cancelled'
          and c.appointment_type in ('in_person_consultation', 'video_consultation')
      )
  ),
  fitted as (
    select r.*,
      case
        when r.needed_hours is null then 'unknown'
        when r.needed_hours <= st.hours then 'fits'
        else 'longer'
      end as fit
    from raw r
    cross join state st
  ),
  eligible as (
    select r.*, c.full_name, c.phone_normalized, c.email, c.instagram, c.preferred_contact,
      -- Same order as the final ranking, so a client's fitting project wins
      -- over an older one that is longer than the slot.
      row_number() over (
        partition by r.client_id
        order by r.priority,
          case r.fit when 'fits' then 0 when 'unknown' then 1 else 2 end,
          r.waiting_since nulls last
      ) as per_client
    from fitted r
    cross join state st
    join public.clients c on c.id = r.client_id
    where st.slot_state = 'open'
      and c.archived_at is null
      and r.client_id is distinct from st.own_client_id
      and not exists (select 1 from booked b where b.client_id = r.client_id)
      and not exists (
        select 1 from public.communication_suppressions cs
        where cs.client_id = r.client_id and cs.is_active
          and cs.reason in ('unsubscribed', 'complained', 'blocked', 'manual')
      )
  ),
  ranked as (
    select el.*,
      row_number() over (
        order by el.priority,
          case el.fit when 'fits' then 0 when 'unknown' then 1 else 2 end,
          el.waiting_since nulls last, el.client_id
      ) as rank
    from eligible el
    where el.per_client = 1
  )
  select jsonb_build_object(
    'slot', jsonb_build_object(
      'session_id', st.id,
      'artist_id', st.artist_id,
      'appointment_type', st.appointment_type,
      'start_at', st.start_at,
      'end_at', st.end_at,
      'duration_hours', st.hours,
      'timezone', st.timezone,
      'state', st.slot_state
    ),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
          'client_id', rk.client_id,
          'client_name', left(rk.full_name, 120),
          'reason', rk.reason,
          'project_id', rk.project_id,
          'enquiry_id', rk.enquiry_id,
          'follow_up_id', rk.follow_up_id,
          'needed_hours', rk.needed_hours,
          'fit', rk.fit,
          'phone', rk.phone_normalized,
          'email', rk.email,
          'instagram', rk.instagram,
          'preferred_contact', rk.preferred_contact,
          'draft_message', crm_private.slot_fill_draft(
            rk.reason, rk.full_name, st.artist_name, st.start_at, st.end_at, st.timezone)
        ) order by rk.rank)
      from ranked rk
      where rk.rank <= 5
    ), '[]'::jsonb)
  )
  from state st;
$fn$;

revoke all on function crm_private.slot_fill_candidates(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function crm_private.slot_fill_draft(text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated, service_role;

create or replace function public.list_cancelled_slot_candidates(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_artist uuid;
begin
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_artist, 'view_sessions');
  perform crm_private.require_artist_access(v_artist, 'view_clients');
  return crm_private.slot_fill_candidates(p_session_id, clock_timestamp());
end;
$fn$;

revoke all on function public.list_cancelled_slot_candidates(uuid) from public, anon, service_role;
grant execute on function public.list_cancelled_slot_candidates(uuid) to authenticated;
