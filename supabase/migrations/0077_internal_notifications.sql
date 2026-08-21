-- 0077_internal_notifications.sql
--
-- Internal notifications for CRM users, and the scheduler that finally makes
-- an overdue follow-up produce something.
--
-- The gap this closes
-- -------------------
-- `public.follow_ups` has existed since migration 0005 and is written by the
-- CRM and by the production GPT. It carries `due_at`, `assigned_to` and a
-- status. Nothing has ever read `due_at`. There is no notification table, no
-- sweep, and no outbox kind for an internal message, so a follow-up that comes
-- due today produces exactly nothing. Somebody has to open the right screen and
-- notice.
--
-- Scope
-- -----
-- This migration adds the domain and the scheduler, and delivers in-app.
-- External delivery to a person's own Telegram or email is deliberately *not*
-- wired up here: that needs the private Telegram destination store and the
-- self-service linking flow, which is a separate bounded release. What is here
-- is the part that decides *who* is notified and *when*, plus the preference
-- and destination records that later release will read.
--
-- Three things are kept apart, and this file only implements the first:
--
--   internal notification   CRM -> an artist, a manager, a member of staff
--   client communication    CRM -> a client            (migration 0069)
--   automation              a trigger or a clock -> an action   (later phase)
--
-- The distinction that matters most for delivery: a person's reminder is
-- addressed to *them*, not to the artist scope they happen to be working in.
-- A private reminder for a manager must never arrive in an artist's shared
-- Telegram group, which is why the destination table below is keyed by profile
-- and is a different thing entirely from `artist_integrations`.
--
-- Forward-only. No provider is contacted, no outbox row is written, no cron is
-- changed and nothing is deployed.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'notification_status') then
    create type public.notification_status as enum
      ('pending', 'delivered', 'read', 'dismissed');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'notification_priority') then
    create type public.notification_priority as enum ('low', 'normal', 'high');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'notification_channel') then
    create type public.notification_channel as enum ('in_app', 'telegram', 'email');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Notifications
--
-- Addressed to one profile. `artist_id` records which scope the notification
-- arose in so the interface can label it; it is not who the notification is
-- for, and it never widens who may read the row.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id                   uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles (id) on delete cascade,
  artist_id            uuid references public.artists (id) on delete cascade,
  workspace_id         uuid references public.workspaces (id) on delete cascade,
  notification_type    text not null,
  title                text not null,
  body                 text,
  entity_type          text,
  entity_id            uuid,
  priority             public.notification_priority not null default 'normal',
  status               public.notification_status not null default 'pending',
  dedupe_key           text not null,
  scheduled_at         timestamptz not null default now(),
  delivered_at         timestamptz,
  read_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (dedupe_key),
  constraint notifications_type_shape
    check (notification_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint notifications_title_present check (btrim(title) <> ''),
  constraint notifications_title_length check (length(title) <= 200),
  constraint notifications_body_length check (body is null or length(body) <= 2000),
  constraint notifications_entity_pair
    check ((entity_type is null) = (entity_id is null)),
  constraint notifications_entity_type_known
    check (entity_type is null or entity_type in
           ('follow_up', 'enquiry', 'project', 'session', 'client',
            'conversation', 'payment_request', 'integration')),
  constraint notifications_read_implies_delivered
    check (read_at is null or delivered_at is not null)
);

comment on table public.notifications is
  'One notification addressed to one CRM profile. The unique dedupe_key is what makes a repeated scheduler run idempotent; artist_id labels the scope it arose in and never decides who may read it.';

comment on column public.notifications.dedupe_key is
  'Stable identity for one announcement to one person, e.g. followup_due:<follow_up_id>:<schedule_version>:<recipient>. A second sweep over the same due follow-up conflicts on this key instead of producing a duplicate; a snooze bumps the schedule version, which is what allows a legitimate second notification.';

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_profile_id, status, scheduled_at desc);

create index if not exists notifications_due_idx
  on public.notifications (scheduled_at)
  where status = 'pending';

