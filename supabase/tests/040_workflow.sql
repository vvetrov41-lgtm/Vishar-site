-- 040_workflow.sql
--
-- Status transitions, assignment, enquiry-to-project conversion, session
-- scheduling and calendar dedupe, email drafts and approval, deposits.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'Owner', 'owner', true),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test', 'Manager', 'booking_manager', true),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test', 'Reader', 'read_only', true);

create function pg_temp.act_as(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;

create function pg_temp.act_as_worker() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;

create temporary table t_enq as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Workflow Client', 'email', 'workflow@example.test'),
  jsonb_build_object(
    'idea', 'A raven',
    'source', '/booking/',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  jsonb_build_array(jsonb_build_object('mime_type', 'image/png', 'safe_extension', 'png', 'byte_size', 4096))
) as r;

select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f;
select public.finalize_enquiry_intake((select r ->> 'enquiry_id' from t_enq)::uuid);

create temporary table ids as
select (r ->> 'enquiry_id')::uuid as enquiry_id, (r ->> 'client_id')::uuid as client_id from t_enq;

-- ---------------------------------------------------------------------------
-- Status transitions
-- ---------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select lives_ok(
  format($$select public.transition_enquiry_status(%L, 'reviewing')$$, (select enquiry_id from ids)),
  'a booking manager may move a new enquiry to reviewing'
);

select is(
  (select status::text from public.enquiries where id = (select enquiry_id from ids)),
  'reviewing', 'the status change is persisted'
);

select is(
  (select count(*)::int from public.activity_log
   where event_type = 'enquiry.status_changed' and enquiry_id = (select enquiry_id from ids)),
  1, 'the transition writes exactly one activity row'
);

-- new -> deposit_paid is not in the transition table.
select throws_ok(
  format($$select public.transition_enquiry_status(%L, 'deposit_paid')$$, (select enquiry_id from ids)),
  '42501', null,
  'a transition that is not in the allow-list is refused'
);

select lives_ok(
  format($$select public.transition_enquiry_status(%L, 'declined')$$, (select enquiry_id from ids)),
  'reviewing -> declined is allowed for a manager'
);

-- Reopening a declined enquiry is owner-only.
select throws_ok(
  format($$select public.transition_enquiry_status(%L, 'reviewing')$$, (select enquiry_id from ids)),
  '42501', null,
  'a booking manager may not reopen a declined enquiry'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  format($$select public.transition_enquiry_status(%L, 'reviewing')$$, (select enquiry_id from ids)),
  'the owner may reopen a declined enquiry'
);

select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select throws_ok(
  format($$select public.transition_enquiry_status(%L, 'accepted')$$, (select enquiry_id from ids)),
  '42501', null,
  'a read_only user may not change a status'
);

-- ---------------------------------------------------------------------------
-- Assignment
-- ---------------------------------------------------------------------------

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

select lives_ok(
  format($$select public.assign_enquiry(%L, '22222222-2222-4222-8222-222222222222')$$,
         (select enquiry_id from ids)),
  'an enquiry may be assigned to a booking manager'
);

select is(
  (select assigned_to from public.enquiries where id = (select enquiry_id from ids)),
  '22222222-2222-4222-8222-222222222222'::uuid,
  'the assignment is persisted'
);

select throws_ok(
  format($$select public.assign_enquiry(%L, '33333333-3333-4333-8333-333333333333')$$,
         (select enquiry_id from ids)),
  '22023', null,
  'an enquiry cannot be assigned to a read_only user'
);

-- ---------------------------------------------------------------------------
-- Conversion: one enquiry, one project
-- ---------------------------------------------------------------------------

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select throws_ok(
  format($$select public.convert_enquiry_to_project(%L, 'Too early')$$, (select enquiry_id from ids)),
  '42501', null,
  'an enquiry cannot bypass the status allow-list during conversion'
);
select public.transition_enquiry_status((select enquiry_id from ids), 'accepted');

create temporary table proj as
select (public.convert_enquiry_to_project((select enquiry_id from ids), 'Raven sleeve') ->> 'project_id')::uuid as project_id;

select is((select count(*)::int from public.projects), 1, 'conversion creates exactly one project');
select is(
  (select status::text from public.enquiries where id = (select enquiry_id from ids)),
  'converted', 'the enquiry is marked converted'
);

select throws_ok(
  format($$select public.convert_enquiry_to_project(%L, 'Second attempt')$$, (select enquiry_id from ids)),
  '23505', null,
  'the same enquiry cannot be converted twice'
);

select throws_ok(
  format($$insert into public.projects (client_id, enquiry_id, title)
           values (%L, %L, 'Direct duplicate')$$,
         (select client_id from ids), (select enquiry_id from ids)),
  '23505', null,
  'a second project for the same enquiry is refused by the unique index too'
);

-- ---------------------------------------------------------------------------
-- Sessions and calendar dedupe
-- ---------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

create temporary table s_draft as
select (public.schedule_session((select project_id from proj),
        now() + interval '10 days', now() + interval '10 days 6 hours', 'draft') ->> 'session_id')::uuid as id;

-- The outbox is owner-visible infrastructure, so counts are read as the owner.
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from public.integration_outbox where kind::text like 'calendar%'), 0,
          'scheduling a DRAFT session creates no calendar job');
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

