-- 010_schema_constraints.sql
--
-- Enums, table shape, constraints, timestamp triggers and reference-number
-- generation.
--
-- Fixture note: direct fixture writes run as the privileged test/migration
-- owner. Claims satisfy FORCE RLS in the stricter plain-PostgreSQL harness, but
-- those writes do not represent Worker table access. Worker ACLs are exercised
-- separately with SET LOCAL ROLE service_role in 050_rls_roles.sql.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

select has_type('public', 'crm_role', 'crm_role exists');
select enum_has_labels('public', 'crm_role', array['owner', 'booking_manager', 'read_only'],
  'crm_role has exactly the three CRM roles');

select enum_has_labels('public', 'enquiry_status', array[
  'new', 'reviewing', 'waiting_for_client', 'accepted', 'declined',
  'quote_sent', 'deposit_requested', 'deposit_paid', 'converted', 'closed'
], 'enquiry_status has the required labels');

select enum_has_labels('public', 'enquiry_file_category', array['reference', 'design', 'session', 'healed'],
  'enquiry_file_category covers all four storage prefixes');
select enum_has_labels('public', 'enquiry_upload_state', array['pending', 'uploading', 'ready', 'failed'],
  'enquiry_upload_state has the required labels');
select enum_has_labels('public', 'project_status', array['draft', 'active', 'on_hold', 'completed', 'cancelled'],
  'project_status has the required labels');
select enum_has_labels('public', 'deposit_status', array['not_required', 'requested', 'paid', 'refunded', 'forfeited'],
  'deposit_status has the required labels');
select enum_has_labels('public', 'session_status', array['draft', 'proposed', 'confirmed', 'completed', 'cancelled', 'no_show'],
  'session_status has the required labels');
select enum_has_labels('public', 'payment_status', array['unpaid', 'deposit_paid', 'part_paid', 'paid', 'refunded'],
  'payment_status has the required labels');
select enum_has_labels('public', 'calendar_provider', array['none', 'google'],
  'calendar_provider defaults to none and knows only google');
select enum_has_labels('public', 'outbox_kind', array[
  'telegram_notification', 'transactional_email', 'approved_email',
  'calendar_create', 'calendar_update', 'calendar_cancel', 'reconciliation',
  'calendar_availability_create', 'calendar_availability_update',
  'calendar_availability_cancel', 'whatsapp_message', 'instagram_message'
], 'outbox_kind covers every integration job');
select enum_has_labels('public', 'outbox_status', array['pending', 'leased', 'succeeded', 'failed', 'dead'],
  'outbox_status has the required labels');
select enum_has_labels('public', 'email_message_status', array['draft', 'approved', 'queued', 'sent', 'failed', 'cancelled'],
  'email_message_status has the six required states');
select enum_has_labels('public', 'follow_up_status', array['open', 'done', 'cancelled'],
  'follow_up_status has the required labels');

-- ---------------------------------------------------------------------------
-- Tables and key columns
-- ---------------------------------------------------------------------------

select has_table('public', t, t || ' exists')
from unnest(array[
  'profiles', 'clients', 'enquiries', 'enquiry_files', 'projects',
  'project_files', 'sessions', 'activity_log', 'internal_notes',
  'email_messages', 'follow_ups', 'integration_outbox', 'system_settings'
]) as t;

select has_column('public', 'enquiries', c, 'enquiries.' || c || ' exists')
from unnest(array[
  'id', 'client_id', 'reference_number', 'idempotency_key', 'status',
  'intake_state', 'intake_error_code', 'assigned_to', 'project_type',
  'placement', 'approximate_size', 'cover_up', 'preferred_timing', 'idea',
  'source', 'landing_page', 'referrer', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_content', 'utm_term', 'created_at', 'updated_at',
  'last_action_at', 'archived_at'
]) as c;

select has_column('public', 'clients', c, 'clients.' || c || ' exists')
from unnest(array[
  'id', 'full_name', 'email', 'email_normalized', 'phone', 'phone_normalized',
  'instagram', 'preferred_contact', 'travelling_from', 'notes_summary',
  'created_at', 'updated_at', 'archived_at'
]) as c;

