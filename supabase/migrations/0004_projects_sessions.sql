-- 0004_projects_sessions.sql
--
-- Projects converted from enquiries, their sessions, and project file
-- manifests for the remaining canonical storage prefixes.
--
-- Money is `numeric(12,2)` throughout. Floating point is never used for money.
-- Currency is stored explicitly on every row that carries an amount; GBP is
-- the default but is not assumed by any query.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete restrict,
  enquiry_id         uuid references public.enquiries(id) on delete restrict,
  status             public.project_status not null default 'draft',
  title              text not null,
  description        text,
  estimated_sessions integer,
  estimated_hours    numeric(6,2),
  hourly_rate        numeric(12,2),
  estimate_total     numeric(12,2),
  deposit_amount     numeric(12,2),
  deposit_status     public.deposit_status not null default 'not_required',
  currency           text not null default 'GBP',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  archived_at        timestamptz,

  constraint projects_title_not_blank check (btrim(title) <> ''),
  constraint projects_title_length check (char_length(title) <= 200),
  constraint projects_description_length check (description is null or char_length(description) <= 8000),
  constraint projects_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint projects_estimated_sessions_positive
    check (estimated_sessions is null or estimated_sessions > 0),
  constraint projects_estimated_hours_positive
    check (estimated_hours is null or estimated_hours > 0),
  constraint projects_hourly_rate_non_negative
    check (hourly_rate is null or hourly_rate >= 0),
  constraint projects_estimate_total_non_negative
    check (estimate_total is null or estimate_total >= 0),
  constraint projects_deposit_amount_non_negative
    check (deposit_amount is null or deposit_amount >= 0),
  -- A requested or paid deposit must carry a real positive amount.
  constraint projects_deposit_amount_required_when_active
    check (deposit_status not in ('requested', 'paid') or deposit_amount > 0)
);

-- One enquiry converts to at most one project. Conversion is not repeatable.
create unique index if not exists projects_one_per_enquiry_idx
  on public.projects (enquiry_id) where enquiry_id is not null;

create index if not exists projects_client_idx on public.projects (client_id, created_at desc);
create index if not exists projects_status_idx
  on public.projects (status, updated_at desc) where archived_at is null;

comment on table public.projects is
  'A booked piece of work converted from an enquiry. Finance columns are not readable by booking_manager or read_only; see migration 0007.';
comment on column public.projects.currency is
  'ISO 4217 code stored explicitly per row. GBP is the default, not an assumption.';

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