drop trigger if exists notifications_set_updated_at on public.notifications;
create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Personal delivery preferences
--
-- Deliberately *not* `artist_integrations`. That table answers "how does this
-- artist's business reach the outside world"; this one answers "how does the
-- CRM reach this person". Sarah managing three artists has one row per channel
-- here, and none of them is any artist's shared group chat.
-- ---------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  channel     public.notification_channel not null,
  is_enabled  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (profile_id, channel)
);

comment on table public.notification_preferences is
  'How one person wants to be reached. in_app is always on and is not stored here as an opt-out; the other channels are opt-in and require a destination.';

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- The address itself is server-only, for the same reason a Telegram chat id
-- never appears in `public.artist_integrations`: a chat id is a capability, and
-- a browser-readable capability is a leaked one. `public` holds only the fact
-- that a destination exists and a safe label for it.
create table if not exists crm_private.profile_notification_targets (
  profile_id     uuid not null,
  channel        public.notification_channel not null,
  target_address text not null,
  safe_label     text,
  is_active      boolean not null default true,
  connected_at   timestamptz not null default now(),
  last_success_at timestamptz,
  last_error_at   timestamptz,
  primary key (profile_id, channel)
);

revoke all on crm_private.profile_notification_targets
  from public, anon, authenticated, service_role;

comment on table crm_private.profile_notification_targets is
  'A person''s actual delivery address - a Telegram chat id, an email. Never reachable from a browser, a GPT action or an MCP tool; only a backend resolver reads it.';

-- ---------------------------------------------------------------------------
-- 4. Follow-up scheduling state
--
-- `schedule_version` is what makes snoozing safe. Snoozing does not create a
-- second task and does not edit history: it moves `due_at` and bumps the
-- version, which changes the dedupe key, so the next sweep is allowed to
-- notify again and the old notification stays as the record of the first
-- attempt.
-- ---------------------------------------------------------------------------

alter table public.follow_ups
  add column if not exists schedule_version integer not null default 1,
  add column if not exists last_notified_at timestamptz,
  add column if not exists snoozed_from timestamptz;

create or replace function crm_private.bump_follow_up_schedule_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.due_at is distinct from old.due_at then
    new.schedule_version := old.schedule_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists follow_ups_bump_schedule_version on public.follow_ups;
create trigger follow_ups_bump_schedule_version
  before update on public.follow_ups
  for each row execute function crm_private.bump_follow_up_schedule_version();

create index if not exists follow_ups_due_open_idx
  on public.follow_ups (due_at)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 5. Who a follow-up is for
--
-- The assignee, when there is one and they can still reach the work. When
-- there is not, the people who actually run that artist - not "every manager",
-- which is how a studio ends up with six people ignoring the same reminder
-- because they each assume somebody else has it.
--
-- Both cases re-check access at notification time. A membership revoked
-- between creating the follow-up and its due date must stop the notification,
-- because the recipient can no longer open what it points at.
-- ---------------------------------------------------------------------------

