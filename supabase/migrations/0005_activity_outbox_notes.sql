-- 0005_activity_outbox_notes.sql
--
-- Append-only activity log, internal notes, email records, follow-ups and the
-- durable integration outbox.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- activity_log
--
-- Append-only for EVERY role, including owner and service_role. RLS (migration
-- 0007) simply has no UPDATE or DELETE policy; the trigger below is the part
-- that also stops a BYPASSRLS role, which RLS alone cannot.
-- ---------------------------------------------------------------------------

create table if not exists public.activity_log (
  id               uuid primary key default gen_random_uuid(),
  occurred_at      timestamptz not null default now(),
  event_type       text not null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_kind       text not null default 'system',

  -- These references are DEFERRABLE INITIALLY DEFERRED because an audit row is
  -- sometimes written before the row it describes exists. Owner bootstrap is
  -- the clearest case: the `owner.bootstrapped` event has to be recorded while
  -- the transaction is still in the "no owner yet" authorisation window, which
  -- is before the profile insert. The constraint is still enforced, just at
  -- commit, so an audit row can never end up pointing at nothing.
  client_id        uuid references public.clients(id) on delete set null deferrable initially deferred,
  enquiry_id       uuid references public.enquiries(id) on delete set null deferrable initially deferred,
  project_id       uuid references public.projects(id) on delete set null deferrable initially deferred,
  session_id       uuid references public.sessions(id) on delete set null deferrable initially deferred,
  profile_id       uuid references public.profiles(id) on delete set null deferrable initially deferred,
  enquiry_file_id  uuid references public.enquiry_files(id) on delete set null deferrable initially deferred,
  project_file_id  uuid references public.project_files(id) on delete set null deferrable initially deferred,
  outbox_id        uuid,

  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  constraint activity_log_event_type_shape check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint activity_log_actor_kind_allowed
    check (actor_kind in ('staff', 'owner', 'system', 'worker', 'ai')),
  constraint activity_log_metadata_is_object check (jsonb_typeof(metadata) = 'object'),
  constraint activity_log_metadata_size check (pg_column_size(metadata) <= 4096)
);

comment on table public.activity_log is
  'Append-only audit trail. No UPDATE or DELETE is possible for any role, including service_role.';
comment on column public.activity_log.metadata is
  'Small, safe key/value context only. Raw file content and unnecessary PII are rejected by a trigger.';

create index if not exists activity_log_recent_idx on public.activity_log (occurred_at desc);
create index if not exists activity_log_client_idx on public.activity_log (client_id, occurred_at desc) where client_id is not null;
create index if not exists activity_log_enquiry_idx on public.activity_log (enquiry_id, occurred_at desc) where enquiry_id is not null;
create index if not exists activity_log_project_idx on public.activity_log (project_id, occurred_at desc) where project_id is not null;
create index if not exists activity_log_session_idx on public.activity_log (session_id, occurred_at desc) where session_id is not null;
create index if not exists activity_log_profile_idx on public.activity_log (profile_id, occurred_at desc) where profile_id is not null;
create index if not exists activity_log_actor_idx on public.activity_log (actor_profile_id, occurred_at desc) where actor_profile_id is not null;
create index if not exists activity_log_event_type_idx on public.activity_log (event_type, occurred_at desc);

-- Metadata guard.
--
-- The audit trail records that something happened and to which entity; it is
-- not a second copy of the client's personal data. Keys that would duplicate
-- PII or leak a credential are refused outright, so a careless caller cannot
-- quietly turn the log into a PII store.
create or replace function crm_private.guard_activity_metadata()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  forbidden text[] := array[
    'email', 'email_address', 'phone', 'phone_number', 'whatsapp', 'instagram',
    'full_name', 'name', 'idea', 'message', 'body', 'notes', 'note',
    'original_filename', 'filename', 'file_content', 'content', 'data',
    'signed_url', 'url', 'token', 'access_token', 'refresh_token',
    'authorization', 'api_key', 'key', 'secret', 'password', 'ip', 'ip_address'
  ];
  offending text;
begin
  select k into offending
  from jsonb_object_keys(new.metadata) as k
  where lower(k) = any (forbidden)
  limit 1;

  if offending is not null then
    raise exception 'activity_log.metadata may not contain the key %', offending
      using errcode = '23514',
            detail = 'The activity log records events and entity references, not personal data or credentials.';
  end if;

  return new;
end;
$$;

drop trigger if exists activity_log_guard_metadata on public.activity_log;
create trigger activity_log_guard_metadata
  before insert on public.activity_log
  for each row execute function crm_private.guard_activity_metadata();

-- Append-only enforcement that survives BYPASSRLS.
create or replace function crm_private.reject_activity_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'activity_log is append-only (% is not permitted)', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists activity_log_append_only on public.activity_log;
create trigger activity_log_append_only
  before update or delete on public.activity_log
  for each row execute function crm_private.reject_activity_mutation();

