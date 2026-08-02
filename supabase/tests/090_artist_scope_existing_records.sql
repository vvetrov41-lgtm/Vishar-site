-- 090_artist_scope_existing_records.sql
--
-- Migration 0016: required artist columns, legacy Vladimir fallback, parent
-- inheritance, cross-artist consistency and append-only activity context.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema shape
-- ---------------------------------------------------------------------------

select has_column('public', t, 'artist_id', t || '.artist_id exists')
from unnest(array[
  'enquiries', 'projects', 'sessions', 'follow_ups',
  'email_messages', 'integration_outbox', 'activity_log'
]) as t;

select col_not_null('public', t, 'artist_id', t || '.artist_id is required')
from unnest(array[
  'enquiries', 'projects', 'sessions', 'follow_ups',
  'email_messages', 'integration_outbox'
]) as t;

select ok(
  (select is_nullable = 'YES'
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'activity_log'
     and column_name = 'artist_id'),
  'activity_log.artist_id remains nullable for global events'
);

select is(
  (select column_default
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'activity_log'
     and column_name = 'artist_id'),
  null::text,
  'activity_log.artist_id has no ongoing default after historical backfill'
);

select is(
  (select count(*)::int
   from pg_constraint
   where connamespace = 'public'::regnamespace
     and conname in (
       'enquiries_artist_id_fkey',
       'projects_artist_id_fkey',
       'sessions_artist_id_fkey',
       'follow_ups_artist_id_fkey',
       'email_messages_artist_id_fkey',
       'integration_outbox_artist_id_fkey',
       'activity_log_artist_id_fkey'
     )
     and contype = 'f'),
  7,
  'every scoped table has a direct artist foreign key'
);

select is(
  (select count(*)::int
   from pg_constraint
   where connamespace = 'public'::regnamespace
     and conname in (
       'projects_enquiry_artist_fkey',
       'sessions_project_artist_fkey',
       'follow_ups_enquiry_artist_fkey',
       'follow_ups_project_artist_fkey',
       'email_messages_enquiry_artist_fkey',
       'email_messages_project_artist_fkey',
       'integration_outbox_enquiry_artist_fkey',
       'integration_outbox_project_artist_fkey',
       'integration_outbox_session_artist_fkey',
       'integration_outbox_email_artist_fkey',
       'activity_log_enquiry_artist_fkey',
       'activity_log_project_artist_fkey',
       'activity_log_session_artist_fkey'
     )
     and contype = 'f'),
  13,
  'linked entities have composite artist consistency foreign keys'
);

select ok(has_column_privilege('authenticated', 'public.projects', 'artist_id', 'SELECT'),
          'authenticated may read the operational project artist column');
select ok(has_column_privilege('authenticated', 'public.sessions', 'artist_id', 'SELECT'),
          'authenticated may read the operational session artist column');
select ok(not has_column_privilege('authenticated', 'public.projects', 'deposit_amount', 'SELECT'),
          'adding artist scope did not expose project deposit amounts');
select ok(not has_column_privilege('authenticated', 'public.sessions', 'price', 'SELECT'),
          'adding artist scope did not expose session prices');

-- ---------------------------------------------------------------------------
-- Owner and legacy intake fixture
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('61111111-1111-4111-8111-111111111111', 'scope-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('61111111-1111-4111-8111-111111111111', 'scope-owner@example.test', 'Scope Owner', 'owner', true);

create temporary table legacy_intake as
select public.create_enquiry_intake(
  '60000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'full_name', 'Legacy Vladimir Client',
    'email', 'legacy-vladimir@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Black and grey realism',
    'idea', 'Synthetic artist-scope fixture',
    'source', 'legacy-form',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  jsonb_build_array(
    jsonb_build_object(
      'mime_type', 'image/jpeg',
      'safe_extension', 'jpg',
      'byte_size', 1024
    )
  )
) as r;

grant select on legacy_intake to authenticated, service_role;

select public.mark_enquiry_file_uploaded(f.id)
from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from legacy_intake);

select public.finalize_enquiry_intake(
  (select (r ->> 'enquiry_id')::uuid from legacy_intake)
);

