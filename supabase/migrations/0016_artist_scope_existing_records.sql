-- 0016_artist_scope_existing_records.sql
--
-- Add an authoritative artist scope to the existing CRM records. Every row
-- that existed before this migration belongs to Vladimir. New linked rows
-- inherit their artist from the parent entity, while an explicit mismatch is
-- rejected before it can reach storage.
--
-- This migration deliberately preserves the existing public RPC signatures.
-- The current single-site intake receives the server-side legacy fallback of
-- Vladimir until migration 0017 replaces that fallback with trusted
-- booking_sources resolution. The browser never receives a writable artist_id.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Columns: nullable first
-- ---------------------------------------------------------------------------

alter table public.enquiries
  add column if not exists artist_id uuid;
alter table public.projects
  add column if not exists artist_id uuid;
alter table public.sessions
  add column if not exists artist_id uuid;
alter table public.follow_ups
  add column if not exists artist_id uuid;
alter table public.email_messages
  add column if not exists artist_id uuid;
alter table public.integration_outbox
  add column if not exists artist_id uuid;

-- Activity history is append-only, including for BYPASSRLS roles. A constant
-- ADD COLUMN default materialises the historical Vladimir scope without an
-- UPDATE and therefore without disabling the append-only trigger. The default
-- is dropped below so future global/profile events may remain artist-neutral.
alter table public.activity_log
  add column if not exists artist_id uuid
  default 'a1111111-1111-4111-8111-111111111111'::uuid;

-- ---------------------------------------------------------------------------
-- Backfill every existing business row to Vladimir
-- ---------------------------------------------------------------------------

do $$
declare
  v_vladimir uuid := 'a1111111-1111-4111-8111-111111111111'::uuid;
begin
  if not exists (
    select 1
    from public.artists a
    where a.id = v_vladimir and a.slug = 'vladimir'
  ) then
    raise exception 'the seeded Vladimir artist row is missing'
      using errcode = '23503';
  end if;

  update public.enquiries
  set artist_id = v_vladimir
  where artist_id is null;

  update public.projects
  set artist_id = v_vladimir
  where artist_id is null;

  update public.sessions
  set artist_id = v_vladimir
  where artist_id is null;

  update public.follow_ups
  set artist_id = v_vladimir
  where artist_id is null;

  update public.email_messages
  set artist_id = v_vladimir
  where artist_id is null;

  update public.integration_outbox
  set artist_id = v_vladimir
  where artist_id is null;

  if exists (select 1 from public.enquiries where artist_id is null)
     or exists (select 1 from public.projects where artist_id is null)
     or exists (select 1 from public.sessions where artist_id is null)
     or exists (select 1 from public.follow_ups where artist_id is null)
     or exists (select 1 from public.email_messages where artist_id is null)
     or exists (select 1 from public.integration_outbox where artist_id is null) then
    raise exception 'artist backfill left an unscoped business row'
      using errcode = '23514';
  end if;

  -- At migration time every pre-existing audit row must also carry Vladimir.
  -- The column remains nullable after the migration for truly global events.
  if exists (select 1 from public.activity_log where artist_id is null) then
    raise exception 'historical activity backfill left an unscoped row'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.activity_log
  alter column artist_id drop default;

-- ---------------------------------------------------------------------------
-- Foreign keys, required scope and indexes
-- ---------------------------------------------------------------------------

alter table public.enquiries
  add constraint enquiries_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.projects
  add constraint projects_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.sessions
  add constraint sessions_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.follow_ups
  add constraint follow_ups_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.email_messages
  add constraint email_messages_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.integration_outbox
  add constraint integration_outbox_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict;
alter table public.activity_log
  add constraint activity_log_artist_id_fkey
  foreign key (artist_id) references public.artists(id) on delete restrict
  deferrable initially deferred;

-- Validate nullable-first backfills before taking the NOT NULL locks.
do $$
begin
  if exists (select 1 from public.enquiries where artist_id is null) then
    raise exception 'enquiries.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
  if exists (select 1 from public.projects where artist_id is null) then
    raise exception 'projects.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
  if exists (select 1 from public.sessions where artist_id is null) then
    raise exception 'sessions.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
  if exists (select 1 from public.follow_ups where artist_id is null) then
    raise exception 'follow_ups.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
  if exists (select 1 from public.email_messages where artist_id is null) then
    raise exception 'email_messages.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
  if exists (select 1 from public.integration_outbox where artist_id is null) then
    raise exception 'integration_outbox.artist_id cannot become NOT NULL' using errcode = '23514';
  end if;
