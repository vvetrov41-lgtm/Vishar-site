-- Foundation only: this function does not alter jobs, send messages or change
-- lifecycle execution. Dispatch integration and historical deduplication are
-- required before this migration can be considered a release-ready feature.
-- Evidence-based actual finish time is optional. Automatic schedule-based
-- completion must leave it NULL; the scheduled end remains the fallback.
alter table public.sessions
  add column if not exists actual_end_at timestamptz;
alter table public.sessions
  add constraint sessions_actual_end_completed
  check (actual_end_at is null or
    (status = 'completed'::public.session_status and actual_end_at >= start_at));

create or replace function crm_private.session_lifecycle_block(p_session_id uuid)
returns table(session_id uuid, local_day date, start_at timestamptz, end_at timestamptz)
language sql stable security invoker
set search_path = pg_catalog, public, crm_private
as $function$
  with target as (
    select s.*, a.timezone
    from public.sessions s
    join public.artists a on a.id = s.artist_id
    where s.id = p_session_id
      and s.status in ('confirmed', 'completed')
      and s.appointment_type in ('tattoo_session', 'touch_up')
  ), candidates as (
    select s.id, s.start_at, s.end_at, (s.start_at at time zone t.timezone)::date as local_day
    from target t
    join public.sessions s on s.artist_id = t.artist_id
      and (s.id = t.id or (
        t.client_id is not null and t.project_id is not null
        and s.client_id = t.client_id and s.project_id = t.project_id
      ))
      and s.status in ('confirmed', 'completed')
      and s.appointment_type in ('tattoo_session', 'touch_up')
  ), days as (
    select distinct c.local_day from candidates c
  ), ranked as (
    select d.local_day,
      d.local_day - row_number() over (order by d.local_day)::integer as block_key
    from days d
  ), target_key as (
    select r.block_key from ranked r
    join target t on r.local_day = (t.start_at at time zone t.timezone)::date
  )
  select c.id, c.local_day, c.start_at, c.end_at
  from candidates c
  join ranked r on r.local_day = c.local_day
  join target_key k on k.block_key = r.block_key
  order by c.start_at, c.id;
$function$;

revoke all on function crm_private.session_lifecycle_block(uuid)
  from public, anon, authenticated, service_role;
comment on function crm_private.session_lifecycle_block(uuid) is
  'Internal, non-dispatching consecutive local-day grouping. Requires matching artist, client and project; sessions without client or project are isolated.';
