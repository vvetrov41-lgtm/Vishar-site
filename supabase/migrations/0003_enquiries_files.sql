-- 0003_enquiries_files.sql
--
-- Enquiries, their human-readable reference numbers, and the file manifests
-- that mirror objects in the private `crm-files` bucket.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Reference number generation
--
-- Format: ENQ-YYYY-NNNN, where YYYY is the UTC year and NNNN comes from a
-- global sequence. Uniqueness is guaranteed by the unique constraint on the
-- column, never by counting application-side rows. Beyond 9999 the numeric
-- part simply grows to five digits; it stays unique.
-- ---------------------------------------------------------------------------

create sequence if not exists crm_private.enquiry_reference_seq as bigint start with 1 increment by 1;

create or replace function public.next_enquiry_reference()
returns text
language sql
volatile
set search_path = pg_catalog, public, crm_private
as $$
  select 'ENQ-'
      || to_char((now() at time zone 'utc')::date, 'YYYY')
      || '-'
      || lpad(nextval('crm_private.enquiry_reference_seq')::text, 4, '0');
$$;

revoke all on function public.next_enquiry_reference() from public;

comment on function public.next_enquiry_reference() is
  'Generates ENQ-YYYY-NNNN in Postgres from a global sequence and the UTC year.';

-- ---------------------------------------------------------------------------
-- enquiries
-- ---------------------------------------------------------------------------

