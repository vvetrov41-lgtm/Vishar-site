-- 0081_automation_engine.sql
--
-- Phase N: the automation foundation. Trigger -> conditions -> delay -> action,
-- deliberately narrow, with exactly one action in this release: an internal
-- CRM notification.
--
-- What this reuses instead of rebuilding
-- --------------------------------------
-- `public.activity_log` is already the append-only record that every trusted
-- CRM workflow writes to, so it is the event source. Nothing here edits an
-- existing RPC to emit a second copy of what it already records.
--
-- `public.notifications` from migration 0077 is the delivery target, so an
-- automation notification is the same object the Notification Centre already
-- renders, subject to the same "addressed to a person, not to a scope" rule.
--
-- The tick below is written to become the single scheduler entry point
-- alongside `service_sweep_due_follow_ups`, rather than one cron per automation
-- type. No cron and no Worker configuration changes here.
--
-- Why there is no rule DSL
-- ------------------------
-- A rule stores its trigger, its two optional status conditions, its delay and
-- its action in *typed columns*. There is no jsonb config, no expression
-- string, no table or function name and no template language anywhere in this
-- migration. That is the point: an injection surface you never create cannot be
-- validated incorrectly later. Widening the action set is a later migration
-- adding an enum value and an explicit execution branch, not a config change.
--
-- Forward-only. No provider is contacted, no cron is added, no existing
-- behaviour changes, and with no rules present the tick is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'automation_action_type') then
    -- One value. Every future action arrives as an enum value plus its own
    -- execution branch, so "what can an automation do" stays enumerable.
    create type public.automation_action_type as enum ('notify_artist_team');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'automation_job_status') then
    create type public.automation_job_status as enum
      ('pending', 'running', 'completed', 'cancelled', 'failed');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'automation_scope_kind') then
    create type public.automation_scope_kind as enum ('global', 'workspace', 'artist');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The trigger catalogue
--
-- `activity_log.event_type` is free text with only a shape check, so it is not
-- safe as a rule's trigger on its own: a rule could otherwise name an event
-- nobody emits, or one that carries data it should not react to. A rule may
-- only name a row that exists here.
-- ---------------------------------------------------------------------------

create table if not exists public.automation_trigger_catalog (
  event_type   text primary key,
  entity_kind  text not null,
  has_status   boolean not null default false,
  description  text not null,
  created_at   timestamptz not null default now(),
  constraint automation_trigger_catalog_shape
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint automation_trigger_catalog_entity_known
    check (entity_kind in ('enquiry', 'project', 'session', 'client'))
);

comment on table public.automation_trigger_catalog is
  'The events an automation rule may trigger on. Reading a row grants nothing; it exists so a rule cannot name an arbitrary activity_log event_type.';

insert into public.automation_trigger_catalog (event_type, entity_kind, has_status, description) values
  ('enquiry.created',           'enquiry', false, 'A new enquiry was recorded.'),
  ('enquiry.status_changed',    'enquiry', true,  'An enquiry moved between statuses.'),
  ('enquiry.assigned',          'enquiry', false, 'An enquiry was assigned to a CRM user.'),
  ('enquiry.converted',         'enquiry', false, 'An enquiry became a project.'),
  ('project.status_changed',    'project', true,  'A project moved between statuses.'),
  ('appointment.scheduled',     'session', false, 'An appointment was scheduled.'),
  ('appointment.status_changed','session', true,  'An appointment moved between statuses.'),
  ('client.created',            'client',  false, 'A client record was created.')
on conflict (event_type) do nothing;

alter table public.automation_trigger_catalog enable row level security;
alter table public.automation_trigger_catalog force row level security;
revoke all on public.automation_trigger_catalog from anon, authenticated, service_role;
grant select on public.automation_trigger_catalog to authenticated;

create policy automation_trigger_catalog_read on public.automation_trigger_catalog
  for select to authenticated
  using (public.is_active_user());

-- ---------------------------------------------------------------------------
-- 3. Domain events
--
-- A projection of activity_log, not a copy of it. It carries the artist, the
-- entity it happened to, and — for status events — the two status values, which
-- is the entire condition vocabulary. It deliberately carries no jsonb and no
-- free text, so there is no path by which a client name, an email address or a
-- message body can reach an automation payload.
-- ---------------------------------------------------------------------------

