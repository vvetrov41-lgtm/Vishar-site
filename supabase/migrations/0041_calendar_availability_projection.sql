-- 0041_calendar_availability_projection.sql
--
-- Durable Google Calendar projection for CRM-authoritative artist Availability /
-- Time Off. Appointment projection remains unchanged and keeps its existing
-- claim/ack path. Time Off gets separate versioned jobs so stale provider
-- results cannot overwrite newer CRM state.
--
-- Provider credentials remain outside Supabase. Outbox payloads carry only
-- identifiers and projection versions. Availability notes are never copied to
-- the outbox or provider projection.
--
-- Forward-only. No OAuth consent, provider call, cron or deployment is enabled.

-- ---------------------------------------------------------------------------
-- Availability projection state
-- ---------------------------------------------------------------------------

alter table public.artist_availability_blocks
  add column if not exists calendar_provider public.calendar_provider
    not null default 'none';
alter table public.artist_availability_blocks
  add column if not exists calendar_event_id text;
alter table public.artist_availability_blocks
  add column if not exists calendar_version integer not null default 0;
alter table public.artist_availability_blocks
  add column if not exists calendar_sync_status public.calendar_sync_status
    not null default 'not_connected';
alter table public.artist_availability_blocks
  add column if not exists calendar_last_synced_version integer;
alter table public.artist_availability_blocks
  add column if not exists calendar_last_synced_at timestamptz;
alter table public.artist_availability_blocks
  add column if not exists calendar_last_error_code text;

alter table public.artist_availability_blocks
  add constraint artist_availability_calendar_version_non_negative
  check (calendar_version >= 0);
alter table public.artist_availability_blocks
  add constraint artist_availability_calendar_last_version_valid
  check (
    calendar_last_synced_version is null
    or calendar_last_synced_version between 0 and calendar_version
  );
alter table public.artist_availability_blocks
  add constraint artist_availability_calendar_error_code_shape
  check (
    calendar_last_error_code is null
    or calendar_last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'
  );
alter table public.artist_availability_blocks
  add constraint artist_availability_calendar_synced_consistency
  check (
    (
      calendar_sync_status = 'synced'
      and calendar_provider = 'google'
      and calendar_event_id is not null
      and calendar_last_synced_version = calendar_version
      and calendar_last_synced_at is not null
      and calendar_last_error_code is null
    )
    or calendar_sync_status <> 'synced'
  );

create index if not exists artist_availability_calendar_sync_idx
  on public.artist_availability_blocks (artist_id, calendar_sync_status, start_at)
  where cancelled_at is null;
create unique index if not exists artist_availability_blocks_id_artist_key
  on public.artist_availability_blocks (id, artist_id);

comment on column public.artist_availability_blocks.calendar_event_id is
  'Provider event identity for this CRM-authoritative Time Off block. Provider credentials never enter this table.';
comment on column public.artist_availability_blocks.calendar_version is
  'Monotonic projection version. Every Time Off mutation increments it before a provider job is queued.';
comment on column public.artist_availability_blocks.calendar_sync_status is
  'Safe CRM-visible state of asynchronous Time Off Calendar projection.';

-- ---------------------------------------------------------------------------
-- Explicit Time Off outbox identity
-- ---------------------------------------------------------------------------

alter table public.integration_outbox
  add column if not exists availability_block_id uuid;

alter table public.integration_outbox
  add constraint integration_outbox_availability_block_artist_fkey
  foreign key (availability_block_id, artist_id)
  references public.artist_availability_blocks(id, artist_id)
  on delete restrict;

alter table public.integration_outbox
  add constraint integration_outbox_calendar_availability_entity
  check (
    (
      kind in (
        'calendar_availability_create',
        'calendar_availability_update',
        'calendar_availability_cancel'
      )
      and availability_block_id is not null
      and session_id is null
      and email_message_id is null
    )
    or (
      kind not in (
        'calendar_availability_create',
        'calendar_availability_update',
        'calendar_availability_cancel'
      )
      and availability_block_id is null
    )
  );

create index if not exists integration_outbox_calendar_availability_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind in (
    'calendar_availability_create',
    'calendar_availability_update',
    'calendar_availability_cancel'
  ) and status in ('pending', 'failed', 'leased');

