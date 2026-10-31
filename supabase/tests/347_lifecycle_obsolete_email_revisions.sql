-- Real SQL provider acknowledgement path, synthetic rollback-only clients.
-- No external requests; only a definite pre-send obsolete status may reissue.
begin;
select no_plan();

create temporary table rev_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id=a.id and st.is_active
where a.slug='vladimir';
grant select on rev_artist to public;
insert into public.clients(id,full_name,email) values
 ('f9601111-1111-4111-8111-111111111111','Revision test','revision@example.test');
insert into public.projects(id,client_id,artist_id,title) values
 ('f9602222-2222-4222-8222-222222222222',
  'f9601111-1111-4111-8111-111111111111',(select id from rev_artist),'Revision test');
insert into public.sessions(
 id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
values (
 'f9603333-3333-4333-8333-333333333333',(select id from rev_artist),
 'f9601111-1111-4111-8111-111111111111',
 'f9602222-2222-4222-8222-222222222222',
 'tattoo_session','confirmed',date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days',
 date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '30 days 4 hours'
);
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9603333-3333-4333-8333-333333333333','revision_test'),'enrolled',
 'session enrolled once');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select public.service_set_gmail_integration(
 (select id from rev_artist),'google_gmail_revision_test','revision-studio@example.test',
 array['https://www.googleapis.com/auth/gmail.readonly',
       'https://www.googleapis.com/auth/gmail.send']::text[])$$,
 'synthetic artist has Gmail route');
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'initial rule/event jobs are materialized');
reset role;
select is((select lifecycle_revision from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h'),1,'initial revision is one');

-- Make initial 72h reminder due, then prove that it was only QUEUED.
update public.sessions set start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '48 hours',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '52 hours'
where id='f9603333-3333-4333-8333-333333333333';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'first revision is enqueued');
reset role;
create temporary table revision_old_outbox as
select c.outbox_id from public.claim_email_outbox('revision-worker',20,120) c
join public.email_messages m on m.id=c.email_message_id
join public.automation_jobs j on j.id=m.automation_job_id
where j.session_id='f9603333-3333-4333-8333-333333333333'
 and j.message_purpose='session_reminder_72h';
grant select on revision_old_outbox to public;
select is((select count(*)::integer from revision_old_outbox),1,
 'one original Gmail outbox lease exists');
reset role;

-- Moving the appointment invalidates the leased snapshot before any provider send.
update public.sessions set start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '40 days',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '40 days 4 hours'
where id='f9603333-3333-4333-8333-333333333333';
set local role service_role;
select ok((select not delivery_allowed
 from public.service_resolve_gmail_outbox_target(
  (select outbox_id from revision_old_outbox),'revision-worker')),
 'the Gmail provider revalidates and refuses the old snapshot');
select is((public.record_email_outbox_result(
 (select outbox_id from revision_old_outbox),'revision-worker',false,null,
 'gmail_lifecycle_email_obsolete')->>'status'),'dead',
 'pre-send cancellation is terminal');
reset role;
select is((select count(*)::integer from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h'),2,
 'one new revision is created after terminal pre-send obsolete result');
select is((select status::text from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h' and lifecycle_revision=2),
 'pending','replacement is pending until its new due time');
select is((select m.status::text from public.email_messages m
 join public.automation_jobs j on j.id=m.automation_job_id
 where j.session_id='f9603333-3333-4333-8333-333333333333'
 and j.message_purpose='session_reminder_72h' and j.lifecycle_revision=1),
 'cancelled','old email remains as a cancelled audit record');
select is((select scheduled_at from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h' and lifecycle_revision=2),
 (select start_at-interval '72 hours' from public.sessions
  where id='f9603333-3333-4333-8333-333333333333'),
 'new revision follows the revised date');

set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'a repeated tick cannot duplicate the replacement');
reset role;
select is((select count(*)::integer from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h'),2,
 'repeated scheduler tick remains idempotent');

-- Bring the new 72h reminder due. It uses a distinct email/outbox identity.
update public.sessions set start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '72 hours',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '76 hours'
where id='f9603333-3333-4333-8333-333333333333';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'replacement revision can enqueue at its actual due time');
reset role;
select is((select count(*)::integer from public.email_messages m
 join public.automation_jobs j on j.id=m.automation_job_id
 where j.session_id='f9603333-3333-4333-8333-333333333333'
 and j.message_purpose='session_reminder_72h'
 and j.lifecycle_revision=2),1,'new revision owns one distinct email');
select is((select status::text from public.integration_outbox
 where id=(select outbox_id from revision_old_outbox)),'dead',
 'old outbox stays terminal');

-- A provider-accepted replacement cannot be regenerated after another move.
reset role;
create temporary table revision_new_outbox as
select c.outbox_id from public.claim_email_outbox('revision-worker-2',20,120) c
join public.email_messages m on m.id=c.email_message_id
join public.automation_jobs j on j.id=m.automation_job_id
where j.session_id='f9603333-3333-4333-8333-333333333333'
 and j.message_purpose='session_reminder_72h'
 and j.lifecycle_revision=2;
grant select on revision_new_outbox to public;
select is((public.record_email_outbox_result(
 (select outbox_id from revision_new_outbox),'revision-worker-2',true,
 'SYNTHETIC_ACCEPTED_001',null)->>'status'),'succeeded',
 'replacement delivery is acknowledged');
reset role;
update public.sessions set start_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '50 days',
 end_at=date_bin('5 minutes',now(),'2000-01-01'::timestamptz)+interval '50 days 4 hours'
where id='f9603333-3333-4333-8333-333333333333';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'moving a provider-accepted reminder preserves its prior send');
reset role;
select is((select count(*)::integer from public.automation_jobs
 where session_id='f9603333-3333-4333-8333-333333333333'
 and message_purpose='session_reminder_72h'),2,
 'provider acceptance never creates a third revision');

select * from finish();
rollback;