create table if not exists public.automation_events (
  id           uuid primary key default gen_random_uuid(),
  -- Deliberately not a foreign key. public.activity_log is append-only - no
  -- role, including service_role, can update or delete a row - so referential
  -- integrity buys nothing here, while a FK referencing it changes how
  -- `truncate public.activity_log` fails: PostgreSQL raises the FK error before
  -- the privilege check, which quietly replaces the append-only guarantee
  -- pgTAP 050 asserts. The unique constraint is what dedupe actually needs.
  activity_id  uuid not null unique,
  artist_id    uuid not null references public.artists (id) on delete cascade,
  event_type   text not null references public.automation_trigger_catalog (event_type),
  entity_kind  text not null,
  entity_id    uuid,
  from_status  text,
  to_status    text,
  occurred_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint automation_events_entity_known
    check (entity_kind in ('enquiry', 'project', 'session', 'client')),
  -- Statuses are short enum labels in every emitting RPC. The bound is here so
  -- that a future caller cannot turn either column into a free-text carrier.
  constraint automation_events_status_shape
    check (
      (from_status is null or from_status ~ '^[a-z][a-z0-9_]{0,63}$')
      and (to_status is null or to_status ~ '^[a-z][a-z0-9_]{0,63}$')
    )
);

comment on table public.automation_events is
  'Safe projection of the activity_log rows automations may react to. Holds no jsonb and no free text by design: there is nowhere for personal data to land.';

create index if not exists automation_events_unprocessed_idx
  on public.automation_events (event_type, artist_id, occurred_at);

create or replace function crm_private.project_automation_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_entity_kind text;
  v_entity_id uuid;
  v_from text;
  v_to text;
begin
  -- An event without an artist has no scope to run in, and one outside the
  -- catalogue is not something a rule can name. Both are simply not projected.
  if new.artist_id is null then
    return new;
  end if;

  select c.entity_kind into v_entity_kind
  from public.automation_trigger_catalog c
  where c.event_type = new.event_type;

  if v_entity_kind is null then
    return new;
  end if;

  v_entity_id := case v_entity_kind
    when 'enquiry' then new.enquiry_id
    when 'project' then new.project_id
    when 'session' then new.session_id
    when 'client'  then new.client_id
  end;

  -- Exactly two keys are read out of the metadata, and only when they look like
  -- a status label. Nothing else crosses over.
  v_from := nullif(new.metadata ->> 'from_status', '');
  v_to := nullif(new.metadata ->> 'to_status', '');
  if v_from is not null and v_from !~ '^[a-z][a-z0-9_]{0,63}$' then v_from := null; end if;
  if v_to is not null and v_to !~ '^[a-z][a-z0-9_]{0,63}$' then v_to := null; end if;

  insert into public.automation_events (
    activity_id, artist_id, event_type, entity_kind, entity_id,
    from_status, to_status, occurred_at
  ) values (
    new.id, new.artist_id, new.event_type, v_entity_kind, v_entity_id,
    v_from, v_to, new.occurred_at
  )
  on conflict (activity_id) do nothing;

  return new;
end;
$$;

drop trigger if exists activity_log_project_automation_event on public.activity_log;
create trigger activity_log_project_automation_event
  after insert on public.activity_log
  for each row execute function crm_private.project_automation_event();

-- ---------------------------------------------------------------------------
-- 4. Rules
--
-- Typed columns only. `condition_from_status` / `condition_to_status` are the
-- whole condition language: null means "any".
-- ---------------------------------------------------------------------------