comment on column public.integration_outbox.availability_block_id is
  'Time Off projection identity for calendar_availability_* jobs. Appointment calendar jobs continue to use session_id.';

-- Existing scope_outbox_artist() does not resolve this new link. New Time Off
-- jobs therefore always supply artist_id explicitly, while the composite FK
-- above proves the block belongs to that same artist.

create or replace function crm_private.enqueue_availability_calendar_outbox(
  p_kind public.outbox_kind,
  p_block_id uuid,
  p_artist_id uuid,
  p_calendar_version integer
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_action text;
  v_id uuid := gen_random_uuid();
begin
  v_action := case p_kind
    when 'calendar_availability_create' then 'create'
    when 'calendar_availability_update' then 'update'
    when 'calendar_availability_cancel' then 'cancel'
    else null
  end;

  if v_action is null then
    raise exception 'unsupported availability calendar outbox kind'
      using errcode = '22023';
  end if;
  if p_block_id is null or p_artist_id is null or p_calendar_version is null
     or p_calendar_version < 0 then
    raise exception 'availability calendar outbox identity is incomplete'
      using errcode = '22023';
  end if;

  insert into public.integration_outbox (
    id,
    kind,
    dedupe_key,
    payload,
    artist_id,
    availability_block_id
  ) values (
    v_id,
    p_kind,
    'calendar:availability:' || v_action || ':' || p_block_id || ':' || p_calendar_version,
    jsonb_build_object(
      'availability_block_id', p_block_id,
      'calendar_version', p_calendar_version
    ),
    p_artist_id,
    p_block_id
  );

  return v_id;
exception when unique_violation then
  return null;
end;
$$;

revoke all on function crm_private.enqueue_availability_calendar_outbox(
  public.outbox_kind,uuid,uuid,integer
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CRM-authoritative Time Off writes plus versioned projection enqueue
-- ---------------------------------------------------------------------------

create or replace function public.create_artist_availability_block(
  p_artist_id uuid,
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_note text;
  v_actor_kind text;
  v_version integer := 0;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'time off end must be after its start' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '366 days' then
    raise exception 'one time off block may not exceed 366 days' using errcode = '22023';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'time off note may not exceed 500 characters' using errcode = '22023';
  end if;

  perform crm_private.lock_artist_schedule(p_artist_id);
  perform crm_private.assert_block_has_no_active_appointments(p_artist_id, p_start_at, p_end_at);
  perform crm_private.assert_no_other_availability_block(p_artist_id, p_start_at, p_end_at, null);

  insert into public.artist_availability_blocks (
    artist_id, block_kind, start_at, end_at, is_all_day, note,
    created_by, updated_by,
    calendar_version, calendar_sync_status, calendar_last_error_code
  ) values (
    p_artist_id, p_block_kind, p_start_at, p_end_at, coalesce(p_is_all_day, false), v_note,
    auth.uid(), auth.uid(),
    v_version, 'queued', null
  ) returning id into v_id;

  perform crm_private.enqueue_availability_calendar_outbox(
    'calendar_availability_create', v_id, p_artist_id, v_version
  );

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    p_artist_id,
    'availability.block_created',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', v_id,
      'block_kind', p_block_kind,
      'start_at', p_start_at,
      'end_at', p_end_at,
      'is_all_day', coalesce(p_is_all_day, false),
      'calendar_version', v_version
    )
  );

  return jsonb_build_object(
    'availability_block_id', v_id,
    'artist_id', p_artist_id,
    'block_kind', p_block_kind,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'is_all_day', coalesce(p_is_all_day, false),
    'calendar_version', v_version,
    'calendar_operation', 'create',
    'changed', true
  );
end;
$$;

create or replace function public.update_artist_availability_block(
  p_block_id uuid,
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_block public.artist_availability_blocks%rowtype;
  v_note text;
  v_actor_kind text;
  v_next_version integer;
  v_outbox_kind public.outbox_kind;
begin
  select b.* into v_block
  from public.artist_availability_blocks b
  where b.id = p_block_id
  for update;

  if not found then
    raise exception 'availability block % does not exist', p_block_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_block.artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(v_block.artist_id);

  if v_block.cancelled_at is not null then
    raise exception 'a cancelled availability block cannot be edited' using errcode = '42501';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'time off end must be after its start' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '366 days' then
    raise exception 'one time off block may not exceed 366 days' using errcode = '22023';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'time off note may not exceed 500 characters' using errcode = '22023';
  end if;

  perform crm_private.lock_artist_schedule(v_block.artist_id);
  perform crm_private.assert_block_has_no_active_appointments(v_block.artist_id, p_start_at, p_end_at);
  perform crm_private.assert_no_other_availability_block(
    v_block.artist_id, p_start_at, p_end_at, p_block_id
  );

  if v_block.block_kind = p_block_kind
     and v_block.start_at = p_start_at
     and v_block.end_at = p_end_at
     and v_block.is_all_day = coalesce(p_is_all_day, false)
     and v_block.note is not distinct from v_note then
    return jsonb_build_object(
      'availability_block_id', p_block_id,
      'artist_id', v_block.artist_id,
      'calendar_version', v_block.calendar_version,
      'changed', false
    );
  end if;

  v_next_version := v_block.calendar_version + 1;
  v_outbox_kind := case
    when v_block.calendar_event_id is null
      then 'calendar_availability_create'::public.outbox_kind
    else 'calendar_availability_update'::public.outbox_kind
  end;

  update public.artist_availability_blocks b
  set block_kind = p_block_kind,
      start_at = p_start_at,
      end_at = p_end_at,
      is_all_day = coalesce(p_is_all_day, false),
      note = v_note,
      updated_by = auth.uid(),
      calendar_version = v_next_version,
      calendar_sync_status = 'queued',
      calendar_last_error_code = null
  where b.id = p_block_id;

  perform crm_private.enqueue_availability_calendar_outbox(
    v_outbox_kind, p_block_id, v_block.artist_id, v_next_version
  );

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_block.artist_id,
    'availability.block_updated',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', p_block_id,
      'from_block_kind', v_block.block_kind,
      'from_start_at', v_block.start_at,
      'from_end_at', v_block.end_at,
      'to_block_kind', p_block_kind,
      'to_start_at', p_start_at,
      'to_end_at', p_end_at,
      'is_all_day', coalesce(p_is_all_day, false),
      'calendar_version', v_next_version
    )
  );

  return jsonb_build_object(
    'availability_block_id', p_block_id,
    'artist_id', v_block.artist_id,
    'block_kind', p_block_kind,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'is_all_day', coalesce(p_is_all_day, false),
    'calendar_version', v_next_version,
    'calendar_operation', case v_outbox_kind
      when 'calendar_availability_create' then 'create'
      else 'update'
    end,
    'changed', true
  );
