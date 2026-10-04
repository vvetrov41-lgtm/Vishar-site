-- 1002_operational_failure_alerts.sql
--
-- Dead client-facing deliveries become one actionable alert per job and
-- recipient (2026-10-04 rework of audit H-5). Deliberate outcomes, deliveries
-- that recovered before the sweep, Telegram's own jobs and AI jobs never alert.

begin;
select no_plan();

select has_function('public', 'service_sweep_operational_failure_alerts', array['integer'],
  'operational failure alert sweep exists');
select ok(not has_function_privilege('anon', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'anonymous callers cannot run the alert sweep');
select ok(not has_function_privilege('authenticated', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'browser sessions cannot run the alert sweep');
select ok(has_function_privilege('service_role', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'the scheduler service role can run the alert sweep');

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select public.service_sweep_operational_failure_alerts(10)$$,
  '42501', 'operational failure alerts are backend-only', 'the sweep refuses a non-service JWT');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select public.service_sweep_operational_failure_alerts(0)$$,
  '22023', 'alert limit must be between 1 and 100', 'the sweep limit fails closed');

-- Fixtures: one confirmed future appointment with a Calendar integration.
insert into auth.users (id, email) values
  ('e2011111-1111-4111-8111-111111111111', 'alerts-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e2011111-1111-4111-8111-111111111111', 'alerts-owner@example.test',
   'Alerts Owner', 'owner', true);
update public.artist_memberships
set access_level = 'owner', can_view_finance = true, can_manage_finance = true,
    can_manage_sessions = true, can_manage_integrations = true, is_active = true
where profile_id = 'e2011111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'e2021111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'calendar', 'google', 'google_calendar_vladimir',
  'vvetrov41@gmail.com',
  '{"calendar_id":"primary","oauth_scope":"calendar.events","connection_mode":"worker_oauth"}'::jsonb,
  true
);

insert into public.clients (id, full_name, email) values
  ('e2031111-1111-4111-8111-111111111111', 'Synthetic Alerts Client', 'alerts-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e2041111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e2051111-1111-4111-8111-111111111111', repeat('f', 64),
  'accepted', 'complete', 'Synthetic Alerts Client',
  'alerts-client@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'e2061111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'e2041111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Alerts project', 'active', 'GBP'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"e2011111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table t_appt as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2027-03-16T09:00:00Z',
  '2027-03-16T16:00:00Z',
  'confirmed',
  'e2041111-1111-4111-8111-111111111111',
  'e2061111-1111-4111-8111-111111111111',
  'Synthetic alerts test'
) ->> 'appointment_id')::uuid as id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);


create temporary table t_job as
select o.id from public.integration_outbox o
where o.session_id = (select id from t_appt) and o.kind = 'calendar_create';

-- A deliberate cancellation is not a failure.
update public.integration_outbox
set status = 'dead', attempt_count = 1, last_error_code = 'operator_cancelled', updated_at = now()
where id = (select id from t_job);
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'an operator-cancelled job raises no alert');

update public.integration_outbox
set last_error_code = 'database_unavailable', attempt_count = 8, updated_at = now()
where id = (select id from t_job);

select is(public.service_sweep_operational_failure_alerts(100), 1,
  'a calendar job that stopped retrying raises one alert');
select ok(
  exists (
    select 1 from public.notifications n
    where n.artist_id = 'a1111111-1111-4111-8111-111111111111'
      and n.notification_type = 'system.integration_delivery_failed'
      and n.dedupe_key = 'delivery_failed:' || (select id from t_job)::text
                         || ':e2011111-1111-4111-8111-111111111111'
      and n.title = 'Appointment not synced to Google Calendar: Synthetic Alerts Client'
      and n.entity_type = 'client'
      and n.entity_id = 'e2031111-1111-4111-8111-111111111111'
      and n.body like '%Client: Synthetic Alerts Client%'
      and n.body like '%Attempts: 8, last at %'
      and n.body like '%The CRM will not retry it again.%'
      and n.body like '%Code: database_unavailable%'
      and n.body !~* 'alerts-client@'
  ),
  'the alert names the client, the attempts, the retry state and the code, links to the client and carries no contact details'
);
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'the same failure never alerts the same recipient twice');

-- The next UTC day inside the 24-hour window still does not repeat it.
update public.notifications set created_at = now() - interval '20 hours'
where dedupe_key like 'delivery_failed:%';
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'a failure is not re-announced when the calendar day changes');

-- Failed AI jobs are not the artist's problem to solve and never alert.
insert into public.crm_agent_jobs (artist_id, workspace_id, client_id, job_type, source_event_id, status, snapshot_hash, error_code)
select a.id, a.workspace_id, 'e2031111-1111-4111-8111-111111111111',
       'refresh_client_ai_state', 'alerts-ai-failure', 'failed', repeat('a', 64), 'ai_unavailable'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'a failed AI job raises no alert');
