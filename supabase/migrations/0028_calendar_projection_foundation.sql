-- 0028_calendar_projection_foundation.sql
--
-- Add explicit calendar sync state and authorised workflow primitives while
-- keeping public.sessions authoritative. No Google credentials or live
-- provider drain are introduced by this migration.

do $$ begin
  create type public.calendar_sync_status as enum (
    'not_connected', 'queued', 'synced', 'retrying', 'failed'
  );
exception when duplicate_object then null; end $$;

alter table public.sessions
  add column if not exists calendar_sync_status public.calendar_sync_status
  not null default 'not_connected';
alter table public.sessions
  add column if not exists calendar_last_synced_version integer;
alter table public.sessions
  add column if not exists calendar_last_synced_at timestamptz;
alter table public.sessions
  add column if not exists calendar_last_error_code text;

update public.sessions
set calendar_sync_status = case
  when calendar_provider = 'google' and calendar_event_id is not null then 'synced'::public.calendar_sync_status
  else 'not_connected'::public.calendar_sync_status
end,
calendar_last_synced_version = case
  when calendar_provider = 'google' and calendar_event_id is not null then calendar_version
  else null
end
where calendar_sync_status = 'not_connected';

alter table public.sessions
  add constraint sessions_calendar_sync_consistency
  check (
    (calendar_sync_status = 'synced'
      and calendar_provider = 'google'
      and calendar_event_id is not null
      and calendar_last_synced_version is not null
      and calendar_last_synced_at is not null
      and calendar_last_error_code is null)
    or calendar_sync_status <> 'synced'
  );

create index if not exists sessions_calendar_sync_status_idx
  on public.sessions (artist_id, calendar_sync_status, start_at);

grant select (
  calendar_sync_status,
  calendar_last_synced_version,
  calendar_last_synced_at,
  calendar_last_error_code
) on public.sessions to authenticated;

comment on column public.sessions.calendar_sync_status is
  'Safe CRM-visible state of the asynchronous calendar projection.';
comment on column public.sessions.calendar_last_synced_version is
  'Latest appointment calendar_version acknowledged by the provider drain.';
comment on column public.sessions.calendar_last_synced_at is
  'Timestamp of the latest successful provider acknowledgement.';
comment on column public.sessions.calendar_last_error_code is
  'Safe non-secret failure code from the calendar drain.';

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
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
  v_previous_start timestamptz;
  v_previous_end timestamptz;
  v_event_id text;
  v_version integer;
  v_next_version integer;
  v_outbox_kind public.outbox_kind;
  v_actor_kind text;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'appointment end must be after its start' using errcode = '22023';
  end if;

  select s.artist_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.status, s.start_at, s.end_at,
         s.calendar_event_id, s.calendar_version
    into v_artist, v_client, v_enquiry, v_project,
         v_type, v_status, v_previous_start, v_previous_end,
         v_event_id, v_version
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment % does not exist', p_appointment_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist, 'manage_sessions');
  perform crm_private.require_active_artist(v_artist);

  if v_status in ('completed', 'cancelled', 'no_show') then
    raise exception 'a terminal appointment cannot be rescheduled' using errcode = '42501';
  end if;

  if v_previous_start = p_start_at and v_previous_end = p_end_at then
    return jsonb_build_object('appointment_id', p_appointment_id, 'changed', false, 'calendar_version', v_version);
  end if;

  v_next_version := v_version + 1;

  update public.sessions
  set start_at = p_start_at,
      end_at = p_end_at,
      duration_hours = round(extract(epoch from (p_end_at - p_start_at))::numeric / 3600, 2),
      calendar_version = v_next_version,
      calendar_sync_status = case
        when public.session_is_calendar_eligible(v_status) then 'queued'::public.calendar_sync_status
        else 'not_connected'::public.calendar_sync_status
      end,
      calendar_last_error_code = null,
      updated_at = now()
  where id = p_appointment_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    v_artist, 'appointment.rescheduled', v_actor_kind, auth.uid(),
    v_client, v_enquiry, v_project, p_appointment_id, null,
    jsonb_build_object(
      'appointment_type', v_type,
      'from_start_at', v_previous_start,
      'from_end_at', v_previous_end,
      'to_start_at', p_start_at,
      'to_end_at', p_end_at,
      'calendar_version', v_next_version
    )
  );

  if public.session_is_calendar_eligible(v_status) then
    v_outbox_kind := case
      when v_event_id is null then 'calendar_create'::public.outbox_kind
      else 'calendar_update'::public.outbox_kind
    end;

    perform crm_private.enqueue_outbox(
      v_outbox_kind,
      public.calendar_outbox_dedupe_key(
        case when v_event_id is null then 'create' else 'update' end,
        p_appointment_id,
        v_next_version
      ),
      jsonb_build_object(
        'session_id', p_appointment_id,
        'appointment_type', v_type,
        'calendar_version', v_next_version
      ),
      v_client, v_enquiry, v_project, p_appointment_id, null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'changed', true,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'calendar_version', v_next_version,
    'calendar_operation', case
      when not public.session_is_calendar_eligible(v_status) then null
      when v_event_id is null then 'create'
      else 'update'
    end
  );