end;
$$;

create or replace function public.cancel_artist_availability_block(p_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_block public.artist_availability_blocks%rowtype;
  v_actor_kind text;
  v_next_version integer;
begin
  select b.* into v_block
  from public.artist_availability_blocks b
  where b.id = p_block_id
  for update;

  if not found then
    raise exception 'availability block % does not exist', p_block_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_block.artist_id, 'manage_sessions');
  perform crm_private.lock_artist_schedule(v_block.artist_id);

  if v_block.cancelled_at is not null then
    return jsonb_build_object(
      'availability_block_id', p_block_id,
      'artist_id', v_block.artist_id,
      'calendar_version', v_block.calendar_version,
      'changed', false
    );
  end if;

  v_next_version := v_block.calendar_version + 1;

  update public.artist_availability_blocks b
  set cancelled_at = now(),
      updated_by = auth.uid(),
      calendar_version = v_next_version,
      calendar_sync_status = 'queued',
      calendar_last_error_code = null
  where b.id = p_block_id;

  -- Always queue deterministic deletion. If a create reached Google but its
  -- acknowledgement was lost, calendar_event_id may still be NULL locally;
  -- the provider layer can derive the stable event id and delete it safely.
  perform crm_private.enqueue_availability_calendar_outbox(
    'calendar_availability_cancel', p_block_id, v_block.artist_id, v_next_version
  );

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_block.artist_id,
    'availability.block_cancelled',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', p_block_id,
      'block_kind', v_block.block_kind,
      'start_at', v_block.start_at,
      'end_at', v_block.end_at,
      'calendar_version', v_next_version
    )
  );

  return jsonb_build_object(
    'availability_block_id', p_block_id,
    'artist_id', v_block.artist_id,
    'calendar_version', v_next_version,
    'calendar_operation', 'cancel',
    'changed', true
  );