select has_column('public', 'enquiry_files', c, 'enquiry_files.' || c || ' exists')
from unnest(array[
  'id', 'enquiry_id', 'category', 'storage_path', 'original_filename',
  'safe_extension', 'mime_type', 'byte_size', 'checksum', 'upload_state',
  'created_at', 'uploaded_at'
]) as c;

select col_is_unique('public', 'enquiries', 'idempotency_key', 'idempotency_key is unique');
select col_is_unique('public', 'enquiries', 'reference_number', 'reference_number is unique');
select col_not_null('public', 'enquiries', 'idempotency_key', 'idempotency_key is not null');
select col_is_unique('public', 'enquiry_files', 'storage_path', 'each storage path is globally unique');
select col_is_unique('public', 'integration_outbox', 'dedupe_key', 'outbox dedupe keys are unique');

-- Money is exact, never floating point.
select is(format_type(a.atttypid, a.atttypmod), 'numeric(12,2)',
          'projects.' || a.attname || ' is numeric(12,2)')
from pg_attribute a
where a.attrelid = 'public.projects'::regclass
  and a.attname in ('hourly_rate', 'estimate_total', 'deposit_amount');

select is(format_type(a.atttypid, a.atttypmod), 'numeric(12,2)', 'sessions.price is numeric(12,2)')
from pg_attribute a
where a.attrelid = 'public.sessions'::regclass and a.attname = 'price';