select is(
  (select e.artist_id
   from public.enquiries e
   where e.id = (select (r ->> 'enquiry_id')::uuid from legacy_intake)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the unchanged legacy intake RPC receives Vladimir from the server-side fallback'
);

select is(
  (select o.artist_id
   from public.integration_outbox o
   where o.enquiry_id = (select (r ->> 'enquiry_id')::uuid from legacy_intake)
     and o.kind = 'telegram_notification'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the intake Telegram outbox row inherits Vladimir'
);

select ok(
  not exists (
    select 1
    from public.activity_log a
    where a.enquiry_id = (select (r ->> 'enquiry_id')::uuid from legacy_intake)
      and a.artist_id is distinct from 'a1111111-1111-4111-8111-111111111111'::uuid
  ),
  'all enquiry-linked intake activity carries Vladimir'
);

-- ---------------------------------------------------------------------------
-- Existing workflow RPCs inherit artist without signature changes
-- ---------------------------------------------------------------------------

select set_config(
  'request.jwt.claims',
  '{"sub":"61111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select public.transition_enquiry_status(
  (select (r ->> 'enquiry_id')::uuid from legacy_intake),
  'accepted'
);

create temporary table legacy_project as
select (public.convert_enquiry_to_project(
  (select (r ->> 'enquiry_id')::uuid from legacy_intake),
  'Legacy Vladimir Project',
  'Synthetic only'
) ->> 'project_id')::uuid as id;

grant select on legacy_project to authenticated, service_role;

select is(
  (select artist_id from public.projects where id = (select id from legacy_project)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'project conversion inherits the enquiry artist'
);

create temporary table legacy_session as
select (public.schedule_session(
  (select id from legacy_project),
  now() + interval '20 days',
  now() + interval '20 days 7 hours',
  'proposed',
  'Synthetic scope session'
) ->> 'session_id')::uuid as id;

grant select on legacy_session to authenticated, service_role;

select is(
  (select artist_id from public.sessions where id = (select id from legacy_session)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'session scheduling inherits the project artist'
);

create temporary table legacy_follow_up as
select public.create_follow_up(
  'Synthetic follow-up',
  now() + interval '2 days',
  (select (r ->> 'client_id')::uuid from legacy_intake),
  (select (r ->> 'enquiry_id')::uuid from legacy_intake),
  (select id from legacy_project),
  '61111111-1111-4111-8111-111111111111'::uuid,
  'Synthetic details'
) as id;

grant select on legacy_follow_up to authenticated, service_role;

select is(
  (select artist_id from public.follow_ups where id = (select id from legacy_follow_up)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'follow-up inherits the linked enquiry/project artist'
);

create temporary table legacy_email as
select public.create_email_draft(
  'synthetic-recipient@example.test',
  'Synthetic draft',
  'Synthetic body',
  (select (r ->> 'client_id')::uuid from legacy_intake),
  (select (r ->> 'enquiry_id')::uuid from legacy_intake),
  (select id from legacy_project),
  'human'
) as id;

grant select on legacy_email to authenticated, service_role;

select is(
  (select artist_id from public.email_messages where id = (select id from legacy_email)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'email draft inherits the linked enquiry/project artist'
);

select public.approve_email_draft((select id from legacy_email));

select is(
  (select artist_id
   from public.integration_outbox
   where email_message_id = (select id from legacy_email)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'approved-email outbox routing inherits the email artist'
);

select public.set_session_status((select id from legacy_session), 'confirmed');

select is(
  (select artist_id
   from public.integration_outbox
   where session_id = (select id from legacy_session)
     and kind = 'calendar_create'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'confirmed-session calendar outbox routing inherits the session artist'
);

select ok(
  not exists (
    select 1
    from public.activity_log a
    where (
      a.enquiry_id = (select (r ->> 'enquiry_id')::uuid from legacy_intake)
      or a.project_id = (select id from legacy_project)
      or a.session_id = (select id from legacy_session)
    )
      and a.artist_id is distinct from 'a1111111-1111-4111-8111-111111111111'::uuid
  ),
  'workflow activity inherits Vladimir from every linked entity'
);

-- ---------------------------------------------------------------------------
-- A direct privileged Kristina fixture proves inheritance is generic
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table kristina_client as
insert into public.clients (full_name, email)
values ('Synthetic Kristina Client', 'synthetic-kristina@example.test')
returning id;

create temporary table kristina_enquiry as
insert into public.enquiries (
  client_id, artist_id, reference_number, idempotency_key, intake_fingerprint,
  status, intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at
) values (
  (select id from kristina_client),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'PENDING',
  '60000000-0000-4000-8000-000000000002'::uuid,
  repeat('b', 64),
  'accepted',
  'complete',
  'Synthetic Kristina Client',
  'synthetic-kristina@example.test',
  '2026-07-29',
  now()
)
returning id;

create temporary table kristina_project as
insert into public.projects (
  client_id, enquiry_id, title, description
) values (
  (select id from kristina_client),
  (select id from kristina_enquiry),
  'Synthetic Kristina Project',
  'Synthetic only'
)
returning id;

create temporary table kristina_session as
insert into public.sessions (
  project_id, status, start_at, end_at
) values (
  (select id from kristina_project),
  'proposed',
  now() + interval '40 days',
  now() + interval '40 days 6 hours'
)
returning id;

select is(
  (select artist_id from public.enquiries where id = (select id from kristina_enquiry)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'an explicit trusted Kristina enquiry keeps Kristina scope'
);
select is(
  (select artist_id from public.projects where id = (select id from kristina_project)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a project inherits Kristina from its enquiry'
);
select is(
  (select artist_id from public.sessions where id = (select id from kristina_session)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a session inherits Kristina from its project'
);

create temporary table kristina_follow_up as
insert into public.follow_ups (
  subject, due_at, client_id, enquiry_id, project_id
) values (
  'Synthetic Kristina follow-up',
  now() + interval '3 days',
  (select id from kristina_client),
  (select id from kristina_enquiry),
  (select id from kristina_project)
)
returning id;

create temporary table kristina_email as
insert into public.email_messages (
  status, client_id, enquiry_id, project_id,
  to_email, subject, body, created_by_kind
) values (
  'draft',
  (select id from kristina_client),
  (select id from kristina_enquiry),
  (select id from kristina_project),
  'synthetic-kristina@example.test',
  'Synthetic Kristina draft',
  'Synthetic body',
  'system'
)
returning id;

create temporary table kristina_outbox as
insert into public.integration_outbox (
  kind, dedupe_key, payload, client_id, enquiry_id, project_id, session_id
) values (
  'calendar_create',
  'calendar:create:synthetic-kristina:1',
  '{}'::jsonb,
  (select id from kristina_client),
  (select id from kristina_enquiry),
  (select id from kristina_project),
  (select id from kristina_session)
)
returning id;

select is(
  (select artist_id from public.follow_ups where id = (select id from kristina_follow_up)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'Kristina follow-up inherits Kristina'
);
select is(
  (select artist_id from public.email_messages where id = (select id from kristina_email)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'Kristina email inherits Kristina'
);
select is(
  (select artist_id from public.integration_outbox where id = (select id from kristina_outbox)),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'Kristina outbox job inherits Kristina'
);

insert into public.activity_log (
  event_type, actor_kind, enquiry_id, metadata
) values (
  'enquiry.reviewed', 'system', (select id from kristina_enquiry), '{}'::jsonb
);

select is(
  (select artist_id
   from public.activity_log
   where enquiry_id = (select id from kristina_enquiry)
   order by created_at desc
   limit 1),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a linked activity event derives Kristina scope'
);

-- ---------------------------------------------------------------------------
-- Cross-artist mismatches are rejected before persistence
-- ---------------------------------------------------------------------------

select throws_ok(
  format(
    $$insert into public.projects (client_id, enquiry_id, artist_id, title)
      values (%L, %L, 'a1111111-1111-4111-8111-111111111111', 'Wrong artist')$$,
    (select id from kristina_client),
    (select id from kristina_enquiry)
  ),
  '23514', null,
  'a Vladimir project cannot reference a Kristina enquiry'
);

select throws_ok(
  format(
    $$insert into public.sessions (project_id, artist_id, status, start_at, end_at)
      values (%L, 'a1111111-1111-4111-8111-111111111111', 'proposed', now(), now() + interval '1 hour')$$,
    (select id from kristina_project)
  ),
  '23514', null,
  'a Vladimir session cannot reference a Kristina project'
);

select throws_ok(
  format(
    $$insert into public.follow_ups (subject, due_at, enquiry_id, project_id)
      values ('Mixed artists', now(), %L, %L)$$,
    (select id from kristina_enquiry),
    (select id from legacy_project)
  ),
  '23514', null,
  'one follow-up cannot link entities from different artists'
);

select throws_ok(
  format(
    $$insert into public.email_messages (
        status, enquiry_id, project_id, to_email, subject, body, created_by_kind
      ) values (
        'draft', %L, %L, 'mixed@example.test', 'Mixed artists', 'Synthetic', 'system'
      )$$,
    (select id from kristina_enquiry),
    (select id from legacy_project)
  ),
  '23514', null,
  'one email cannot link entities from different artists'
);

select throws_ok(
  format(
    $$insert into public.integration_outbox (
        kind, dedupe_key, payload, enquiry_id, project_id
      ) values (
        'telegram_notification', 'telegram:mixed:synthetic:1', '{}'::jsonb, %L, %L
      )$$,
    (select id from kristina_enquiry),
    (select id from legacy_project)
  ),
  '23514', null,
  'one outbox job cannot link entities from different artists'
);

select throws_ok(
  format(
    $$insert into public.activity_log (
        event_type, actor_kind, artist_id, enquiry_id, metadata
      ) values (
        'enquiry.reviewed', 'system',
        'a1111111-1111-4111-8111-111111111111', %L, '{}'::jsonb
      )$$,
    (select id from kristina_enquiry)
  ),
  '23514', null,
  'an activity row cannot claim a different artist than its entity'
);

-- ---------------------------------------------------------------------------
-- Artist ownership cannot be rewritten through a generic UPDATE
-- ---------------------------------------------------------------------------

select throws_ok(
  format(
    $$update public.enquiries
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_enquiry)
  ),
  '23514', null,
  'enquiry artist is immutable'
);

select throws_ok(
  format(
    $$update public.projects
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_project)
  ),
  '23514', null,
  'project artist is immutable'
);

select throws_ok(
  format(
    $$update public.sessions
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_session)
  ),
  '23514', null,
  'session artist is immutable'
);

select throws_ok(
  format(
    $$update public.follow_ups
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_follow_up)
  ),
  '23514', null,
  'follow-up artist is immutable'
);

select throws_ok(
  format(
    $$update public.email_messages
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_email)
  ),
  '23514', null,
  'email artist is immutable'
);

select throws_ok(
  format(
    $$update public.integration_outbox
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where id = %L$$,
    (select id from kristina_outbox)
  ),
  '23514', null,
  'outbox artist is immutable'
);

-- The new scope column does not create an audit-history mutation escape hatch.
select throws_ok(
  format(
    $$update public.activity_log
      set artist_id = 'a1111111-1111-4111-8111-111111111111'
      where enquiry_id = %L$$,
    (select id from kristina_enquiry)
  ),
  '42501', null,
  'activity artist context remains append-only'
);

-- ---------------------------------------------------------------------------
-- Required tables contain no unscoped row
-- ---------------------------------------------------------------------------

select ok(not exists (select 1 from public.enquiries where artist_id is null),
          'no enquiry is unscoped');
select ok(not exists (select 1 from public.projects where artist_id is null),
          'no project is unscoped');
select ok(not exists (select 1 from public.sessions where artist_id is null),
          'no session is unscoped');
select ok(not exists (select 1 from public.follow_ups where artist_id is null),
          'no follow-up is unscoped');
select ok(not exists (select 1 from public.email_messages where artist_id is null),
          'no email message is unscoped');
select ok(not exists (select 1 from public.integration_outbox where artist_id is null),
          'no outbox job is unscoped');

select * from finish(true);
rollback;