end;
$$;

-- Preserve the existing authenticated-only CRM write surface.
revoke all on function public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_artist_availability_block(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  to authenticated;
grant execute on function public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  to authenticated;
grant execute on function public.cancel_artist_availability_block(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Backend Time Off lease
-- ---------------------------------------------------------------------------

create or replace function public.claim_calendar_availability_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  availability_block_id uuid,
  calendar_version integer,
  current_calendar_version integer,
  attempt_count integer,
  max_attempts integer,
  block_kind public.availability_block_kind,
  start_at timestamptz,
  end_at timestamptz,
  is_all_day boolean,
  artist_timezone text,
  calendar_event_id text,
  cancelled boolean,
  job_valid boolean,
  obsolete boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar availability outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'calendar worker id is invalid' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'calendar availability claim limit must be between 1 and 20'
      using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'calendar availability lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind in (
        'calendar_availability_create',
        'calendar_availability_update',
        'calendar_availability_cancel'
      )
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'leased' and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit p_limit
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  ),
  parsed as (
    select
      l.*,
      b.id as block_row_id,
      b.artist_id as block_artist_id,
      b.calendar_version as block_calendar_version,
      b.block_kind as current_block_kind,
      b.start_at as block_start_at,
      b.end_at as block_end_at,
      b.is_all_day as block_is_all_day,
      b.calendar_event_id as block_calendar_event_id,
      b.cancelled_at,
      a.timezone as block_artist_timezone,
      case
        when coalesce(l.payload ->> 'calendar_version', '') ~ '^[0-9]{1,9}$'
          then (l.payload ->> 'calendar_version')::integer
        else null
      end as payload_calendar_version
    from leased l
    left join public.artist_availability_blocks b on b.id = l.availability_block_id
    left join public.artists a on a.id = b.artist_id
  ),
  marked_retrying as (
    update public.artist_availability_blocks b
    set calendar_sync_status = 'retrying',
        calendar_last_error_code = null
    from parsed p
    where b.id = p.block_row_id
      and p.payload_calendar_version = p.block_calendar_version
      and p.payload ->> 'availability_block_id' = p.block_row_id::text
      and p.artist_id = p.block_artist_id
      and (
        (p.kind in ('calendar_availability_create', 'calendar_availability_update')
          and p.cancelled_at is null)
        or (p.kind = 'calendar_availability_cancel' and p.cancelled_at is not null)
      )
    returning b.id
  )
  select
    p.id,
    p.artist_id,
    p.kind,
    p.availability_block_id,
    p.payload_calendar_version,
    p.block_calendar_version,
    p.attempt_count,
    p.max_attempts,
    p.current_block_kind,
    p.block_start_at,
    p.block_end_at,
    p.block_is_all_day,
    p.block_artist_timezone,
    p.block_calendar_event_id,
    p.cancelled_at is not null,
    (
      p.block_row_id is not null
      and p.payload_calendar_version is not null
      and p.payload ->> 'availability_block_id' = p.block_row_id::text
      and p.artist_id = p.block_artist_id
      and (
        p.payload_calendar_version < p.block_calendar_version
        or (
          p.payload_calendar_version = p.block_calendar_version
          and (
            (p.kind in ('calendar_availability_create', 'calendar_availability_update')
              and p.cancelled_at is null)
            or (p.kind = 'calendar_availability_cancel' and p.cancelled_at is not null)
          )
        )
      )
    ),
    (
      p.payload_calendar_version is not null
      and p.block_calendar_version is not null
      and p.payload_calendar_version < p.block_calendar_version
    )
  from parsed p
  left join marked_retrying mr on mr.id = p.block_row_id
  order by p.next_attempt_at, p.created_at, p.id;
end;
$$;

revoke all on function public.claim_calendar_availability_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_calendar_availability_outbox(text,integer,integer)
  to service_role;

comment on function public.claim_calendar_availability_outbox(text,integer,integer) is
  'Backend-only SKIP LOCKED lease for versioned artist Time Off Calendar jobs. Returns no note, credential or account secret.';