create temporary table s_prop as
select (public.schedule_session((select project_id from proj),
        now() + interval '20 days', now() + interval '20 days 6 hours', 'proposed') ->> 'session_id')::uuid as id;

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from public.integration_outbox where kind::text like 'calendar%'), 0,
          'scheduling a PROPOSED session creates no calendar job');
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

create temporary table s_conf as
select (public.schedule_session((select project_id from proj),
        now() + interval '30 days', now() + interval '30 days 6 hours', 'confirmed') ->> 'session_id')::uuid as id;

-- A booking manager can cause an outbox job but cannot read the queue.
select is((select count(*)::int from public.integration_outbox), 0,
          'a booking manager reads no rows from the integration outbox');

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from public.integration_outbox where kind = 'calendar_create'), 1,
          'scheduling a CONFIRMED session creates exactly one calendar_create job');

select is(
  (select dedupe_key from public.integration_outbox where kind = 'calendar_create'),
  'calendar:create:' || (select id from s_conf) || ':0',
  'the calendar job uses the documented dedupe key shape'
);

-- Re-enqueueing the identical logical job must collide, not duplicate.
select lives_ok(
  format($$insert into public.integration_outbox (kind, dedupe_key, payload, session_id)
           values ('calendar_create', %L, '{}'::jsonb, %L)
           on conflict (dedupe_key) do nothing$$,
         'calendar:create:' || (select id from s_conf) || ':0', (select id from s_conf)),
  'a repeated calendar enqueue is absorbed by the dedupe key'
);
select is((select count(*)::int from public.integration_outbox where kind = 'calendar_create'), 1,
          'the repeated enqueue created no duplicate calendar job');

select throws_ok(
  format($$insert into public.integration_outbox (kind, dedupe_key, payload, session_id)
           values ('calendar_create', %L, '{}'::jsonb, %L)$$,
         'calendar:create:' || (select id from s_conf) || ':0', (select id from s_conf)),
  '23505', null,
  'without ON CONFLICT the duplicate dedupe key is rejected outright'
);

-- Promoting a draft to confirmed enqueues a create; cancelling without an event
-- id enqueues nothing, because there is nothing to cancel at the provider.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
create temporary table confirmed_result as
select public.set_session_status((select id from s_draft), 'confirmed') as result;
select ok((select (result ->> 'changed')::boolean from confirmed_result),
          'a real session transition reports that it changed state');
select throws_ok(
  format($$select public.set_session_status(%L, 'proposed')$$, (select id from s_draft)),
  '42501', null,
  'a confirmed session cannot be moved backwards to proposed'
);
create temporary table unchanged_result as
select public.set_session_status((select id from s_draft), 'confirmed') as result;
select ok((select not (result ->> 'changed')::boolean from unchanged_result),
          'repeating the current session status is an idempotent no-op');
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from public.integration_outbox where kind = 'calendar_create'), 2,
          'confirming a draft session enqueues exactly one calendar create');

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select public.set_session_status((select id from s_prop), 'cancelled');
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from public.integration_outbox where kind = 'calendar_cancel'), 0,
          'cancelling a session that never reached the provider enqueues no cancel job');

-- ---------------------------------------------------------------------------
-- Email drafts and approval
-- ---------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

create temporary table draft as
select public.create_email_draft('workflow@example.test', 'Your estimate', 'Body text',
        (select client_id from ids), (select enquiry_id from ids)) as id;

select is((select status::text from public.email_messages where id = (select id from draft)), 'draft',
          'a manager creates a draft');

-- AI content can only ever be a draft.
create temporary table ai_draft as
select public.create_email_draft('workflow@example.test', 'AI suggestion', 'Body',
        (select client_id from ids), null, null, 'ai') as id;

select is((select status::text from public.email_messages where id = (select id from ai_draft)), 'draft',
          'AI-created content is created as a draft');
select is((select created_by_kind from public.email_messages where id = (select id from ai_draft)), 'ai',
          'the AI origin is recorded');

select pg_temp.act_as_worker();
select throws_ok(
  $$insert into public.email_messages (status, to_email, subject, body, created_by_kind,
                                       approved_by, approved_at)
    values ('approved', 'x@example.test', 'Forged', 'Body', 'ai',
            '11111111-1111-4111-8111-111111111111', now())$$,
  '42501', null,
  'an AI-originated message cannot be inserted in an approved state'
);