create table if not exists public.sessions (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete restrict,
  status            public.session_status not null default 'draft',
  start_at          timestamptz not null,
  end_at            timestamptz not null,
  duration_hours    numeric(5,2),
  price             numeric(12,2),
  currency          text not null default 'GBP',
  payment_status    public.payment_status not null default 'unpaid',
  calendar_provider public.calendar_provider not null default 'none',
  calendar_event_id text,
  calendar_version  integer not null default 0,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  cancelled_at      timestamptz,

  constraint sessions_end_after_start check (end_at > start_at),
  constraint sessions_duration_non_negative check (duration_hours is null or duration_hours >= 0),
  constraint sessions_price_non_negative check (price is null or price >= 0),
  constraint sessions_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint sessions_notes_length check (notes is null or char_length(notes) <= 8000),
  constraint sessions_calendar_event_id_length
    check (calendar_event_id is null or char_length(calendar_event_id) <= 512),
  constraint sessions_calendar_version_non_negative check (calendar_version >= 0),

  -- A provider event id may only exist for a session that actually reached a
  -- confirmed state. Draft and proposed sessions never have one, which is the
  -- schema-level half of "draft or proposed sessions never create events".
  constraint sessions_event_requires_confirmed_lifecycle
    check (calendar_event_id is null or status in ('confirmed', 'completed', 'cancelled', 'no_show')),
  -- A provider is only named once an event actually exists.
  constraint sessions_provider_requires_event
    check (calendar_provider = 'none' or calendar_event_id is not null),
  constraint sessions_cancelled_at_matches_status
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- The same provider event can back at most one session row.
create unique index if not exists sessions_calendar_event_idx
  on public.sessions (calendar_provider, calendar_event_id)
  where calendar_event_id is not null;

create index if not exists sessions_project_idx on public.sessions (project_id, start_at);
create index if not exists sessions_upcoming_idx
  on public.sessions (start_at)
  where status in ('proposed', 'confirmed');

comment on table public.sessions is
  'Authoritative session record. Google Calendar is a projection of this table, never the reverse. No provider is connected.';

-- Calendar eligibility lives in one place so no caller can invent its own rule.
create or replace function public.session_is_calendar_eligible(p_status public.session_status)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select p_status = 'confirmed';
$$;

comment on function public.session_is_calendar_eligible(public.session_status) is
  'Only `confirmed` sessions may enqueue a calendar create/update. Draft and proposed never do.';

-- Blocks the "someone enqueued a calendar job for a draft" mistake at the
-- source: the event id can only be attached while the session is confirmed.
create or replace function crm_private.protect_session_calendar_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.calendar_event_id is not null
     and old.calendar_event_id is null
     and not public.session_is_calendar_eligible(new.status) then
    raise exception 'a calendar event may only be attached to a confirmed session'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_protect_calendar on public.sessions;
create trigger sessions_protect_calendar
  before update on public.sessions
  for each row execute function crm_private.protect_session_calendar_fields();

-- ---------------------------------------------------------------------------
-- project_files
--
-- Anchors the three remaining canonical storage prefixes (designs, sessions,
-- healed) to a database row, so migration 0008's Storage policies can validate
-- ownership of those paths the same way they validate enquiry references.
-- ---------------------------------------------------------------------------

create table if not exists public.project_files (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete restrict,
  session_id        uuid references public.sessions(id) on delete set null,
  category          public.enquiry_file_category not null,
  storage_path      text not null,
  original_filename text,
  safe_extension    text not null,
  mime_type         text not null,
  byte_size         bigint not null,
  checksum          text,
  upload_state      public.enquiry_upload_state not null default 'pending',
  created_at        timestamptz not null default now(),
  uploaded_at       timestamptz,

  constraint project_files_storage_path_key unique (storage_path),
  constraint project_files_category_allowed check (category in ('design', 'session', 'healed')),
  constraint project_files_byte_size_positive check (byte_size > 0),
  constraint project_files_byte_size_max check (byte_size <= 4 * 1024 * 1024),
  constraint project_files_mime_allowed
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint project_files_extension_allowed
    check (safe_extension in ('jpg', 'jpeg', 'png', 'webp')),
  constraint project_files_mime_matches_extension check (
    (mime_type = 'image/jpeg' and safe_extension in ('jpg', 'jpeg'))
    or (mime_type = 'image/png' and safe_extension = 'png')
    or (mime_type = 'image/webp' and safe_extension = 'webp')
  ),
  constraint project_files_session_required_for_session_category
    check ((category = 'session') = (session_id is not null)),
  constraint project_files_path_is_not_url check (storage_path !~* '^[a-z]+://'),
  constraint project_files_path_shape check (
    storage_path ~ ('^clients/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '/projects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '/(designs|sessions|healed)'
                 || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '\.(jpg|jpeg|png|webp)$')
  ),
  constraint project_files_uploaded_at_requires_ready
    check ((upload_state = 'ready') = (uploaded_at is not null)),
  constraint project_files_checksum_shape
    check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  constraint project_files_original_filename_length
    check (original_filename is null or char_length(original_filename) <= 255)
);

create or replace function public.project_file_storage_path(
  p_client_id uuid,
  p_project_id uuid,
  p_category public.enquiry_file_category,
  p_file_id uuid,
  p_extension text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select 'clients/' || p_client_id
      || '/projects/' || p_project_id
      || '/' || case p_category
                  when 'design'  then 'designs'
                  when 'session' then 'sessions'
                  when 'healed'  then 'healed'
                end
      || '/' || p_file_id
      || '.' || p_extension;
$$;

revoke all on function public.project_file_storage_path(uuid, uuid, public.enquiry_file_category, uuid, text) from public;

create or replace function crm_private.validate_project_file_path()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_session_project_id uuid;
  v_expected  text;
begin
  select p.client_id into v_client_id
  from public.projects p
  where p.id = new.project_id;

  if v_client_id is null then
    raise exception 'project % does not exist', new.project_id using errcode = '23503';
  end if;

  if new.session_id is not null then
    select s.project_id into v_session_project_id
    from public.sessions s
    where s.id = new.session_id;

    if v_session_project_id is null then
      raise exception 'session % does not exist', new.session_id using errcode = '23503';
    elsif v_session_project_id <> new.project_id then
      raise exception 'project file session must belong to the same project'
        using errcode = '23514';
    end if;
  end if;

  v_expected := public.project_file_storage_path(
    v_client_id, new.project_id, new.category, new.id, new.safe_extension
  );

  if new.storage_path <> v_expected then
    raise exception 'project_files.storage_path is not canonical for this row'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists project_files_validate_path on public.project_files;
create trigger project_files_validate_path
  before insert or update of storage_path, project_id, session_id, category, safe_extension
  on public.project_files
  for each row execute function crm_private.validate_project_file_path();

create index if not exists project_files_project_idx on public.project_files (project_id, created_at desc);