end;
$$;

revoke all on function public.reschedule_appointment(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;

comment on function public.reschedule_appointment(uuid,timestamptz,timestamptz) is
  'Closed workflow primitive until its authenticated ACL is added to the canonical API inventory.';

create or replace function public.record_calendar_sync_result(
  p_appointment_id uuid,
  p_calendar_version integer,
  p_succeeded boolean,
  p_provider public.calendar_provider default 'google',
  p_event_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_current_version integer;
  v_current_event_id text;
begin
  select s.calendar_version, s.calendar_event_id
    into v_current_version, v_current_event_id
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment % does not exist', p_appointment_id using errcode = '23503';
  end if;

  if p_calendar_version > v_current_version then
    raise exception 'calendar result version is ahead of the appointment version' using errcode = '22023';
  end if;

  if p_calendar_version < v_current_version then
    return jsonb_build_object(
      'appointment_id', p_appointment_id,
      'applied', false,
      'stale', true,
      'calendar_version', v_current_version
    );
  end if;

  if p_succeeded then
    if p_provider <> 'google' then
      raise exception 'unsupported calendar provider %', p_provider using errcode = '22023';
    end if;

    if coalesce(nullif(btrim(p_event_id), ''), v_current_event_id) is null then
      raise exception 'successful calendar sync requires an event id' using errcode = '22023';
    end if;

    update public.sessions
    set calendar_provider = p_provider,
        calendar_event_id = coalesce(nullif(btrim(p_event_id), ''), calendar_event_id),
        calendar_sync_status = 'synced',
        calendar_last_synced_version = p_calendar_version,
        calendar_last_synced_at = now(),
        calendar_last_error_code = null,
        updated_at = now()
    where id = p_appointment_id;
  else
    if nullif(btrim(p_error_code), '') is null then
      raise exception 'failed calendar sync requires a safe error code' using errcode = '22023';
    end if;

    update public.sessions
    set calendar_sync_status = 'failed',
        calendar_last_error_code = left(btrim(p_error_code), 100),
        updated_at = now()
    where id = p_appointment_id;
  end if;

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'applied', true,
    'stale', false,
    'calendar_version', p_calendar_version,
    'sync_status', case when p_succeeded then 'synced' else 'failed' end
  );
end;
$$;

revoke all on function public.record_calendar_sync_result(uuid,integer,boolean,public.calendar_provider,text,text)
  from public, anon, authenticated, service_role;

comment on function public.record_calendar_sync_result(uuid,integer,boolean,public.calendar_provider,text,text) is
  'Closed backend primitive until its service-role ACL is added to the canonical API inventory.';