drop trigger if exists activity_log_append_only_truncate on public.activity_log;
create trigger activity_log_append_only_truncate
  before truncate on public.activity_log
  for each statement execute function crm_private.reject_activity_mutation();

-- ---------------------------------------------------------------------------
-- internal_notes
--
-- Staff commentary kept out of the audit trail, so the audit trail stays a
-- record of events rather than a free-text field.
-- ---------------------------------------------------------------------------

create table if not exists public.internal_notes (
  id                uuid primary key default gen_random_uuid(),
  author_profile_id uuid not null references public.profiles(id) on delete restrict,
  client_id         uuid references public.clients(id) on delete cascade,
  enquiry_id        uuid references public.enquiries(id) on delete cascade,
  project_id        uuid references public.projects(id) on delete cascade,
  session_id        uuid references public.sessions(id) on delete cascade,
  body              text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint internal_notes_body_not_blank check (btrim(body) <> ''),
  constraint internal_notes_body_length check (char_length(body) <= 8000),
  constraint internal_notes_has_entity check (
    num_nonnulls(client_id, enquiry_id, project_id, session_id) >= 1
  )
);

create index if not exists internal_notes_enquiry_idx on public.internal_notes (enquiry_id, created_at desc) where enquiry_id is not null;
create index if not exists internal_notes_client_idx on public.internal_notes (client_id, created_at desc) where client_id is not null;
create index if not exists internal_notes_project_idx on public.internal_notes (project_id, created_at desc) where project_id is not null;

-- ---------------------------------------------------------------------------
-- email_messages
--
-- Every outbound email, whether transactional or human-approved, has a row
-- here before it is queued. AI-generated content can only ever create a draft.
-- ---------------------------------------------------------------------------

