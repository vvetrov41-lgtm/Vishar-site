-- 0098_appointment_client_actions_foundation.sql
--
-- Inert foundation for client self-service appointment responses.
--
-- This migration does NOT put links into any reminder template and does NOT
-- issue a token by itself. It only creates the capability boundary that a later
-- activation can use. The public Worker may resolve and consume an opaque token,
-- but only a database-owned internal function can mint one.
--
-- Security model:
--   * raw tokens are returned once and never stored;
--   * only SHA-256 digests are persisted in crm_private;
--   * a token is bound to one session, one action and one calendar_version;
--   * GET/readback is separate from POST/mutation so link scanners are harmless;
--   * reschedule is a request, never permission to pick or mutate a slot;
--   * cancellation reproduces the existing appointment/calendar invariants;
--   * all public service RPCs remain backend-only and service_role-only.

-- ---------------------------------------------------------------------------
-- 1. Client-visible response vocabulary without widening session_status
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.appointment_client_response as enum (
    'attendance_confirmed',
    'reschedule_requested'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.appointment_client_action as enum (
    'confirm_attendance',
    'request_reschedule',
    'cancel'
  );
exception when duplicate_object then null; end $$;

alter table public.sessions
  add column if not exists client_response public.appointment_client_response,
  add column if not exists client_response_at timestamptz,
  add column if not exists client_response_calendar_version integer;

alter table public.sessions
  add constraint sessions_client_response_shape
  check (
    (client_response is null
      and client_response_at is null
      and client_response_calendar_version is null)
    or
    (client_response is not null
      and client_response_at is not null
      and client_response_calendar_version is not null
      and client_response_calendar_version = calendar_version)
  );

comment on column public.sessions.client_response is
  'Latest non-terminal response from the client for the current appointment version. This is deliberately separate from the internal appointment lifecycle status.';
comment on column public.sessions.client_response_at is
  'When the client response for the current appointment version was recorded.';
comment on column public.sessions.client_response_calendar_version is
  'calendar_version the client response belongs to. A schedule/lifecycle mutation invalidates the response.';

grant select (client_response, client_response_at, client_response_calendar_version)
  on public.sessions to authenticated;

-- An attendance confirmation or reschedule request is only meaningful for the
-- exact appointment version the client saw. Any schedule/lifecycle mutation
-- makes it stale. The trigger also protects future mutation paths that may not
-- go through today''s RPCs.
create or replace function crm_private.clear_stale_appointment_client_response()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if old.client_response is not null
     and (
       new.start_at is distinct from old.start_at
       or new.end_at is distinct from old.end_at
       or new.status is distinct from old.status
       or new.calendar_version is distinct from old.calendar_version
     ) then
    new.client_response := null;
    new.client_response_at := null;
    new.client_response_calendar_version := null;
  end if;
  return new;
end;
$$;

revoke all on function crm_private.clear_stale_appointment_client_response()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_clear_stale_client_response on public.sessions;
create trigger sessions_clear_stale_client_response
  before update of start_at, end_at, status, calendar_version
  on public.sessions
  for each row execute function crm_private.clear_stale_appointment_client_response();

-- ---------------------------------------------------------------------------
-- 2. Server-only capability store
-- ---------------------------------------------------------------------------

create table if not exists crm_private.appointment_client_action_tokens (
  id                       uuid primary key default gen_random_uuid(),
  session_id               uuid not null references public.sessions(id) on delete cascade,
  action                   public.appointment_client_action not null,
  token_hash               text not null unique,
  session_calendar_version integer not null,
  expires_at               timestamptz not null,
  consumed_at              timestamptz,
  invalidated_at           timestamptz,
  created_at               timestamptz not null default now(),
  constraint appointment_client_action_token_hash_shape
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint appointment_client_action_token_expiry_shape
    check (expires_at > created_at),
  constraint appointment_client_action_token_terminal_shape
    check (consumed_at is null or invalidated_at is null)
);

revoke all on crm_private.appointment_client_action_tokens
  from public, anon, authenticated, service_role;

create unique index if not exists appointment_client_action_one_live_per_action_idx
  on crm_private.appointment_client_action_tokens (session_id, action)
  where consumed_at is null and invalidated_at is null;

create index if not exists appointment_client_action_expiry_idx
  on crm_private.appointment_client_action_tokens (expires_at)
  where consumed_at is null and invalidated_at is null;

comment on table crm_private.appointment_client_action_tokens is
  'Server-only one-time appointment capabilities. Raw tokens never persist; only SHA-256 digests are stored.';

-- Internal minting primitive. It is intentionally NOT granted to service_role:
-- the public Worker can resolve/apply a token but cannot mint arbitrary client
-- capabilities. A later lifecycle activation may call this function from a
-- database-owned SECURITY DEFINER execution path while rendering a reminder.
create or replace function crm_private.issue_appointment_client_actions(
  p_session_id uuid
)
returns table (
  action public.appointment_client_action,
  raw_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_status public.session_status;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_artist_id uuid;
  v_action public.appointment_client_action;
  v_raw text;
  v_expiry timestamptz;
begin
  select s.status, s.start_at, s.calendar_version, s.artist_id
    into v_status, v_start_at, v_calendar_version, v_artist_id
  from public.sessions s
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where s.id = p_session_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now() then
    raise exception 'appointment is not eligible for client actions'
      using errcode = '42501';
  end if;

  -- Reminder links never need to outlive the appointment and are additionally
  -- bounded to seven days in case this primitive is reused outside 72h/24h copy.
  v_expiry := least(v_start_at, now() + interval '7 days');

  -- A newly rendered reminder supersedes every older unconsumed link for this
  -- session. History stays present without allowing two active capability sets.
  update crm_private.appointment_client_action_tokens t
  set invalidated_at = now()
  where t.session_id = p_session_id
    and t.consumed_at is null
    and t.invalidated_at is null;

  for v_action in
    select unnest(enum_range(null::public.appointment_client_action))
  loop
    -- Exactly 32 cryptographically random bytes give 256 bits of capability
    -- material. The raw value is returned once; only its digest is persisted.
    v_raw := encode(extensions.gen_random_bytes(32), 'hex');

    insert into crm_private.appointment_client_action_tokens (
      session_id,
      action,
      token_hash,
      session_calendar_version,
      expires_at
    ) values (
      p_session_id,
      v_action,
      encode(extensions.digest(v_raw, 'sha256'), 'hex'),
      v_calendar_version,
      v_expiry
    );

    action := v_action;
    raw_token := v_raw;
    expires_at := v_expiry;
    return next;
  end loop;
end;
$$;

revoke all on function crm_private.issue_appointment_client_actions(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Safe GET/readback boundary
-- ---------------------------------------------------------------------------

create or replace function public.service_resolve_appointment_client_action(
  p_token text
)
returns table (
  action public.appointment_client_action,
  artist_display_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_hash text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action resolution is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  return query
  select t.action, a.display_name
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id = t.session_id
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where t.token_hash = v_hash
    and t.consumed_at is null
    and t.invalidated_at is null
    and t.expires_at > now()
    and t.session_calendar_version = s.calendar_version
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now();

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.service_resolve_appointment_client_action(text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_appointment_client_action(text)
  to service_role;

comment on function public.service_resolve_appointment_client_action(text) is
  'Backend-only readback for a client action capability. Returns only the action and safe artist label; GET never mutates appointment state.';

-- ---------------------------------------------------------------------------
-- 4. One POST/mutation boundary
-- ---------------------------------------------------------------------------

create or replace function public.service_apply_appointment_client_action(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_hash text;
  v_token_id uuid;
  v_session_id uuid;
  v_action public.appointment_client_action;
  v_token_version integer;
  v_expires_at timestamptz;
  v_consumed_at timestamptz;
  v_invalidated_at timestamptz;
  v_status public.session_status;
  v_artist_id uuid;
  v_workspace_id uuid;
  v_artist_name text;
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_type public.appointment_type;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_calendar_event_id text;
  v_response public.appointment_client_response;
  v_notification_type text;
  v_notification_title text;
  v_notification_body text;
  v_notification_priority public.notification_priority;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action mutation is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- First resolve only the immutable token -> session identity without taking
  -- a token-row lock. Every path that can mutate these capabilities locks the
  -- session first, then a token row. Keeping one lock order avoids a deadlock
  -- between reminder minting and a client POST arriving at the same moment.
  select t.id, t.session_id
    into v_token_id, v_session_id
  from crm_private.appointment_client_action_tokens t
  where t.token_hash = v_hash;

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  select s.status, s.artist_id, a.workspace_id, a.display_name,
         s.client_id, s.enquiry_id, s.project_id, s.appointment_type,
         s.start_at, s.calendar_version, s.calendar_event_id
    into v_status, v_artist_id, v_workspace_id, v_artist_name,
         v_client_id, v_enquiry_id, v_project_id, v_type,
         v_start_at, v_calendar_version, v_calendar_event_id
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where s.id = v_session_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now() then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  -- Re-read and lock the capability only after the session lock. This closes
  -- the race between the initial lookup and lock acquisition, while preserving
  -- the same session -> token lock order used by the minting primitive.
  select t.action, t.session_calendar_version, t.expires_at,
         t.consumed_at, t.invalidated_at
    into v_action, v_token_version, v_expires_at,
         v_consumed_at, v_invalidated_at
  from crm_private.appointment_client_action_tokens t
  where t.id = v_token_id
    and t.session_id = v_session_id
    and t.token_hash = v_hash
  for update;

  if not found
     or v_consumed_at is not null
     or v_invalidated_at is not null
     or v_expires_at <= now()
     or v_token_version <> v_calendar_version then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action = 'confirm_attendance'::public.appointment_client_action then
    v_response := 'attendance_confirmed'::public.appointment_client_response;
    v_notification_type := 'appointment.attendance_confirmed';
    v_notification_title := 'Client confirmed attendance';
    v_notification_body := 'The client confirmed they plan to attend this appointment.';
    v_notification_priority := 'low'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'request_reschedule'::public.appointment_client_action then
    v_response := 'reschedule_requested'::public.appointment_client_response;
    v_notification_type := 'appointment.reschedule_requested';
    v_notification_title := 'Client requested a reschedule';
    v_notification_body := 'The appointment time has not changed. Contact the client and choose a new slot before rescheduling it in CRM.';
    v_notification_priority := 'high'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'cancel'::public.appointment_client_action then
    v_notification_type := 'appointment.cancelled_by_client';
    v_notification_title := 'Client cancelled an appointment';
    v_notification_body := 'The client cancelled this appointment from the secure reminder link.';
    v_notification_priority := 'high'::public.notification_priority;

    -- Exact confirmed -> cancelled semantics from public.set_appointment_status:
    -- increment the calendar version, preserve the activity projection and
    -- enqueue a provider cancellation only when a calendar event already exists.
    update public.sessions s
    set status = 'cancelled'::public.session_status,
        cancelled_at = now(),
        calendar_version = s.calendar_version + 1
    where s.id = v_session_id;

    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.status_changed',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'appointment_type', v_type,
        'from_status', v_status,
        'to_status', 'cancelled',
        'source', 'client_action_link'
      )
    );

    if v_calendar_event_id is not null then
      perform crm_private.enqueue_outbox(
        'calendar_cancel',
        public.calendar_outbox_dedupe_key('cancel', v_session_id, v_calendar_version + 1),
        jsonb_build_object(
          'session_id', v_session_id,
          'appointment_type', v_type,
          'calendar_version', v_calendar_version + 1
        ),
        v_client_id, v_enquiry_id, v_project_id, v_session_id, null
      );
    end if;
  else
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action <> 'cancel'::public.appointment_client_action then
    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.client_response',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'response', v_response,
        'calendar_version', v_calendar_version,
        'source', 'client_action_link'
      )
    );
  end if;

  insert into public.notifications (
    recipient_profile_id,
    artist_id,
    workspace_id,
    notification_type,
    title,
    body,
    entity_type,
    entity_id,
    priority,
    status,
    dedupe_key,
    scheduled_at,
    delivered_at
  )
  select
    r.profile_id,
    v_artist_id,
    v_workspace_id,
    v_notification_type,
    v_notification_title,
    v_notification_body,
    'session',
    v_session_id,
    v_notification_priority,
    'delivered'::public.notification_status,
    'appointment_client_action:' || v_session_id::text || ':'
      || v_calendar_version::text || ':' || v_action::text || ':' || r.profile_id::text,
    now(),
    now()
  from crm_private.automation_notification_recipients(v_artist_id) r
  on conflict (dedupe_key) do nothing;

  -- Consume the chosen capability and invalidate its siblings atomically. A
  -- retry or a contradictory click from the same reminder cannot mutate twice.
  update crm_private.appointment_client_action_tokens t
  set consumed_at = now()
  where t.id = v_token_id;

  update crm_private.appointment_client_action_tokens t
  set invalidated_at = now()
  where t.session_id = v_session_id
    and t.id <> v_token_id
    and t.consumed_at is null
    and t.invalidated_at is null;

  return jsonb_build_object(
    'action', v_action,
    'outcome', case v_action
      when 'confirm_attendance'::public.appointment_client_action then 'attendance_confirmed'
      when 'request_reschedule'::public.appointment_client_action then 'reschedule_requested'
      when 'cancel'::public.appointment_client_action then 'cancelled'
    end,
    'artist_display_name', v_artist_name
  );
end;
$$;

revoke all on function public.service_apply_appointment_client_action(text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_apply_appointment_client_action(text)
  to service_role;

comment on function public.service_apply_appointment_client_action(text) is
  'Consumes one opaque appointment capability. Confirm/reschedule update client response state; cancel performs the confirmed -> cancelled lifecycle mutation and preserves Calendar/outbox invariants.';