create table if not exists public.enquiries (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete restrict,
  reference_number text not null,
  idempotency_key  uuid not null,
  intake_fingerprint text not null,
  status           public.enquiry_status not null default 'new',
  intake_state     public.enquiry_intake_state not null default 'pending',
  intake_error_code text,
  client_identifier_conflict boolean not null default false,
  assigned_to      uuid references public.profiles(id) on delete set null,

  -- Immutable snapshot of what this form actually submitted. Client matching
  -- must never discard a new contact detail merely because the master client
  -- card already carries a different value.
  submitted_full_name         text not null,
  submitted_email             text not null,
  submitted_phone             text,
  submitted_instagram         text,
  submitted_preferred_contact text,
  submitted_travelling_from   text,

  project_type     text,
  placement        text,
  approximate_size text,
  cover_up         text,
  preferred_timing text,
  idea             text,

  source           text,
  landing_page     text,
  referrer         text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  utm_content      text,
  utm_term         text,
  privacy_notice_version text not null,
  privacy_acknowledged_at timestamptz not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_action_at   timestamptz not null default now(),
  archived_at      timestamptz,

  constraint enquiries_reference_number_key unique (reference_number),
  constraint enquiries_idempotency_key_key unique (idempotency_key),
  constraint enquiries_reference_format check (reference_number ~ '^ENQ-[0-9]{4}-[0-9]{4,}$'),
  constraint enquiries_intake_fingerprint_shape check (intake_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint enquiries_privacy_notice_version_shape
    check (privacy_notice_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

  -- `intake_error_code` is a short machine code only. Raw payloads, provider
  -- bodies and client text must never be stored here.
  constraint enquiries_intake_error_code_shape
    check (intake_error_code is null or intake_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint enquiries_intake_error_requires_failed_state
    check (intake_error_code is null or intake_state = 'failed'),

  constraint enquiries_submitted_full_name_not_blank check (btrim(submitted_full_name) <> ''),
  constraint enquiries_submitted_full_name_length check (char_length(submitted_full_name) <= 160),
  constraint enquiries_submitted_email_shape
    check (submitted_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint enquiries_submitted_email_length check (char_length(submitted_email) <= 320),
  constraint enquiries_submitted_phone_length
    check (submitted_phone is null or char_length(submitted_phone) <= 80),
  constraint enquiries_submitted_instagram_length
    check (submitted_instagram is null or char_length(submitted_instagram) <= 80),
  constraint enquiries_submitted_preferred_contact_allowed
    check (
      submitted_preferred_contact is null
      or submitted_preferred_contact in ('Email', 'WhatsApp', 'Instagram')
    ),
  constraint enquiries_submitted_travelling_from_length
    check (submitted_travelling_from is null or char_length(submitted_travelling_from) <= 160),
  constraint enquiries_project_type_length check (project_type is null or char_length(project_type) <= 100),
  constraint enquiries_placement_length check (placement is null or char_length(placement) <= 160),
  constraint enquiries_approximate_size_length check (approximate_size is null or char_length(approximate_size) <= 120),
  constraint enquiries_cover_up_length check (cover_up is null or char_length(cover_up) <= 40),
  constraint enquiries_preferred_timing_length check (preferred_timing is null or char_length(preferred_timing) <= 160),
  constraint enquiries_idea_length check (idea is null or char_length(idea) <= 4000),
  constraint enquiries_source_length check (source is null or char_length(source) <= 200),
  constraint enquiries_landing_page_length check (landing_page is null or char_length(landing_page) <= 500),
  constraint enquiries_referrer_length check (referrer is null or char_length(referrer) <= 500),
  constraint enquiries_utm_source_length check (utm_source is null or char_length(utm_source) <= 120),
  constraint enquiries_utm_medium_length check (utm_medium is null or char_length(utm_medium) <= 120),
  constraint enquiries_utm_campaign_length check (utm_campaign is null or char_length(utm_campaign) <= 160),
  constraint enquiries_utm_content_length check (utm_content is null or char_length(utm_content) <= 160),
  constraint enquiries_utm_term_length check (utm_term is null or char_length(utm_term) <= 160)
);

comment on table public.enquiries is
  'System of record for a tattoo enquiry. An enquiry exists when this row is committed; a Telegram message is not an enquiry.';
comment on column public.enquiries.idempotency_key is
  'Browser-generated UUID. The unique constraint plus create_enquiry_intake() make a retry return the original enquiry.';
comment on column public.enquiries.intake_fingerprint is
  'SHA-256 of the canonical intake payload. A reused idempotency key must carry the same payload.';
comment on column public.enquiries.intake_state is
  'pending -> files_pending -> complete. Only `complete` enquiries appear in the normal new-enquiry queue.';
comment on column public.enquiries.privacy_acknowledged_at is
  'When the visitor confirmed they had read the versioned privacy notice; this is an acknowledgement, not consent as the lawful basis.';
comment on column public.enquiries.submitted_email is
  'Immutable contact snapshot from this enquiry. It is not overwritten by later client matching or profile edits.';

-- Reference numbers are assigned by the database, never by the caller, and can
-- never be changed afterwards.
create or replace function crm_private.assign_enquiry_reference()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  new.reference_number := public.next_enquiry_reference();
  return new;
end;
$$;

create or replace function crm_private.protect_enquiry_reference()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.reference_number is distinct from old.reference_number then
    raise exception 'enquiries.reference_number is immutable'
      using errcode = '23514';
  end if;
  if new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'enquiries.idempotency_key is immutable'
      using errcode = '23514';
  end if;
  if new.intake_fingerprint is distinct from old.intake_fingerprint then
    raise exception 'enquiries.intake_fingerprint is immutable'
      using errcode = '23514';
  end if;
  if new.privacy_notice_version is distinct from old.privacy_notice_version
     or new.privacy_acknowledged_at is distinct from old.privacy_acknowledged_at then
    raise exception 'enquiry privacy acknowledgement is immutable'
      using errcode = '23514';
  end if;
  if new.submitted_full_name is distinct from old.submitted_full_name
     or new.submitted_email is distinct from old.submitted_email
     or new.submitted_phone is distinct from old.submitted_phone
     or new.submitted_instagram is distinct from old.submitted_instagram
     or new.submitted_preferred_contact is distinct from old.submitted_preferred_contact
     or new.submitted_travelling_from is distinct from old.submitted_travelling_from then
    raise exception 'enquiry submitted contact snapshot is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enquiries_assign_reference on public.enquiries;
create trigger enquiries_assign_reference
  before insert on public.enquiries
  for each row execute function crm_private.assign_enquiry_reference();

drop trigger if exists enquiries_protect_reference on public.enquiries;
create trigger enquiries_protect_reference
  before update on public.enquiries
  for each row execute function crm_private.protect_enquiry_reference();

-- Active queue: only complete intakes, newest first.
create index if not exists enquiries_active_queue_idx
  on public.enquiries (status, created_at desc)
  where archived_at is null and intake_state = 'complete';

-- Assignment view / "my queue".
create index if not exists enquiries_assignment_idx
  on public.enquiries (assigned_to, status, last_action_at desc)
  where archived_at is null;

-- Unassigned queue.
create index if not exists enquiries_unassigned_idx
  on public.enquiries (created_at desc)
  where assigned_to is null and archived_at is null and intake_state = 'complete';

-- Client history.
create index if not exists enquiries_client_history_idx
  on public.enquiries (client_id, created_at desc);

-- Recent activity.
create index if not exists enquiries_last_action_idx
  on public.enquiries (last_action_at desc)
  where archived_at is null;

-- Reconciliation: incomplete intakes only. Kept small by design.
create index if not exists enquiries_incomplete_intake_idx
  on public.enquiries (intake_state, updated_at)
  where intake_state <> 'complete';

-- ---------------------------------------------------------------------------
-- enquiry_files
--
-- One row per expected object in the private bucket. The row is created
-- `pending` inside the intake transaction, before any upload is attempted, so
-- a crashed upload always leaves a reconcilable manifest rather than an
-- invisible orphan.
-- ---------------------------------------------------------------------------

create table if not exists public.enquiry_files (
  id                uuid primary key default gen_random_uuid(),
  enquiry_id        uuid not null references public.enquiries(id) on delete restrict,
  ordinal           smallint not null,
  category          public.enquiry_file_category not null default 'reference',
  storage_path      text not null,
  original_filename text,
  safe_extension    text not null,
  mime_type         text not null,
  byte_size         bigint not null,
  checksum          text,
  upload_state      public.enquiry_upload_state not null default 'pending',
  created_at        timestamptz not null default now(),
  uploaded_at       timestamptz,

  constraint enquiry_files_storage_path_key unique (storage_path),
  constraint enquiry_files_enquiry_ordinal_key unique (enquiry_id, ordinal),
  constraint enquiry_files_ordinal_range check (ordinal between 0 and 2),
  constraint enquiry_files_category_is_reference check (category = 'reference'),
  constraint enquiry_files_byte_size_positive check (byte_size > 0),
  constraint enquiry_files_byte_size_max check (byte_size <= 4 * 1024 * 1024),
  constraint enquiry_files_mime_allowed
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint enquiry_files_extension_allowed
    check (safe_extension in ('jpg', 'jpeg', 'png', 'webp')),
  constraint enquiry_files_mime_matches_extension check (
    (mime_type = 'image/jpeg' and safe_extension in ('jpg', 'jpeg'))
    or (mime_type = 'image/png' and safe_extension = 'png')
    or (mime_type = 'image/webp' and safe_extension = 'webp')
  ),
  -- No public URL is ever stored: this column holds an object key, not a URL.
  constraint enquiry_files_path_is_not_url check (storage_path !~* '^[a-z]+://'),
  constraint enquiry_files_path_shape check (
    storage_path ~ ('^clients/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '/enquiries/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '/references/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '\.(jpg|jpeg|png|webp)$')
  ),
  constraint enquiry_files_uploaded_at_requires_ready
    check ((upload_state = 'ready') = (uploaded_at is not null)),
  constraint enquiry_files_checksum_shape
    check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  constraint enquiry_files_original_filename_length
    check (original_filename is null or char_length(original_filename) <= 255)
);

comment on table public.enquiry_files is
  'File manifests for enquiry reference images. storage_path is an object key in the private crm-files bucket; never a URL.';

-- The regex above proves the path is canonical in shape. This trigger proves
-- it is canonical for *this* row: correct client, correct enquiry, correct
-- file id, correct extension. A forged but well-formed path is rejected.
create or replace function crm_private.validate_enquiry_file_path()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_expected  text;
begin
  select e.client_id into v_client_id
  from public.enquiries e
  where e.id = new.enquiry_id;

  if v_client_id is null then
    raise exception 'enquiry % does not exist', new.enquiry_id using errcode = '23503';
  end if;

  v_expected := 'clients/' || v_client_id
             || '/enquiries/' || new.enquiry_id
             || '/references/' || new.id
             || '.' || new.safe_extension;

  if new.storage_path <> v_expected then
    raise exception 'enquiry_files.storage_path is not canonical for this row'
      using errcode = '23514',
            detail = 'A storage path must be derived from server-generated identifiers only.';
  end if;

  return new;
end;
$$;

drop trigger if exists enquiry_files_validate_path on public.enquiry_files;
create trigger enquiry_files_validate_path
  before insert or update of storage_path, enquiry_id, safe_extension on public.enquiry_files
  for each row execute function crm_private.validate_enquiry_file_path();

create index if not exists enquiry_files_enquiry_idx on public.enquiry_files (enquiry_id, ordinal);
create index if not exists enquiry_files_pending_idx
  on public.enquiry_files (upload_state, created_at)
  where upload_state <> 'ready';

-- ---------------------------------------------------------------------------
-- Convenience: canonical path builder used by the Worker and by tests so the
-- path format lives in exactly one place.
-- ---------------------------------------------------------------------------

create or replace function public.enquiry_file_storage_path(
  p_client_id uuid,
  p_enquiry_id uuid,
  p_file_id uuid,
  p_extension text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select 'clients/' || p_client_id
      || '/enquiries/' || p_enquiry_id
      || '/references/' || p_file_id
      || '.' || p_extension;
$$;

revoke all on function public.enquiry_file_storage_path(uuid, uuid, uuid, text) from public;