end;
$$;

alter table public.enquiries alter column artist_id set not null;
alter table public.projects alter column artist_id set not null;
alter table public.sessions alter column artist_id set not null;
alter table public.follow_ups alter column artist_id set not null;
alter table public.email_messages alter column artist_id set not null;
alter table public.integration_outbox alter column artist_id set not null;

create index if not exists enquiries_artist_queue_idx
  on public.enquiries (artist_id, status, created_at desc)
  where archived_at is null and intake_state = 'complete';
create index if not exists projects_artist_status_idx
  on public.projects (artist_id, status, updated_at desc)
  where archived_at is null;
create index if not exists sessions_artist_start_idx
  on public.sessions (artist_id, start_at);
create index if not exists follow_ups_artist_due_idx
  on public.follow_ups (artist_id, due_at)
  where status = 'open';
create index if not exists email_messages_artist_status_idx
  on public.email_messages (artist_id, status, created_at desc);
create index if not exists integration_outbox_artist_ready_idx
  on public.integration_outbox (artist_id, next_attempt_at)
  where status in ('pending', 'failed');
create index if not exists activity_log_artist_recent_idx
  on public.activity_log (artist_id, occurred_at desc)
  where artist_id is not null;

-- Composite identity indexes let child rows carry a declarative guarantee that
-- their artist is the same as every referenced parent artist.
create unique index if not exists enquiries_id_artist_key
  on public.enquiries (id, artist_id);
create unique index if not exists projects_id_artist_key
  on public.projects (id, artist_id);
create unique index if not exists sessions_id_artist_key
  on public.sessions (id, artist_id);
create unique index if not exists email_messages_id_artist_key
  on public.email_messages (id, artist_id);
create unique index if not exists integration_outbox_id_artist_key
  on public.integration_outbox (id, artist_id);

alter table public.projects
  add constraint projects_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references public.enquiries(id, artist_id)
  on delete restrict;

alter table public.sessions
  add constraint sessions_project_artist_fkey
  foreign key (project_id, artist_id)
  references public.projects(id, artist_id)
  on delete restrict;

alter table public.follow_ups
  add constraint follow_ups_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references public.enquiries(id, artist_id)
  on delete cascade;
alter table public.follow_ups
  add constraint follow_ups_project_artist_fkey
  foreign key (project_id, artist_id)
  references public.projects(id, artist_id)
  on delete cascade;

alter table public.email_messages
  add constraint email_messages_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references public.enquiries(id, artist_id)
  on delete set null;
alter table public.email_messages
  add constraint email_messages_project_artist_fkey
  foreign key (project_id, artist_id)
  references public.projects(id, artist_id)
  on delete set null;

alter table public.integration_outbox
  add constraint integration_outbox_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references public.enquiries(id, artist_id)
  on delete set null;
alter table public.integration_outbox
  add constraint integration_outbox_project_artist_fkey
  foreign key (project_id, artist_id)
  references public.projects(id, artist_id)
  on delete set null;
alter table public.integration_outbox
  add constraint integration_outbox_session_artist_fkey
  foreign key (session_id, artist_id)
  references public.sessions(id, artist_id)
  on delete set null;
alter table public.integration_outbox
  add constraint integration_outbox_email_artist_fkey
  foreign key (email_message_id, artist_id)
  references public.email_messages(id, artist_id)
  on delete set null;

-- Activity rows are nullable only when the event is genuinely global. When an
-- artist and an entity are both present, the pair must agree.
alter table public.activity_log
  add constraint activity_log_enquiry_artist_fkey
  foreign key (enquiry_id, artist_id)
  references public.enquiries(id, artist_id)
  on delete set null deferrable initially deferred;
alter table public.activity_log
  add constraint activity_log_project_artist_fkey
  foreign key (project_id, artist_id)
  references public.projects(id, artist_id)
  on delete set null deferrable initially deferred;
alter table public.activity_log
  add constraint activity_log_session_artist_fkey
  foreign key (session_id, artist_id)
  references public.sessions(id, artist_id)
  on delete set null deferrable initially deferred;

-- `projects` and `sessions` use column-level SELECT grants to hide finance.
-- Explicitly add the new operational scope column without widening money ACLs.
grant select (artist_id) on public.projects to authenticated;
grant select (artist_id) on public.sessions to authenticated;

comment on column public.enquiries.artist_id is
  'Authoritative artist scope. Legacy intake defaults server-side to Vladimir until booking_sources resolution replaces the fallback.';