-- ---------------------------------------------------------------------------
-- Backend Time Off acknowledgement
-- ---------------------------------------------------------------------------

create or replace function crm_private.dead_letter_calendar_availability_outbox(
  p_outbox_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_attempt_count integer;
begin
  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in (
      'calendar_availability_create',
      'calendar_availability_update',
      'calendar_availability_cancel'
    )
  for update;

  if not found then
    raise exception 'calendar availability outbox job is unavailable'
      using errcode = '22023';
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  update public.integration_outbox o
  set status = 'dead',
      attempt_count = v_attempt_count,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'calendar_job_invalid'), 100),
      updated_at = now()
  where o.id = p_outbox_id;

  perform crm_private.log_activity(
    'outbox.failed', 'worker', null,
    null, null, null, null, null,
    null, null, p_outbox_id,
    jsonb_build_object(
      'availability_block_id', v_job.availability_block_id,
      'attempt_count', v_attempt_count,
      'error_code', left(coalesce(nullif(btrim(p_error_code), ''), 'calendar_job_invalid'), 100),
      'dead_letter', true
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', 'dead',
    'attempt_count', v_attempt_count,
    'changed', true,
    'invalid', true
  );
end;
$$;

revoke all on function crm_private.dead_letter_calendar_availability_outbox(uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.record_calendar_availability_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_calendar_version integer,
  p_succeeded boolean,
  p_event_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_block public.artist_availability_blocks%rowtype;
  v_job_version integer;
  v_attempt_count integer;
  v_status public.outbox_status;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar availability outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'calendar worker id is invalid' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'calendar availability outbox result is required' using errcode = '22023';
  end if;
  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed calendar result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in (
      'calendar_availability_create',
      'calendar_availability_update',
      'calendar_availability_cancel'
    )
  for update;

  if not found then
    raise exception 'calendar availability outbox job is unavailable'
      using errcode = '22023';
  end if;

  if v_job.status = 'succeeded' then
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'calendar availability outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  if coalesce(v_job.payload ->> 'calendar_version', '') !~ '^[0-9]{1,9}$' then
    if p_succeeded then
      raise exception 'calendar availability outbox version is invalid'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_availability_outbox(p_outbox_id, p_error_code);
  end if;
  v_job_version := (v_job.payload ->> 'calendar_version')::integer;

  if p_calendar_version is distinct from v_job_version then
    if p_succeeded then
      raise exception 'calendar result version does not match the leased availability job'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_availability_outbox(p_outbox_id, p_error_code);
  end if;

  select b.* into v_block
  from public.artist_availability_blocks b
  where b.id = v_job.availability_block_id
  for update;

  if not found
     or v_job.artist_id is distinct from v_block.artist_id
     or v_job.payload ->> 'availability_block_id' is distinct from v_block.id::text then
    if p_succeeded then
      raise exception 'calendar availability outbox job does not match its block'
        using errcode = '23514';
    end if;
    return crm_private.dead_letter_calendar_availability_outbox(p_outbox_id, p_error_code);
  end if;

  if v_job_version > v_block.calendar_version then
    if p_succeeded then
      raise exception 'calendar result version is ahead of the availability version'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_availability_outbox(p_outbox_id, p_error_code);
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  if v_job_version < v_block.calendar_version then
    update public.integration_outbox o
    set status = 'succeeded',
        attempt_count = v_attempt_count,
        leased_by = null,
        leased_at = null,
        lease_expires_at = null,
        last_error_code = null,
        updated_at = now()
    where o.id = p_outbox_id;

    perform crm_private.log_activity(
      'outbox.succeeded', 'worker', null,
      null, null, null, null, null,
      null, null, p_outbox_id,
      jsonb_build_object(
        'availability_block_id', v_block.id,
        'attempt_count', v_attempt_count,
        'calendar_version', v_job_version,
        'obsolete', true
      )
    );

    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_attempt_count,
      'changed', true,
      'stale', true,
      'calendar_version', v_block.calendar_version
    );
  end if;

  if p_succeeded then
    if v_job.kind in ('calendar_availability_create', 'calendar_availability_update') then
      if v_block.cancelled_at is not null then
        raise exception 'active availability result does not match a cancelled block'
          using errcode = '23514';
      end if;
      if nullif(btrim(p_event_id), '') is null then
        raise exception 'successful availability create/update requires an event id'
          using errcode = '22023';
      end if;

      update public.artist_availability_blocks b
      set calendar_provider = 'google',
          calendar_event_id = btrim(p_event_id),
          calendar_sync_status = 'synced',
          calendar_last_synced_version = v_job_version,
          calendar_last_synced_at = now(),
          calendar_last_error_code = null
      where b.id = v_block.id;
    else
      if v_block.cancelled_at is null then
        raise exception 'availability cancellation result does not match block state'
          using errcode = '23514';
      end if;

      update public.artist_availability_blocks b
      set calendar_provider = 'none',
          calendar_event_id = null,
          calendar_sync_status = 'not_connected',
          calendar_last_synced_version = v_job_version,
          calendar_last_synced_at = now(),
          calendar_last_error_code = null
      where b.id = v_block.id;
    end if;

    v_status := 'succeeded';
  else
    update public.artist_availability_blocks b
    set calendar_sync_status = 'failed',
        calendar_last_error_code = left(btrim(p_error_code), 100)
    where b.id = v_block.id
      and b.calendar_version = v_job_version;

    v_status := case
      when p_error_code in (
        'artist_route_unconfigured',
        'calendar_encryption_key_invalid',
        'calendar_event_missing',
        'calendar_not_configured',
        'calendar_oauth_expired',
        'calendar_provider_rejected',
        'calendar_scope_missing',
        'calendar_token_invalid',
        'google_account_mismatch',
        'provider_route_invalid'
      ) then 'dead'::public.outbox_status
      when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
      else 'failed'::public.outbox_status
    end;
  end if;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then o.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker', null,
    null, null, null, null, null,
    null, null, p_outbox_id,
    jsonb_build_object(
      'availability_block_id', v_block.id,
      'attempt_count', v_attempt_count,
      'calendar_version', v_job_version,
      'error_code', case when p_succeeded then null else p_error_code end
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true,
    'stale', false,
    'calendar_version', v_job_version
  );
end;
$$;

revoke all on function public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)
  to service_role;