create table if not exists public.email_messages (
  id                  uuid primary key default gen_random_uuid(),
  status              public.email_message_status not null default 'draft',
  client_id           uuid references public.clients(id) on delete set null,
  enquiry_id          uuid references public.enquiries(id) on delete set null,
  project_id          uuid references public.projects(id) on delete set null,
  to_email            text not null,
  subject             text not null,
  body                text not null,
  template_key        text,
  template_version    integer,
  created_by          uuid references public.profiles(id) on delete set null,
  created_by_kind     text not null default 'human',
  approved_by         uuid references public.profiles(id) on delete set null,
  approved_at         timestamptz,
  queued_at           timestamptz,
  sent_at             timestamptz,
  failed_at           timestamptz,
  provider            text,
  provider_message_id text,
  error_code          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint email_messages_to_email_shape
    check (to_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint email_messages_subject_not_blank check (btrim(subject) <> ''),
  constraint email_messages_subject_length check (char_length(subject) <= 300),
  constraint email_messages_body_length check (char_length(body) <= 40000),
  constraint email_messages_created_by_kind_allowed
    check (created_by_kind in ('human', 'ai', 'system')),
  constraint email_messages_error_code_shape
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  -- Approval is required before anything can leave draft towards a send.
  constraint email_messages_approval_required
    check (status not in ('approved', 'queued', 'sent') or (approved_by is not null and approved_at is not null)),
  -- A provider message id only exists after the provider actually accepted it.
  constraint email_messages_provider_id_requires_sent
    check (provider_message_id is null or status = 'sent'),
  constraint email_messages_sent_at_matches_status
    check ((status = 'sent') = (sent_at is not null))
);

-- AI may draft, never send. Enforced on insert so an AI caller cannot create a
-- row that is already approved or queued.
create or replace function crm_private.guard_email_message_origin()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.created_by_kind = 'ai' and new.status <> 'draft' then
    raise exception 'AI-created email content may only be inserted as a draft'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists email_messages_guard_origin on public.email_messages;
create trigger email_messages_guard_origin
  before insert on public.email_messages
  for each row execute function crm_private.guard_email_message_origin();

create index if not exists email_messages_status_idx on public.email_messages (status, created_at desc);
create index if not exists email_messages_client_idx on public.email_messages (client_id, created_at desc) where client_id is not null;
create index if not exists email_messages_enquiry_idx on public.email_messages (enquiry_id, created_at desc) where enquiry_id is not null;

-- ---------------------------------------------------------------------------
-- follow_ups
-- ---------------------------------------------------------------------------

create table if not exists public.follow_ups (
  id           uuid primary key default gen_random_uuid(),
  status       public.follow_up_status not null default 'open',
  due_at       timestamptz not null,
  subject      text not null,
  details      text,
  client_id    uuid references public.clients(id) on delete cascade,
  enquiry_id   uuid references public.enquiries(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,
  assigned_to  uuid references public.profiles(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint follow_ups_subject_not_blank check (btrim(subject) <> ''),
  constraint follow_ups_subject_length check (char_length(subject) <= 200),
  constraint follow_ups_details_length check (details is null or char_length(details) <= 4000),
  constraint follow_ups_has_entity check (num_nonnulls(client_id, enquiry_id, project_id) >= 1),
  constraint follow_ups_completed_at_matches_status check ((status = 'done') = (completed_at is not null)),
  constraint follow_ups_cancelled_at_matches_status check ((status = 'cancelled') = (cancelled_at is not null))
);

create index if not exists follow_ups_open_due_idx on public.follow_ups (due_at) where status = 'open';
create index if not exists follow_ups_assigned_idx on public.follow_ups (assigned_to, due_at) where status = 'open';
create index if not exists follow_ups_enquiry_idx on public.follow_ups (enquiry_id, due_at) where enquiry_id is not null;

-- ---------------------------------------------------------------------------
-- integration_outbox
--
-- Durable jobs for everything that leaves the system after the database has
-- already committed: Telegram notifications, transactional email, approved
-- email, calendar create/update/cancel, and reconciliation sweeps.
--
-- The unique dedupe key is what makes "at least once" delivery safe: a retry
-- that re-enqueues the same logical job is a no-op rather than a duplicate
-- notification or a duplicate calendar event.
-- ---------------------------------------------------------------------------

create table if not exists public.integration_outbox (
  id               uuid primary key default gen_random_uuid(),
  kind             public.outbox_kind not null,
  dedupe_key       text not null,
  status           public.outbox_status not null default 'pending',
  payload          jsonb not null default '{}'::jsonb,

  client_id        uuid references public.clients(id) on delete set null,
  enquiry_id       uuid references public.enquiries(id) on delete set null,
  project_id       uuid references public.projects(id) on delete set null,
  session_id       uuid references public.sessions(id) on delete set null,
  email_message_id uuid references public.email_messages(id) on delete set null,

  attempt_count    integer not null default 0,
  max_attempts     integer not null default 8,
  next_attempt_at  timestamptz not null default now(),

  leased_by        text,
  leased_at        timestamptz,
  lease_expires_at timestamptz,

  last_error_code  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint integration_outbox_dedupe_key_key unique (dedupe_key),
  constraint integration_outbox_dedupe_key_shape
    check (dedupe_key ~ '^[a-z][a-z0-9_]*:[a-z0-9_:.-]{1,180}$'),
  constraint integration_outbox_attempts_non_negative check (attempt_count >= 0),
  constraint integration_outbox_max_attempts_positive check (max_attempts > 0),
  constraint integration_outbox_payload_is_object check (jsonb_typeof(payload) = 'object'),
  constraint integration_outbox_payload_size check (pg_column_size(payload) <= 8192),
  constraint integration_outbox_error_code_shape
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint integration_outbox_lease_consistent
    check ((status = 'leased') = (leased_by is not null and lease_expires_at is not null))
);

comment on table public.integration_outbox is
  'Durable side-effect queue drained after commit. A failed job never invalidates the committed enquiry.';
comment on column public.integration_outbox.dedupe_key is
  'Unique logical job identity, e.g. telegram:enquiry_created:<uuid> or calendar:create:<session_uuid>:<version>.';

create index if not exists integration_outbox_ready_idx
  on public.integration_outbox (next_attempt_at)
  where status in ('pending', 'failed');
create index if not exists integration_outbox_status_idx on public.integration_outbox (status, updated_at desc);
create index if not exists integration_outbox_kind_idx on public.integration_outbox (kind, status);

-- The same redaction rule as the activity log: an outbox payload carries
-- identifiers the worker can resolve, not a second copy of the client's data.
drop trigger if exists integration_outbox_guard_payload on public.integration_outbox;

create or replace function crm_private.guard_outbox_payload()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  forbidden text[] := array[
    'email', 'phone', 'whatsapp', 'instagram', 'full_name', 'idea',
    'signed_url', 'token', 'access_token', 'refresh_token', 'api_key',
    'secret', 'password', 'file_content'
  ];
  offending text;
begin
  select k into offending
  from jsonb_object_keys(new.payload) as k
  where lower(k) = any (forbidden)
  limit 1;

  if offending is not null then
    raise exception 'integration_outbox.payload may not contain the key %', offending
      using errcode = '23514',
            detail = 'Outbox payloads carry identifiers the worker resolves, not personal data or credentials.';
  end if;

  return new;
end;
$$;

create trigger integration_outbox_guard_payload
  before insert or update of payload on public.integration_outbox
  for each row execute function crm_private.guard_outbox_payload();

-- Calendar dedupe key helper, so create/update/cancel keys are built the same
-- way everywhere and a repeated enqueue collides instead of duplicating.
create or replace function public.calendar_outbox_dedupe_key(
  p_action text,
  p_session_id uuid,
  p_version integer
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select 'calendar:' || p_action || ':' || p_session_id || ':' || p_version;
$$;

revoke all on function public.calendar_outbox_dedupe_key(text, uuid, integer) from public;