comment on column public.projects.artist_id is
  'Inherited from the source enquiry, or explicitly chosen by a future protected manual-project workflow.';
comment on column public.sessions.artist_id is
  'Always identical to the parent project artist; sessions remain the calendar source of truth.';
comment on column public.follow_ups.artist_id is
  'Artist scope inherited from the linked enquiry/project. Client-only legacy calls temporarily fall back to Vladimir.';
comment on column public.email_messages.artist_id is
  'Artist scope inherited from the linked enquiry/project. No provider is connected in this stage.';
comment on column public.integration_outbox.artist_id is
  'Artist routing scope. Provider destination secrets remain in encrypted server-side configuration.';
comment on column public.activity_log.artist_id is
  'Artist context for scoped events. NULL is reserved for global/profile/system events; the log remains append-only.';

-- ---------------------------------------------------------------------------
-- Private artist resolution helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.legacy_default_artist_id()
returns uuid
language sql
immutable
parallel safe
set search_path = pg_catalog, crm_private
as $$
  select 'a1111111-1111-4111-8111-111111111111'::uuid;
$$;

create or replace function crm_private.require_active_artist(p_artist_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_artist_id is null then
    raise exception 'artist scope is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from crm_private.artist_state a
    where a.artist_id = p_artist_id and a.is_active
  ) then
    raise exception 'artist % does not exist or is inactive', p_artist_id
      using errcode = '23503';
  end if;
end;
$$;

-- Resolve every linked entity to one artist. A missing entity raises 23503;
-- two linked entities from different artists raise 23514. The function accepts
-- fixed identifiers only and never accepts SQL, relation names or predicates.
create or replace function crm_private.resolve_artist_from_links(
  p_enquiry_id      uuid default null,
  p_project_id      uuid default null,
  p_session_id      uuid default null,
  p_email_message_id uuid default null,
  p_outbox_id       uuid default null,
  p_enquiry_file_id uuid default null,
  p_project_file_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist   uuid;
  v_candidate uuid;
begin
  if p_enquiry_id is not null then
    select e.artist_id into v_candidate
    from public.enquiries e where e.id = p_enquiry_id;
    if not found then
      raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
    end if;
    v_artist := v_candidate;
  end if;

  if p_project_id is not null then
    select p.artist_id into v_candidate
    from public.projects p where p.id = p_project_id;
    if not found then
      raise exception 'project % does not exist', p_project_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  if p_session_id is not null then
    select s.artist_id into v_candidate
    from public.sessions s where s.id = p_session_id;
    if not found then
      raise exception 'session % does not exist', p_session_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  if p_email_message_id is not null then
    select m.artist_id into v_candidate
    from public.email_messages m where m.id = p_email_message_id;
    if not found then
      raise exception 'email message % does not exist', p_email_message_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  if p_outbox_id is not null then
    select o.artist_id into v_candidate
    from public.integration_outbox o where o.id = p_outbox_id;
    if not found then
      raise exception 'outbox job % does not exist', p_outbox_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  if p_enquiry_file_id is not null then
    select e.artist_id into v_candidate
    from public.enquiry_files f
    join public.enquiries e on e.id = f.enquiry_id
    where f.id = p_enquiry_file_id;
    if not found then
      raise exception 'enquiry file % does not exist', p_enquiry_file_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  if p_project_file_id is not null then
    select p.artist_id into v_candidate
    from public.project_files f
    join public.projects p on p.id = f.project_id
    where f.id = p_project_file_id;
    if not found then
      raise exception 'project file % does not exist', p_project_file_id using errcode = '23503';
    end if;
    if v_artist is null then
      v_artist := v_candidate;
    elsif v_artist <> v_candidate then
      raise exception 'linked entities belong to different artists' using errcode = '23514';
    end if;
  end if;

  return v_artist;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scope assignment and immutability triggers
-- ---------------------------------------------------------------------------

create or replace function crm_private.scope_enquiry_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'enquiries.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  if new.artist_id is null then
    new.artist_id := crm_private.legacy_default_artist_id();
  end if;

  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_project_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'projects.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id);

  if v_parent_artist is not null then
    if new.artist_id is null then
      new.artist_id := v_parent_artist;
    elsif new.artist_id <> v_parent_artist then
      raise exception 'project artist must match the source enquiry artist'
        using errcode = '23514';
    end if;
  elsif new.artist_id is null then
    new.artist_id := crm_private.legacy_default_artist_id();
  end if;

  if tg_op = 'INSERT' and new.enquiry_id is null then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_session_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'sessions.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(null, new.project_id);

  if new.artist_id is null then
    new.artist_id := v_parent_artist;
  elsif new.artist_id <> v_parent_artist then
    raise exception 'session artist must match the parent project artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_follow_up_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'follow_ups.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id, new.project_id);

  if new.artist_id is null then
    new.artist_id := coalesce(v_parent_artist, crm_private.legacy_default_artist_id());
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'follow-up artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_email_message_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'email_messages.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id, new.project_id);

  if new.artist_id is null then
    new.artist_id := coalesce(v_parent_artist, crm_private.legacy_default_artist_id());
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'email artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_outbox_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE' and new.artist_id is distinct from old.artist_id then
    raise exception 'integration_outbox.artist_id is immutable; use the protected routing workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(
    new.enquiry_id, new.project_id, new.session_id, new.email_message_id
  );

  if new.artist_id is null then
    new.artist_id := coalesce(v_parent_artist, crm_private.legacy_default_artist_id());
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'outbox artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_activity_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  v_parent_artist := crm_private.resolve_artist_from_links(
    new.enquiry_id,
    new.project_id,
    new.session_id,
    null,
    new.outbox_id,
    new.enquiry_file_id,
    new.project_file_id
  );

  if new.artist_id is null then
    new.artist_id := v_parent_artist;
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'activity artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Inserts and relationship changes run through the same invariant function.
-- Status/content-only updates do not re-query parent rows.
drop trigger if exists enquiries_assign_artist on public.enquiries;
create trigger enquiries_assign_artist
  before insert on public.enquiries
  for each row execute function crm_private.scope_enquiry_artist();