comment on function public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text) is
  'Backend-only Time Off Calendar acknowledgement with lease ownership, version matching, stale-result retirement and bounded retry state.';

-- ---------------------------------------------------------------------------
-- Route mapping for explicit Time Off calendar kinds
-- ---------------------------------------------------------------------------

create or replace function public.resolve_outbox_route(p_outbox_id uuid)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  integration_type public.artist_integration_type,
  provider text,
  integration_key text,
  external_account_label text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_kind public.outbox_kind;
  v_integration_type public.artist_integration_type;
begin
  if not crm_private.is_service_backend() then
    raise exception 'outbox route resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'outbox id is required' using errcode = '22023';
  end if;

  select o.artist_id, o.kind into v_artist_id, v_kind
  from public.integration_outbox o
  where o.id = p_outbox_id;
  if not found then
    raise exception 'outbox route is unavailable' using errcode = '22023';
  end if;

  v_integration_type := case v_kind
    when 'telegram_notification' then 'telegram'::public.artist_integration_type
    when 'transactional_email' then 'email'::public.artist_integration_type
    when 'approved_email' then 'email'::public.artist_integration_type
    when 'calendar_create' then 'calendar'::public.artist_integration_type
    when 'calendar_update' then 'calendar'::public.artist_integration_type
    when 'calendar_cancel' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_create' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_update' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_cancel' then 'calendar'::public.artist_integration_type
    else null
  end;
  if v_integration_type is null then
    raise exception 'outbox kind has no provider route' using errcode = '22023';
  end if;

  return query
  select o.id, o.artist_id, o.kind, v_integration_type,
         i.provider, i.integration_key, i.external_account_label, i.configuration
  from public.integration_outbox o
  join public.artist_integrations i
    on i.artist_id = o.artist_id
   and i.integration_type = v_integration_type
   and i.is_enabled
  join crm_private.artist_state a
    on a.artist_id = o.artist_id and a.is_active
  where o.id = p_outbox_id;

  if not found then
    raise exception 'artist provider route is unavailable' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_outbox_route(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_outbox_route(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Reconcile Time Off after a Calendar connection/reconnection
-- ---------------------------------------------------------------------------

create or replace function crm_private.reconcile_artist_availability_calendar(
  p_artist_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_block public.artist_availability_blocks%rowtype;
  v_next_version integer;
  v_kind public.outbox_kind;
  v_count integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar availability reconciliation is backend-only'
      using errcode = '42501';
  end if;

  perform crm_private.require_active_artist(p_artist_id);
  perform pg_advisory_xact_lock(hashtextextended('crm:artist-schedule:' || p_artist_id::text, 0));

  for v_block in
    select b.*
    from public.artist_availability_blocks b
    where b.artist_id = p_artist_id
      and (
        (
          b.cancelled_at is null
          and (
            b.calendar_sync_status <> 'synced'
            or b.calendar_last_synced_version is distinct from b.calendar_version
          )
        )
        or (
          b.cancelled_at is not null
          and b.calendar_last_synced_version is distinct from b.calendar_version
        )
      )
    order by b.start_at, b.id
    for update
  loop
    v_next_version := v_block.calendar_version + 1;
    v_kind := case
      when v_block.cancelled_at is not null
        then 'calendar_availability_cancel'::public.outbox_kind
      when v_block.calendar_event_id is null
        then 'calendar_availability_create'::public.outbox_kind
      else 'calendar_availability_update'::public.outbox_kind
    end;

    update public.artist_availability_blocks b
    set calendar_version = v_next_version,
        calendar_sync_status = 'queued',
        calendar_last_error_code = null
    where b.id = v_block.id;

    perform crm_private.enqueue_availability_calendar_outbox(
      v_kind, v_block.id, p_artist_id, v_next_version
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function crm_private.reconcile_artist_availability_calendar(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.set_calendar_connection_metadata(
  p_artist_id uuid,
  p_integration_key text,
  p_external_account_label text,
  p_is_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
  v_external_account_label text;
  v_integration_id uuid;
  v_reconciled integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar connection metadata is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null or p_is_enabled is null then
    raise exception 'calendar connection metadata is incomplete'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  select a.slug
  into v_artist_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_artist_slug not in ('vladimir', 'kristina') then
    raise exception 'calendar artist route is unsupported'
      using errcode = '22023';
  end if;

  if p_integration_key is distinct from ('google_calendar_' || v_artist_slug) then
    raise exception 'calendar integration key does not match artist route'
      using errcode = '22023';
  end if;

  v_external_account_label := lower(btrim(coalesce(p_external_account_label, '')));
  if v_external_account_label = ''
     or length(v_external_account_label) > 320
     or v_external_account_label !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'calendar account label is invalid'
      using errcode = '22023';
  end if;

  insert into public.artist_integrations (
    artist_id,
    integration_type,
    provider,
    integration_key,
    external_account_label,
    configuration,
    is_enabled
  ) values (
    p_artist_id,
    'calendar',
    'google',
    p_integration_key,
    v_external_account_label,
    jsonb_build_object(
      'calendar_id', 'primary',
      'oauth_scope', 'calendar.events',
      'connection_mode', 'worker_oauth'
    ),
    p_is_enabled
  )
  on conflict (artist_id, integration_type, integration_key) do update
    set provider = 'google',
        external_account_label = excluded.external_account_label,
        configuration = excluded.configuration,
        is_enabled = excluded.is_enabled,
        updated_at = now()
  returning id into v_integration_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    case
      when p_is_enabled then 'integration.calendar_connected'
      else 'integration.calendar_disconnected'
    end,
    'worker',
    null,
    null, null, null, null, null,
    jsonb_build_object(
      'integration_type', 'calendar',
      'provider', 'google',
      'integration_key', p_integration_key,
      'is_enabled', p_is_enabled
    )
  );

  if p_is_enabled then
    v_reconciled := crm_private.reconcile_artist_availability_calendar(p_artist_id);
  end if;

  return jsonb_build_object(
    'integration_id', v_integration_id,
    'artist_id', p_artist_id,
    'provider', 'google',
    'integration_key', p_integration_key,
    'is_enabled', p_is_enabled,
    'reconciled_availability_jobs', v_reconciled
  );
end;
$$;

revoke all on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_calendar_connection_metadata(uuid,text,text,boolean)
  to service_role;

-- Connection status keeps its established return signature while counting both
-- appointment and Time Off Calendar work.
create or replace function public.list_calendar_connection_status()
returns table (
  artist_id uuid,
  artist_slug text,
  artist_display_name text,
  provider text,
  integration_key text,
  connected boolean,
  external_account_label text,
  connection_updated_at timestamptz,
  last_successful_sync_at timestamptz,
  queued_jobs integer,
  retrying_jobs integer,
  failed_jobs integer,
  last_error_code text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with supported_artists as (
    select
      a.id,
      a.slug,
      a.display_name,
      case a.slug
        when 'vladimir' then 'google_calendar_vladimir'
        when 'kristina' then 'google_calendar_kristina'
      end as expected_integration_key
    from public.artists a
    where a.is_active
      and a.slug in ('vladimir', 'kristina')
      and public.can_manage_artist_integrations(a.id)
  ),
  calendar_jobs as (
    select
      o.artist_id,
      count(*) filter (where o.status = 'pending')::integer as queued_jobs,
      count(*) filter (where o.status = 'leased')::integer as retrying_jobs,
      count(*) filter (
        where o.status in ('failed', 'dead')
          and (i.updated_at is null or o.updated_at >= i.updated_at)
      )::integer as failed_jobs
    from public.integration_outbox o
    join supported_artists a on a.id = o.artist_id
    left join public.artist_integrations i
      on i.artist_id = a.id
     and i.integration_type = 'calendar'
     and i.provider = 'google'
     and i.integration_key = a.expected_integration_key
    where o.kind in (
      'calendar_create', 'calendar_update', 'calendar_cancel',
      'calendar_availability_create', 'calendar_availability_update', 'calendar_availability_cancel'
    )
    group by o.artist_id
  ),
  successful_syncs as (
    select s.artist_id, s.calendar_last_synced_at
    from public.sessions s
    join supported_artists a on a.id = s.artist_id
    where s.calendar_last_synced_at is not null
    union all
    select b.artist_id, b.calendar_last_synced_at
    from public.artist_availability_blocks b
    join supported_artists a on a.id = b.artist_id
    where b.calendar_last_synced_at is not null
  ),
  calendar_sync as (
    select artist_id, max(calendar_last_synced_at) as last_successful_sync_at
    from successful_syncs
    group by artist_id
  )
  select
    a.id as artist_id,
    a.slug as artist_slug,
    a.display_name as artist_display_name,
    coalesce(i.provider, 'google') as provider,
    a.expected_integration_key as integration_key,
    coalesce(i.is_enabled, false) as connected,
    i.external_account_label,
    i.updated_at as connection_updated_at,
    s.last_successful_sync_at,
    coalesce(j.queued_jobs, 0) as queued_jobs,
    coalesce(j.retrying_jobs, 0) as retrying_jobs,
    coalesce(j.failed_jobs, 0) as failed_jobs,
    e.last_error_code
  from supported_artists a
  left join public.artist_integrations i
    on i.artist_id = a.id
   and i.integration_type = 'calendar'
   and i.provider = 'google'
   and i.integration_key = a.expected_integration_key
  left join calendar_jobs j on j.artist_id = a.id
  left join calendar_sync s on s.artist_id = a.id
  left join lateral (
    select o.last_error_code
    from public.integration_outbox o
    where o.artist_id = a.id
      and o.kind in (
        'calendar_create', 'calendar_update', 'calendar_cancel',
        'calendar_availability_create', 'calendar_availability_update', 'calendar_availability_cancel'
      )
      and o.status in ('failed', 'dead')
      and o.last_error_code is not null
      and (i.updated_at is null or o.updated_at >= i.updated_at)
    order by o.updated_at desc, o.id desc
    limit 1
  ) e on true
  order by case a.slug when 'vladimir' then 1 else 2 end;
$$;

revoke all on function public.list_calendar_connection_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_calendar_connection_status()
  to authenticated;

-- New backend RPCs are the only additional Data API surface in this migration.
-- All helper functions remain private and ungranted.