create table if not exists public.automation_rules (
  id                    uuid primary key default gen_random_uuid(),
  artist_id             uuid not null references public.artists (id) on delete cascade,
  name                  text not null,
  trigger_event_type    text not null references public.automation_trigger_catalog (event_type),
  condition_from_status text,
  condition_to_status   text,
  delay_minutes         integer not null default 0,
  action_type           public.automation_action_type not null default 'notify_artist_team',
  action_title          text not null,
  action_body           text,
  action_priority       public.notification_priority not null default 'normal',
  is_enabled            boolean not null default false,
  version               integer not null default 1,
  created_by            uuid references public.profiles (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint automation_rules_name_present check (btrim(name) <> ''),
  constraint automation_rules_name_length check (length(name) <= 120),
  constraint automation_rules_title_present check (btrim(action_title) <> ''),
  constraint automation_rules_title_length check (length(action_title) <= 200),
  constraint automation_rules_body_length check (action_body is null or length(action_body) <= 2000),
  -- Up to thirty days. An unbounded delay would let a rule schedule work that
  -- outlives every assumption it was written under.
  constraint automation_rules_delay_bounds check (delay_minutes between 0 and 43200),
  constraint automation_rules_condition_shape
    check (
      (condition_from_status is null or condition_from_status ~ '^[a-z][a-z0-9_]{0,63}$')
      and (condition_to_status is null or condition_to_status ~ '^[a-z][a-z0-9_]{0,63}$')
    )
);

comment on table public.automation_rules is
  'One artist-scoped automation. Conditions and action are typed columns rather than a config document, so there is no expression language to sandbox.';

create index if not exists automation_rules_trigger_idx
  on public.automation_rules (trigger_event_type, artist_id)
  where is_enabled;

-- A rule whose meaning changed is a different rule as far as pending work is
-- concerned. The version bump is what lets the tick cancel jobs that were
-- materialised under the old meaning.
create or replace function crm_private.bump_automation_rule_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.artist_id is distinct from old.artist_id then
    raise exception 'an automation rule cannot change artist; disable it and create a new one'
      using errcode = '23514';
  end if;

  if new.trigger_event_type is distinct from old.trigger_event_type
     or new.condition_from_status is distinct from old.condition_from_status
     or new.condition_to_status is distinct from old.condition_to_status
     or new.delay_minutes is distinct from old.delay_minutes
     or new.action_type is distinct from old.action_type
     or new.action_title is distinct from old.action_title
     or new.action_body is distinct from old.action_body
     or new.action_priority is distinct from old.action_priority then
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

drop trigger if exists automation_rules_bump_version on public.automation_rules;
create trigger automation_rules_bump_version
  before update on public.automation_rules
  for each row execute function crm_private.bump_automation_rule_version();

drop trigger if exists automation_rules_set_updated_at on public.automation_rules;
create trigger automation_rules_set_updated_at
  before update on public.automation_rules
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Jobs
--
-- The action is snapshotted at materialisation, so a completed job records what
-- actually ran rather than what the rule says today.
-- ---------------------------------------------------------------------------

create table if not exists public.automation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  rule_id             uuid not null references public.automation_rules (id) on delete cascade,
  rule_version        integer not null,
  event_id            uuid not null references public.automation_events (id) on delete cascade,
  artist_id           uuid not null references public.artists (id) on delete cascade,
  action_type         public.automation_action_type not null,
  action_title        text not null,
  action_body         text,
  action_priority     public.notification_priority not null,
  scheduled_at        timestamptz not null,
  status              public.automation_job_status not null default 'pending',
  attempt_count       integer not null default 0,
  last_error_category text,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One job per (rule, event). This is what makes a repeated or concurrent tick
  -- idempotent rather than a source of duplicate work.
  unique (rule_id, event_id),
  constraint automation_jobs_error_category_known
    check (last_error_category is null or last_error_category in
           ('none', 'no_recipient', 'rule_withdrawn', 'unsupported_action', 'unknown'))
);

comment on table public.automation_jobs is
  'Durable automation work. Unique on (rule_id, event_id) so a repeated tick cannot double-execute, and the action is snapshotted so editing a rule never rewrites what already ran.';

create index if not exists automation_jobs_due_idx
  on public.automation_jobs (scheduled_at)
  where status = 'pending';

drop trigger if exists automation_jobs_set_updated_at on public.automation_jobs;
create trigger automation_jobs_set_updated_at
  before update on public.automation_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Kill switches