create or replace function crm_private.follow_up_recipients(p_follow_up_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with f as (
    select id, artist_id, assigned_to
    from public.follow_ups
    where id = p_follow_up_id
  ),
  assignee as (
    select p.profile_id
    from f
    join crm_private.profile_access p on p.profile_id = f.assigned_to
    join crm_private.artist_access a
      on a.profile_id = p.profile_id and a.artist_id = f.artist_id
    where p.is_active and a.is_active
  )
  select profile_id from assignee
  union all
  select p.profile_id
  from f
  join crm_private.artist_access a on a.artist_id = f.artist_id
  join crm_private.profile_access p on p.profile_id = a.profile_id
  where not exists (select 1 from assignee)
    and a.is_active
    and p.is_active
    and a.access_level in ('owner', 'artist');
$$;

-- ---------------------------------------------------------------------------
-- 6. The sweep
--
-- Backend-only, idempotent, and safe to run twice concurrently: the unique
-- dedupe key is the arbiter, not a read-then-write race. It notifies nothing
-- for a follow-up that has been completed, cancelled, reassigned out of reach,
-- or snoozed past now, because each of those is re-read here rather than
-- trusted from whenever the row was written.
--
-- Everything is timestamptz compared against now(), so a follow-up due at
-- 09:00 Europe/London is due at 09:00 Europe/London in March and in July.
-- ---------------------------------------------------------------------------

create or replace function public.service_sweep_due_follow_ups(
  p_limit integer default 100
)
-- The OUT names deliberately avoid `id`, `entity_id` and
-- `recipient_profile_id`: those are columns of public.notifications, and a
-- RETURNING clause inside the CTE below would otherwise be ambiguous against
-- the function's own output parameters.
returns table (
  swept_follow_up_id uuid,
  swept_notification_id uuid,
  notified_profile_id uuid,
  outcome text
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'follow-up sweeping is backend-only' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'sweep limit must be between 1 and 500' using errcode = '22023';
  end if;

  return query
  with due as (
    select f.id, f.artist_id, f.subject, f.details, f.due_at, f.schedule_version
    from public.follow_ups f
    join crm_private.artist_state s on s.artist_id = f.artist_id and s.is_active
    where f.status = 'open'
      and f.completed_at is null
      and f.cancelled_at is null
      and f.due_at <= now()
    order by f.due_at, f.id
    limit p_limit
  ),
  targeted as (
    select d.*, r.profile_id
    from due d
    cross join lateral crm_private.follow_up_recipients(d.id) r
  ),
  inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    )
    select t.profile_id,
           t.artist_id,
           'follow_up.due',
           t.subject,
           t.details,
           'follow_up',
           t.id,
           case when t.due_at <= now() - interval '1 day'
                then 'high'::public.notification_priority
                else 'normal'::public.notification_priority end,
           'delivered',
           'followup_due:' || t.id::text || ':' || t.schedule_version::text
             || ':' || t.profile_id::text,
           t.due_at,
           now()
    from targeted t
    on conflict (dedupe_key) do nothing
    returning id, entity_id, recipient_profile_id
  ),
  touched as (
    update public.follow_ups f
    set last_notified_at = now()
    where f.id in (select entity_id from inserted)
    returning f.id
  )
  -- `touched` is a data-modifying CTE, so PostgreSQL runs it to completion
  -- whether or not the outer query reads from it.
  select i.entity_id, i.id, i.recipient_profile_id, 'notified'::text
  from inserted i
  where not exists (select 1 from touched where false);
end;
$$;

comment on function public.service_sweep_due_follow_ups(integer) is
  'Turns due follow-ups into internal notifications. Idempotent through the unique dedupe key, so a duplicated scheduler run or a retried Worker produces no second notification.';

-- ---------------------------------------------------------------------------
-- 7. Browser surfaces
-- ---------------------------------------------------------------------------