-- Approval is owner-only.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  format($$select public.approve_email_draft(%L)$$, (select id from draft)),
  '42501', null,
  'a booking manager cannot approve an email'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select throws_ok(
  format($$select public.update_project_deposit(%L, 0, 'requested')$$, (select project_id from proj)),
  '22023', null,
  'a requested deposit cannot silently use a zero amount'
);
select lives_ok(
  format($$select public.approve_email_draft(%L)$$, (select id from draft)),
  'the owner can approve a draft'
);
select is((select status::text from public.email_messages where id = (select id from draft)), 'approved',
          'the approved draft is marked approved');
select is((select count(*)::int from public.integration_outbox where kind = 'approved_email'), 1,
          'approval enqueues the send as an outbox job rather than sending inline');
select ok(
  (select approved_by = '11111111-1111-4111-8111-111111111111'::uuid
   from public.email_messages where id = (select id from draft)),
  'the approver is recorded'
);

select throws_ok(
  format($$select public.approve_email_draft(%L)$$, (select id from draft)),
  '22023', null,
  'an already-approved message cannot be approved again'
);

-- ---------------------------------------------------------------------------
-- Deposits and estimates are owner-only
-- ---------------------------------------------------------------------------

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  format($$select public.update_project_deposit(%L, 150.00, 'requested')$$, (select project_id from proj)),
  '42501', null,
  'a booking manager cannot set a deposit amount'
);
select throws_ok(
  format($$select public.update_project_estimate(%L, 140.00)$$, (select project_id from proj)),
  '42501', null,
  'a booking manager cannot set an hourly rate'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  format($$select public.update_project_deposit(%L, 150.00, 'requested')$$, (select project_id from proj)),
  'the owner can set a deposit'
);
select is((select deposit_status::text from public.projects where id = (select project_id from proj)),
          'requested', 'the deposit status is persisted');

-- The audit trail records the state change, not the amount.
select ok(
  (select not (metadata ? 'amount') and not (metadata ? 'deposit_amount')
   from public.activity_log where event_type = 'project.deposit_updated'),
  'the deposit activity records the state change without copying the amount'
);

-- ---------------------------------------------------------------------------
-- Notes and follow-ups
-- ---------------------------------------------------------------------------

select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select throws_ok(
  format($$select public.create_internal_note('Reader note', %L)$$, (select client_id from ids)),
  '42501', null,
  'a read_only user cannot write an internal note'
);
select throws_ok(
  format($$select public.create_follow_up('Chase', now() + interval '2 days', %L)$$, (select client_id from ids)),
  '42501', null,
  'a read_only user cannot create a follow-up'
);

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  format($$select public.create_internal_note('Manager note', %L)$$, (select client_id from ids)),
  'a booking manager can write an internal note'
);

create temporary table fu as
select public.create_follow_up('Chase references', now() + interval '2 days',
        (select client_id from ids), (select enquiry_id from ids)) as id;

select is((select status::text from public.follow_ups where id = (select id from fu)), 'open',
          'a new follow-up is open');
select lives_ok(
  format($$select public.complete_follow_up(%L)$$, (select id from fu)),
  'a follow-up can be completed'
);
select is((select status::text from public.follow_ups where id = (select id from fu)), 'done',
          'the completed follow-up is done');
select is(
  (select count(*)::int from public.activity_log
   where event_type in ('note.created', 'follow_up.created', 'follow_up.completed')),
  3,
  'notes and follow-up state changes are represented in the activity trail'
);
select throws_ok(
  format(
    $$select public.create_follow_up('Wrong assignee', now() + interval '2 days', %L, null, null, %L)$$,
    (select client_id from ids),
    '33333333-3333-4333-8333-333333333333'
  ),
  '22023', null,
  'a follow-up cannot be assigned to a read_only profile'
);
select throws_ok(
  format($$select public.complete_follow_up(%L)$$, (select id from fu)),
  '22023', null,
  'a follow-up cannot be completed twice'
);

-- ---------------------------------------------------------------------------
-- Manual activity is restricted to an allow-list
-- ---------------------------------------------------------------------------

select lives_ok(
  format($$select public.record_activity('client.contacted', %L)$$, (select client_id from ids)),
  'an allow-listed manual activity type is accepted'
);
select throws_ok(
  format(
    $$select public.record_activity('client.contacted', %L, null, null, null,
                                    '{"detail":"client@example.test"}'::jsonb)$$,
    (select client_id from ids)
  ),
  '22023', null,
  'manual activity cannot hide personal data under an arbitrary metadata key'
);
insert into public.clients (id, full_name, email)
values ('cccccccc-0000-4000-8000-000000000099', 'Other Client', 'other-workflow@example.test');
select throws_ok(
  format(
    $$select public.record_activity('client.contacted', %L, %L)$$,
    'cccccccc-0000-4000-8000-000000000099',
    (select enquiry_id from ids)
  ),
  '23514', null,
  'manual activity cannot forge inconsistent client and enquiry links'
);
select throws_ok(
  format($$select public.record_activity('enquiry.created', %L)$$, (select client_id from ids)),
  '42501', null,
  'a system event type cannot be forged by a staff member'
);

select * from finish(true);
rollback;