--
-- Absence of a row means enabled, so nothing needs seeding and disabling never
-- deletes anything. A disabled scope leaves its jobs pending: when the switch
-- comes back the work is still there, which is what makes this a pause rather
-- than a discard.
-- ---------------------------------------------------------------------------

create table if not exists public.automation_kill_switches (
  scope_kind  public.automation_scope_kind not null,
  scope_id    uuid,
  is_enabled  boolean not null default true,
  note        text,
  updated_at  timestamptz not null default now(),
  constraint automation_kill_switches_scope_shape
    check (
      (scope_kind = 'global' and scope_id is null)
      or (scope_kind <> 'global' and scope_id is not null)
    ),
  constraint automation_kill_switches_note_length
    check (note is null or length(note) <= 200)
);

create unique index if not exists automation_kill_switches_scope_idx
  on public.automation_kill_switches (scope_kind, scope_id) nulls not distinct;

comment on table public.automation_kill_switches is
  'Pause automations globally, for one workspace, or for one artist. An absent row means enabled; a disabled scope leaves its jobs pending rather than discarding them.';

create or replace function crm_private.automations_enabled_for_artist(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select not exists (
    select 1
    from public.automation_kill_switches k
    left join public.artists a on a.id = p_artist_id
    where not k.is_enabled
      and (
        k.scope_kind = 'global'
        or (k.scope_kind = 'artist' and k.scope_id = p_artist_id)
        or (k.scope_kind = 'workspace' and k.scope_id = a.workspace_id)
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Who an automation notifies
--
-- Server-derived, and never a value a rule or a browser supplied: a rule has no
-- recipient column at all. The people who run the artist are notified, and only
-- while they still can reach the work.
-- ---------------------------------------------------------------------------

create or replace function crm_private.automation_notification_recipients(p_artist_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select p.profile_id
  from crm_private.artist_access a
  join crm_private.profile_access p on p.profile_id = a.profile_id
  where a.artist_id = p_artist_id
    and a.is_active
    and p.is_active
    and a.access_level in ('owner', 'artist');
$$;

-- ---------------------------------------------------------------------------
-- 8. The tick
--
-- One backend-only entry point that materialises, withdraws and executes. It is
-- safe to run twice concurrently: materialisation conflicts on (rule_id,
-- event_id) and execution conflicts on the notification dedupe key, so the
-- database is the arbiter rather than a read-then-write race.
-- ---------------------------------------------------------------------------

create or replace function public.service_run_automation_tick(p_limit integer default 100)
returns table (
  materialised integer,
  withdrawn    integer,
  executed     integer,
  notified     integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_materialised integer := 0;
  v_withdrawn integer := 0;
  v_executed integer := 0;
  v_notified integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'automation ticks are backend-only' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'automation tick limit must be between 1 and 500' using errcode = '22023';
  end if;

  -- (a) Materialise. A rule only ever sees events of its own artist: the join
  -- is on artist_id, so there is no cross-artist match to prevent later.
  with pairs as (
    select r.id as rule_id, r.version, e.id as event_id, e.artist_id,
           r.action_type, r.action_title, r.action_body, r.action_priority,
           e.occurred_at + make_interval(mins => r.delay_minutes) as scheduled_at
    from public.automation_events e
    join public.automation_rules r
      on r.artist_id = e.artist_id
     and r.trigger_event_type = e.event_type
     and r.is_enabled
    where (r.condition_from_status is null or r.condition_from_status = e.from_status)
      and (r.condition_to_status is null or r.condition_to_status = e.to_status)
      and not exists (
        select 1 from public.automation_jobs j
        where j.rule_id = r.id and j.event_id = e.id
      )
    order by e.occurred_at, e.id
    limit p_limit
  ),
  inserted as (
    insert into public.automation_jobs (
      rule_id, rule_version, event_id, artist_id,
      action_type, action_title, action_body, action_priority, scheduled_at
    )
    select rule_id, version, event_id, artist_id,
           action_type, action_title, action_body, action_priority, scheduled_at
    from pairs
    on conflict (rule_id, event_id) do nothing
    returning 1
  )
  select count(*)::int into v_materialised from inserted;

  -- (b) Withdraw. Pending work whose rule has since been disabled or edited was
  -- materialised under a meaning that no longer exists, so it is cancelled
  -- rather than executed. Completed jobs are never touched.
  with stale as (
    update public.automation_jobs j
    set status = 'cancelled',
        cancelled_at = now(),
        last_error_category = 'rule_withdrawn'
    from public.automation_rules r
    where j.rule_id = r.id
      and j.status = 'pending'
      and (not r.is_enabled or r.version <> j.rule_version)
    returning 1
  )
  select count(*)::int into v_withdrawn from stale;

  -- (c) Execute. Only due pending jobs, only for artists no kill switch has
  -- paused, and only the one action this release supports.
  with due as (
    select j.id, j.artist_id, j.action_title, j.action_body, j.action_priority,
           e.entity_kind, e.entity_id
    from public.automation_jobs j
    join public.automation_events e on e.id = j.event_id
    join crm_private.artist_state s on s.artist_id = j.artist_id and s.is_active
    where j.status = 'pending'
      and j.scheduled_at <= now()
      and j.action_type = 'notify_artist_team'
      and crm_private.automations_enabled_for_artist(j.artist_id)
    order by j.scheduled_at, j.id
    limit p_limit
  ),
  targeted as (
    select d.*, r.profile_id
    from due d
    cross join lateral crm_private.automation_notification_recipients(d.artist_id) r
  ),
  sent as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    )
    select t.profile_id, t.artist_id, 'automation.triggered',
           t.action_title, t.action_body,
           -- public.notifications requires entity_type and entity_id to be
           -- present or absent together. An event can name a kind without a
           -- concrete row (an activity entry that recorded no enquiry id, say),
           -- so the pair is collapsed rather than half-filled.
           case when t.entity_id is not null then t.entity_kind end,
           t.entity_id, t.action_priority,
           'delivered',
           'automation_job:' || t.id::text || ':' || t.profile_id::text,
           now(), now()
    from targeted t
    on conflict (dedupe_key) do nothing
    returning 1
  ),
  finished as (
    update public.automation_jobs j
    set status = 'completed',
        completed_at = now(),
        attempt_count = j.attempt_count + 1,
        last_error_category = case
          when exists (select 1 from targeted t where t.id = j.id) then 'none'
          else 'no_recipient'
        end
    where j.id in (select id from due)
    returning 1
  )
  select (select count(*)::int from finished), (select count(*)::int from sent)
  into v_executed, v_notified;

  return query select v_materialised, v_withdrawn, v_executed, v_notified;
end;
$$;

comment on function public.service_run_automation_tick(integer) is
  'Materialises, withdraws and executes automation work in one backend-only pass. Idempotent: materialisation conflicts on (rule_id, event_id) and delivery conflicts on the notification dedupe key.';

-- ---------------------------------------------------------------------------
-- 9. CRM management surface
--
-- Three narrow RPCs. No browser writes any automation table directly, and no
-- caller names a recipient, a table, a function or a template.
-- ---------------------------------------------------------------------------

create or replace function public.list_automation_rules(p_artist_id uuid default null)
returns table (
  id                    uuid,
  artist_id             uuid,
  name                  text,
  trigger_event_type    text,
  condition_from_status text,
  condition_to_status   text,
  delay_minutes         integer,
  action_type           public.automation_action_type,
  action_title          text,
  action_body           text,
  action_priority       public.notification_priority,
  is_enabled            boolean,
  version               integer,
  created_at            timestamptz,
  updated_at            timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select r.id, r.artist_id, r.name, r.trigger_event_type,
         r.condition_from_status, r.condition_to_status, r.delay_minutes,
         r.action_type, r.action_title, r.action_body, r.action_priority,
         r.is_enabled, r.version, r.created_at, r.updated_at
  from public.automation_rules r
  where public.is_active_user()
    and (p_artist_id is null or r.artist_id = p_artist_id)
    and crm_private.has_artist_capability(r.artist_id, 'view_automations')
  order by r.created_at, r.id;
$$;

create or replace function public.create_automation_rule(
  p_artist_id uuid,
  p_name text,
  p_trigger_event_type text,
  p_action_title text,
  p_action_body text default null,
  p_condition_from_status text default null,
  p_condition_to_status text default null,
  p_delay_minutes integer default 0,
  p_action_priority public.notification_priority default 'normal'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');
  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1 from public.automation_trigger_catalog c
    where c.event_type = p_trigger_event_type
  ) then
    raise exception 'unknown automation trigger %', p_trigger_event_type
      using errcode = '22023';
  end if;

  -- A new rule is created disabled. Somebody has to look at it and turn it on,
  -- which is the same posture as a new booking source.
  insert into public.automation_rules (
    artist_id, name, trigger_event_type,
    condition_from_status, condition_to_status, delay_minutes,
    action_type, action_title, action_body, action_priority,
    is_enabled, created_by
  ) values (
    p_artist_id, btrim(p_name), p_trigger_event_type,
    p_condition_from_status, p_condition_to_status, coalesce(p_delay_minutes, 0),
    'notify_artist_team', btrim(p_action_title), p_action_body,
    coalesce(p_action_priority, 'normal'),
    false, auth.uid()
  )
  returning id into v_id;

  perform crm_private.log_artist_activity(
    p_artist_id, 'automation.rule_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object('trigger_event_type', p_trigger_event_type)
  );

  return v_id;
end;
$$;

create or replace function public.set_automation_rule_enabled(
  p_rule_id uuid,
  p_is_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select r.artist_id into v_artist_id
  from public.automation_rules r
  where r.id = p_rule_id;

  if v_artist_id is null then
    raise exception 'the automation rule is unavailable' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_automations');

  update public.automation_rules r
  set is_enabled = coalesce(p_is_enabled, false)
  where r.id = p_rule_id;

  perform crm_private.log_artist_activity(
    v_artist_id, 'automation.rule_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object('is_enabled', coalesce(p_is_enabled, false))
  );

  return coalesce(p_is_enabled, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges and RLS
--
-- Browsers read rules through list_automation_rules and write nothing. Events,
-- jobs and kill switches have no browser grant at all: they are backend state.
-- ---------------------------------------------------------------------------

alter table public.automation_events enable row level security;
alter table public.automation_events force row level security;
alter table public.automation_rules enable row level security;
alter table public.automation_rules force row level security;
alter table public.automation_jobs enable row level security;
alter table public.automation_jobs force row level security;
alter table public.automation_kill_switches enable row level security;
alter table public.automation_kill_switches force row level security;

revoke all on public.automation_events from public, anon, authenticated, service_role;
revoke all on public.automation_rules from public, anon, authenticated, service_role;
revoke all on public.automation_jobs from public, anon, authenticated, service_role;
revoke all on public.automation_kill_switches from public, anon, authenticated, service_role;

drop policy if exists automation_events_service_select on public.automation_events;
create policy automation_events_service_select on public.automation_events
  for select using (crm_private.is_service_backend());

drop policy if exists automation_rules_service_select on public.automation_rules;
create policy automation_rules_service_select on public.automation_rules
  for select using (crm_private.is_service_backend());

drop policy if exists automation_jobs_service_select on public.automation_jobs;
create policy automation_jobs_service_select on public.automation_jobs
  for select using (crm_private.is_service_backend());

drop policy if exists automation_kill_switches_service_select on public.automation_kill_switches;
create policy automation_kill_switches_service_select on public.automation_kill_switches
  for select using (crm_private.is_service_backend());

revoke all on function crm_private.automations_enabled_for_artist(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.automation_notification_recipients(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.service_run_automation_tick(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_run_automation_tick(integer) to service_role;

revoke all on function public.list_automation_rules(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_automation_rules(uuid) to authenticated;

revoke all on function public.create_automation_rule(uuid, text, text, text, text, text, text, integer, public.notification_priority)
  from public, anon, authenticated, service_role;
grant execute on function public.create_automation_rule(uuid, text, text, text, text, text, text, integer, public.notification_priority)
  to authenticated;

revoke all on function public.set_automation_rule_enabled(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_automation_rule_enabled(uuid, boolean) to authenticated;