select is(
  (select count(*)::int from public.notifications where notification_type = 'system.ai_processing_failed'
     and artist_id = 'a1111111-1111-4111-8111-111111111111' and created_at > now() - interval '1 minute'),
  0, 'the sweep creates no AI-processing alerts');

-- ---------------------------------------------------------------------------
-- Approved email: the regression path and an actionable alert
-- ---------------------------------------------------------------------------

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key, external_account_label, configuration, is_enabled
) values (
  'a1111111-1111-4111-8111-111111111111', 'email', 'google', 'gmail_alerts_test',
  'studio@example.test', '{}'::jsonb, true
) on conflict do nothing;

select set_config('request.jwt.claims',
  '{"sub":"e2011111-1111-4111-8111-111111111111","role":"authenticated"}', true);
create temporary table t_email as
select public.create_email_draft('alerts-client@example.test', 'Your enquiry', 'Body text',
  'e2031111-1111-4111-8111-111111111111', 'e2041111-1111-4111-8111-111111111111') as id;
select public.approve_email_draft((select id from t_email));
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select o.enquiry_id = 'e2041111-1111-4111-8111-111111111111'::uuid
   from public.integration_outbox o where o.email_message_id = (select id from t_email)),
  'the approved email is queued with its enquiry, so the Gmail resolver can accept it');

-- A record the CRM cannot send dies on the first attempt, not the eighth.
update public.integration_outbox
set status = 'leased', leased_by = 'gmail-alerts-test', leased_at = now(),
    lease_expires_at = now() + interval '2 minutes'
where email_message_id = (select id from t_email);
select is(
  public.record_email_outbox_result(
    (select id from public.integration_outbox where email_message_id = (select id from t_email)),
    'gmail-alerts-test', false, null, 'gmail_email_job_invalid') ->> 'status',
  'dead', 'an invalid email job stops retrying immediately');
select is((select status::text from public.email_messages where id = (select id from t_email)), 'failed',
  'the email itself is marked failed');

select is(public.service_sweep_operational_failure_alerts(100), 1, 'the unsent email raises one alert');
select ok(
  exists (
    select 1 from public.notifications n
    where n.dedupe_key like 'delivery_failed:%'
      and n.title = 'Email to client not sent: Synthetic Alerts Client'
      and n.body like '%Attempts: 1, last at %'
      and n.body like '%The client received nothing.%'
      and n.body like '%Code: gmail_email_job_invalid%'),
  'the email alert says the client received nothing and what to do');

-- A delivery that was sent or withdrawn before the sweep does not alert.
create temporary table t_email2 as
select gen_random_uuid() as id;
insert into public.email_messages (id, artist_id, client_id, enquiry_id, status, to_email, subject, body, created_by_kind, sent_at, provider_message_id, approved_by, approved_at)
values ((select id from t_email2), 'a1111111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111', 'e2041111-1111-4111-8111-111111111111',
  'sent', 'alerts-client@example.test', 'Sent later', 'Body', 'human', now(), 'gmail-provider-id',
  'e2011111-1111-4111-8111-111111111111', now());
insert into public.integration_outbox (kind, dedupe_key, status, client_id, enquiry_id, email_message_id, attempt_count, last_error_code)
values ('approved_email', 'email:approved:' || (select id from t_email2), 'dead',
  'e2031111-1111-4111-8111-111111111111', 'e2041111-1111-4111-8111-111111111111',
  (select id from t_email2), 8, 'gmail_rpc_failed');
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'an email that was eventually sent raises no alert');

-- Telegram's own failures cannot be reported through Telegram.
update public.integration_outbox set status = 'dead', last_error_code = 'telegram_unavailable', attempt_count = 8, updated_at = now()
where kind = 'telegram_notification' and artist_id = 'a1111111-1111-4111-8111-111111111111';
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'dead Telegram deliveries do not alert through Telegram');

-- A Russian reader gets the alert in Russian.
update public.profiles set ui_language = 'ru' where id = 'e2011111-1111-4111-8111-111111111111';
delete from public.notifications where dedupe_key like 'delivery_failed:%';
select is(public.service_sweep_operational_failure_alerts(100), 2, 'both failures alert again after the rows are removed');
select ok(
  exists (select 1 from public.notifications n where n.dedupe_key like 'delivery_failed:%'
    and n.title = 'Письмо клиенту не отправлено: Synthetic Alerts Client'
    and n.body like '%CRM больше не будет повторять попытки.%'
    and n.body like '%Клиент ничего не получил.%'),
  'the alert follows the recipient''s CRM language');

select * from finish(true);
rollback;