select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'projects' and column_name = 'currency'),
          '''GBP''::text', 'projects.currency defaults to GBP but is stored explicitly');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active)
values ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'Fixture Owner', 'owner', true);

-- Act as the owner from here on, exactly as PostgREST would.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select ok(public.is_active_user(), 'the fixture owner is recognised as an active user');

insert into public.clients (id, full_name, email, phone)
values ('c0000000-0000-4000-8000-000000000001', 'Constraint Fixture', 'fixture@example.test', '+441234567890');

-- ---------------------------------------------------------------------------
-- Reference numbers
-- ---------------------------------------------------------------------------

-- Explicit ids: `created_at` defaults to now(), which is transaction start, so
-- two rows inserted in the same transaction tie and cannot be ordered by it.
insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at
)
values ('e0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
        'IGNORED', gen_random_uuid(), repeat('a', 64), 'complete',
        'Constraint Fixture', 'fixture@example.test', '2026-07-29', now());
insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at
)
values ('e0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
        'IGNORED-TOO', gen_random_uuid(), repeat('b', 64), 'complete',
        'Constraint Fixture', 'fixture@example.test', '2026-07-29', now());

select is((select count(distinct reference_number)::int from public.enquiries), 2,
          'each enquiry receives a distinct reference number');
select ok((select bool_and(reference_number ~ '^ENQ-[0-9]{4}-[0-9]{4,}$') from public.enquiries),
          'reference numbers use the ENQ-YYYY-NNNN format');
select ok((select bool_and(reference_number not like 'IGNORED%') from public.enquiries),
          'a caller-supplied reference number is discarded and replaced by the database');
select is((select substring(reference_number from 5 for 4) from public.enquiries
             where id = 'e0000000-0000-4000-8000-000000000001'),
          to_char((now() at time zone 'utc')::date, 'YYYY'),
          'the reference year is the UTC year');

select throws_ok(
  $$update public.enquiries set reference_number = 'ENQ-2000-0001'
    where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'reference_number is immutable'
);

select throws_ok(
  $$update public.enquiries set submitted_email = 'changed@example.test'
    where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'the contact details submitted with an enquiry are immutable'
);

select throws_ok(
  $$insert into public.enquiries (
      client_id, reference_number, idempotency_key, intake_fingerprint,
      submitted_full_name, submitted_email,
      privacy_notice_version, privacy_acknowledged_at
    )
    select client_id, 'X', idempotency_key, repeat('c', 64),
           submitted_full_name, submitted_email, '2026-07-29', now()
    from public.enquiries
    where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23505', null,
  'a duplicate idempotency key is rejected by the unique constraint'
);

-- ---------------------------------------------------------------------------
-- Timestamp triggers
-- ---------------------------------------------------------------------------

update public.clients
set updated_at = '2000-01-01T00:00:00Z'
where id = 'c0000000-0000-4000-8000-000000000001';

select ok(
  (select updated_at from public.clients where id = 'c0000000-0000-4000-8000-000000000001') > '2020-01-01T00:00:00Z',
  'set_updated_at() overwrites a caller-supplied updated_at'
);

-- last_action_at moves on a status change, not on an unrelated edit.
update public.enquiries set last_action_at = '2000-01-01T00:00:00Z', idea = 'first'
where id = 'e0000000-0000-4000-8000-000000000001';

select ok(
  (select last_action_at from public.enquiries where id = 'e0000000-0000-4000-8000-000000000001')
    < '2020-01-01T00:00:00Z',
  'editing free text does not touch last_action_at'
);

update public.enquiries set status = 'reviewing'
where id = 'e0000000-0000-4000-8000-000000000001';

select ok(
  (select last_action_at from public.enquiries where id = 'e0000000-0000-4000-8000-000000000001')
    > '2020-01-01T00:00:00Z',
  'a status change touches last_action_at'
);

-- ---------------------------------------------------------------------------
-- File constraints
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.enquiry_files (enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select id, 0, 'clients/x/enquiries/y/references/z.jpg', 'jpg', 'image/jpeg', 10
    from public.enquiries where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a non-canonical storage path is rejected'
);

select throws_ok(
  $$insert into public.enquiry_files (id, enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select 'f0000000-0000-4000-8000-000000000001',
           e.id, 0,
           public.enquiry_file_storage_path(e.client_id, e.id, 'f0000000-0000-4000-8000-000000000001', 'jpg'),
           'jpg', 'image/jpeg', 0
    from public.enquiries e where e.id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a zero-byte file is rejected'
);

select throws_ok(
  $$insert into public.enquiry_files (id, enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select 'f0000000-0000-4000-8000-000000000002',
           e.id, 0,
           public.enquiry_file_storage_path(e.client_id, e.id, 'f0000000-0000-4000-8000-000000000002', 'gif'),
           'gif', 'image/gif', 100
    from public.enquiries e where e.id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a non-allow-listed MIME type is rejected'
);

select throws_ok(
  $$insert into public.enquiry_files (id, enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select 'f0000000-0000-4000-8000-000000000003',
           e.id, 0,
           public.enquiry_file_storage_path(e.client_id, e.id, 'f0000000-0000-4000-8000-000000000003', 'png'),
           'png', 'image/jpeg', 100
    from public.enquiries e where e.id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a MIME type that disagrees with the extension is rejected'
);

select throws_ok(
  $$insert into public.enquiry_files (id, enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select 'f0000000-0000-4000-8000-000000000004',
           e.id, 0,
           public.enquiry_file_storage_path(e.client_id, e.id, 'f0000000-0000-4000-8000-000000000004', 'jpg'),
           'jpg', 'image/jpeg', 5 * 1024 * 1024
    from public.enquiries e where e.id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a file larger than 4 MB is rejected'
);

select lives_ok(
  $$insert into public.enquiry_files (id, enquiry_id, ordinal, storage_path, safe_extension, mime_type, byte_size)
    select 'f0000000-0000-4000-8000-000000000005',
           e.id, 0,
           public.enquiry_file_storage_path(e.client_id, e.id, 'f0000000-0000-4000-8000-000000000005', 'jpg'),
           'jpg', 'image/jpeg', 1024
    from public.enquiries e where e.id = 'e0000000-0000-4000-8000-000000000001'$$,
  'a canonical, allow-listed reference file is accepted'
);

select ok(
  (select storage_path !~* '^[a-z]+://' from public.enquiry_files
   where id = 'f0000000-0000-4000-8000-000000000005'),
  'storage_path holds an object key, never a URL'
);

-- ---------------------------------------------------------------------------
-- Session constraints
-- ---------------------------------------------------------------------------

insert into public.projects (id, client_id, title)
values ('90000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Constraint project');

select throws_ok(
  $$insert into public.sessions (project_id, start_at, end_at)
    values ('90000000-0000-4000-8000-000000000001', now(), now() - interval '1 hour')$$,
  '23514', null,
  'a session must end after it starts'
);

select lives_ok(
  $$insert into public.sessions (id, project_id, start_at, end_at)
    values ('50000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001',
            now(), now() + interval '3 hours')$$,
  'a valid session is accepted'
);

select throws_ok(
  $$update public.sessions set calendar_event_id = 'evt_1', calendar_provider = 'google'
    where id = '50000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a draft session cannot be given a calendar event id'
);

select ok(not public.session_is_calendar_eligible('draft'), 'draft sessions are not calendar eligible');
select ok(not public.session_is_calendar_eligible('proposed'), 'proposed sessions are not calendar eligible');
select ok(public.session_is_calendar_eligible('confirmed'), 'confirmed sessions are calendar eligible');

select lives_ok(
  $$update public.sessions
       set status = 'confirmed',
           calendar_event_id = 'evt_no_show',
           calendar_provider = 'google'
     where id = '50000000-0000-4000-8000-000000000001'$$,
  'a confirmed session may record its provider event'
);

select lives_ok(
  $$update public.sessions
       set status = 'no_show'
     where id = '50000000-0000-4000-8000-000000000001'$$,
  'a confirmed session with a provider event can be marked no-show without losing history'
);

select throws_ok(
  $$insert into public.project_files (
      id, project_id, category, storage_path, safe_extension, mime_type, byte_size
    ) values (
      '60000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000001',
      'design',
      public.project_file_storage_path(
        'c0000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000001',
        'design',
        '60000000-0000-4000-8000-000000000001',
        'jpg'
      ),
      'jpg', 'image/jpeg', 5 * 1024 * 1024
    )$$,
  '23514', null,
  'a project file larger than 4 MB is rejected'
);

select throws_ok(
  $$insert into public.project_files (
      id, project_id, category, storage_path, safe_extension, mime_type, byte_size
    ) values (
      '60000000-0000-4000-8000-000000000002',
      '90000000-0000-4000-8000-000000000001',
      'design',
      public.project_file_storage_path(
        'c0000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000001',
        'design',
        '60000000-0000-4000-8000-000000000002',
        'png'
      ),
      'png', 'image/jpeg', 1024
    )$$,
  '23514', null,
  'a project file MIME type must agree with its extension'
);

select throws_ok(
  $$insert into public.project_files (
      id, project_id, category, storage_path, safe_extension, mime_type, byte_size
    ) values (
      '60000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000001',
      'session',
      public.project_file_storage_path(
        'c0000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000001',
        'session',
        '60000000-0000-4000-8000-000000000003',
        'jpg'
      ),
      'jpg', 'image/jpeg', 1024
    )$$,
  '23514', null,
  'a session file must reference its session'
);

-- ---------------------------------------------------------------------------
-- Project constraints
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.projects (client_id, title, estimated_sessions)
    values ('c0000000-0000-4000-8000-000000000001', 'Bad estimate', 0)$$,
  '23514', null,
  'estimated_sessions must be positive'
);

select throws_ok(
  $$insert into public.projects (client_id, title, currency)
    values ('c0000000-0000-4000-8000-000000000001', 'Bad currency', 'pounds')$$,
  '23514', null,
  'currency must be a three-letter ISO code'
);

select throws_ok(
  $$insert into public.projects (client_id, title, deposit_amount, deposit_status)
    values ('c0000000-0000-4000-8000-000000000001', 'Zero deposit', 0, 'requested')$$,
  '23514', null,
  'a requested deposit must be positive'
);

select * from finish(true);
rollback;