drop trigger if exists enquiries_protect_artist on public.enquiries;
create trigger enquiries_protect_artist
  before update of artist_id on public.enquiries
  for each row execute function crm_private.scope_enquiry_artist();

drop trigger if exists projects_assign_artist on public.projects;
create trigger projects_assign_artist
  before insert on public.projects
  for each row execute function crm_private.scope_project_artist();
drop trigger if exists projects_validate_artist_links on public.projects;
create trigger projects_validate_artist_links
  before update of artist_id, enquiry_id on public.projects
  for each row execute function crm_private.scope_project_artist();

drop trigger if exists sessions_assign_artist on public.sessions;
create trigger sessions_assign_artist
  before insert on public.sessions
  for each row execute function crm_private.scope_session_artist();
drop trigger if exists sessions_validate_artist_links on public.sessions;
create trigger sessions_validate_artist_links
  before update of artist_id, project_id on public.sessions
  for each row execute function crm_private.scope_session_artist();

drop trigger if exists follow_ups_assign_artist on public.follow_ups;
create trigger follow_ups_assign_artist
  before insert on public.follow_ups
  for each row execute function crm_private.scope_follow_up_artist();
drop trigger if exists follow_ups_validate_artist_links on public.follow_ups;
create trigger follow_ups_validate_artist_links
  before update of artist_id, enquiry_id, project_id on public.follow_ups
  for each row execute function crm_private.scope_follow_up_artist();

drop trigger if exists email_messages_assign_artist on public.email_messages;
create trigger email_messages_assign_artist
  before insert on public.email_messages
  for each row execute function crm_private.scope_email_message_artist();
drop trigger if exists email_messages_validate_artist_links on public.email_messages;
create trigger email_messages_validate_artist_links
  before update of artist_id, enquiry_id, project_id on public.email_messages
  for each row execute function crm_private.scope_email_message_artist();

drop trigger if exists integration_outbox_assign_artist on public.integration_outbox;
create trigger integration_outbox_assign_artist
  before insert on public.integration_outbox
  for each row execute function crm_private.scope_outbox_artist();
drop trigger if exists integration_outbox_validate_artist_links on public.integration_outbox;
create trigger integration_outbox_validate_artist_links
  before update of artist_id, enquiry_id, project_id, session_id, email_message_id
  on public.integration_outbox
  for each row execute function crm_private.scope_outbox_artist();

drop trigger if exists activity_log_assign_artist on public.activity_log;
create trigger activity_log_assign_artist
  before insert on public.activity_log
  for each row execute function crm_private.scope_activity_artist();

-- All private helpers and trigger functions stay outside the Data API.
revoke all on function crm_private.legacy_default_artist_id()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.require_active_artist(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.resolve_artist_from_links(uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_enquiry_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_project_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_session_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_follow_up_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_email_message_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_outbox_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_activity_artist()
  from public, anon, authenticated, service_role;