create or replace function public.list_notifications(
  p_status public.notification_status default null,
  p_limit integer default 50
)
returns table (
  id                uuid,
  artist_id         uuid,
  artist_label      text,
  notification_type text,
  title             text,
  body              text,
  entity_type       text,
  entity_id         uuid,
  priority          public.notification_priority,
  status            public.notification_status,
  scheduled_at      timestamptz,
  read_at           timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select n.id, n.artist_id, a.display_name, n.notification_type, n.title, n.body,
         n.entity_type, n.entity_id, n.priority, n.status, n.scheduled_at, n.read_at
  from public.notifications n
  left join public.artists a on a.id = n.artist_id
  where n.recipient_profile_id = auth.uid()
    and public.is_active_user()
    and (p_status is null or n.status = p_status)
  order by n.scheduled_at desc, n.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.list_notifications(public.notification_status, integer) is
  'The signed-in profile''s own notifications. Takes no recipient argument, so it cannot be used to read somebody else''s.';

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_updated integer;
begin
  update public.notifications n
  set status = 'read',
      read_at = coalesce(n.read_at, now()),
      delivered_at = coalesce(n.delivered_at, now())
  where n.id = p_notification_id
    and n.recipient_profile_id = auth.uid()
    and n.status <> 'read';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Snoozing moves the due date and bumps the schedule version through the
-- trigger above. It creates no second task, and the notification already sent
-- stays where it is as the record of the first attempt.
create or replace function public.snooze_follow_up(
  p_follow_up_id uuid,
  p_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_status public.follow_up_status;
  v_due timestamptz;
  v_version integer;
begin
  select f.artist_id, f.status, f.due_at into v_artist_id, v_status, v_due
  from public.follow_ups f
  where f.id = p_follow_up_id;

  if v_artist_id is null then
    raise exception 'the follow-up is unavailable' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_notifications');

  if v_status <> 'open' then
    raise exception 'only an open follow-up can be snoozed' using errcode = '22023';
  end if;

  if p_until is null or p_until <= now() then
    raise exception 'a snooze must move the follow-up into the future'
      using errcode = '22023';
  end if;

  if p_until > now() + interval '365 days' then
    raise exception 'a snooze cannot exceed one year' using errcode = '22023';
  end if;

  update public.follow_ups f
  set due_at = p_until,
      snoozed_from = coalesce(f.snoozed_from, v_due)
  where f.id = p_follow_up_id
  returning f.schedule_version into v_version;

  return jsonb_build_object(
    'follow_up_id', p_follow_up_id,
    'due_at', p_until,
    'schedule_version', v_version
  );
end;
$$;

create or replace function public.set_notification_preference(
  p_channel public.notification_channel,
  p_is_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not public.is_active_user() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_channel = 'in_app' then
    raise exception 'in-app notifications cannot be switched off'
      using errcode = '22023';
  end if;

  -- A channel with no destination would be an enabled preference that silently
  -- delivers nothing, which reads as "notifications are broken".
  if coalesce(p_is_enabled, false) and not exists (
    select 1 from crm_private.profile_notification_targets t
    where t.profile_id = auth.uid() and t.channel = p_channel and t.is_active
  ) then
    raise exception 'connect a % destination before enabling it', p_channel
      using errcode = '22023';
  end if;

  insert into public.notification_preferences (profile_id, channel, is_enabled)
  values (auth.uid(), p_channel, coalesce(p_is_enabled, false))
  on conflict (profile_id, channel) do update
    set is_enabled = excluded.is_enabled;

  return coalesce(p_is_enabled, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges and RLS
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.notifications force row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

revoke all on public.notifications from public, anon, authenticated, service_role;
revoke all on public.notification_preferences from public, anon, authenticated, service_role;
grant select on public.notifications to authenticated;
grant select on public.notification_preferences to authenticated;

-- The recipient, and nobody else. An artist-scope predicate here would be
-- wrong: a manager's private reminder is not readable by the artist just
-- because it arose in their scope.
drop policy if exists notifications_own_select on public.notifications;
create policy notifications_own_select on public.notifications
  for select
  using (
    (recipient_profile_id = auth.uid() and public.is_active_user())
    or crm_private.is_service_backend()
  );

drop policy if exists notification_preferences_own_select on public.notification_preferences;
create policy notification_preferences_own_select on public.notification_preferences
  for select
  using (
    (profile_id = auth.uid() and public.is_active_user())
    or crm_private.is_service_backend()
  );

revoke all on function crm_private.follow_up_recipients(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.service_sweep_due_follow_ups(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_sweep_due_follow_ups(integer) to service_role;

revoke all on function public.list_notifications(public.notification_status, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_notifications(public.notification_status, integer)
  to authenticated;

revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_notification_read(uuid) to authenticated;

revoke all on function public.snooze_follow_up(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.snooze_follow_up(uuid, timestamptz) to authenticated;

revoke all on function public.set_notification_preference(public.notification_channel, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_notification_preference(public.notification_channel, boolean)
  to authenticated;
