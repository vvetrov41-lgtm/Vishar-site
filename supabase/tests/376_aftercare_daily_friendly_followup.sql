-- Once-per-block post-session guide for two consecutive days and two artists.
-- Synthetic entities, email messages and any outbox records are rolled back.
BEGIN;
SELECT no_plan();

INSERT INTO public.clients(id,full_name,email) VALUES
 ('f3761111-1111-4111-8111-111111111111','Vladimir Aftercare','aftercare-v@example.test'),
 ('f3761111-1111-4111-8111-222222222222','Kristina Aftercare','aftercare-k@example.test');
INSERT INTO public.projects(id,client_id,artist_id,title) VALUES
 ('f3762222-2222-4222-8222-111111111111',
  'f3761111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111','Vladimir consecutive aftercare fixture'),
 ('f3762222-2222-4222-8222-222222222222',
  'f3761111-1111-4111-8111-222222222222',
  'a2222222-2222-4222-8222-222222222222','Kristina consecutive aftercare fixture');

INSERT INTO public.sessions (
 id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at
) SELECT v.sid,v.artist_id,v.client_id,v.project_id,
 'tattoo_session','confirmed',date_trunc('day',now())+v.start_offset,
 date_trunc('day',now())+v.start_offset+interval '4 hours'
FROM (VALUES
 ('f3760000-0000-4000-8000-111111111111'::uuid,
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'f3761111-1111-4111-8111-111111111111'::uuid,
  'f3762222-2222-4222-8222-111111111111'::uuid, interval '25 days 11 hours'),
 ('f3760000-0000-4000-8000-111111111112'::uuid,
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'f3761111-1111-4111-8111-111111111111'::uuid,
  'f3762222-2222-4222-8222-111111111111'::uuid, interval '26 days 11 hours'),
 ('f3760000-0000-4000-8000-222222222221'::uuid,
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'f3761111-1111-4111-8111-222222222222'::uuid,
  'f3762222-2222-4222-8222-222222222222'::uuid, interval '25 days 11 hours'),
 ('f3760000-0000-4000-8000-222222222222'::uuid,
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'f3761111-1111-4111-8111-222222222222'::uuid,
  'f3762222-2222-4222-8222-222222222222'::uuid, interval '26 days 11 hours')
) v(sid,artist_id,client_id,project_id,start_offset);

SELECT is(crm_private.enrol_booked_session_in_lifecycle(
 'f3760000-0000-4000-8000-111111111111','aftercare_daily_test'),'enrolled','V first enrolled');
SELECT is(crm_private.enrol_booked_session_in_lifecycle(
 'f3760000-0000-4000-8000-111111111112','aftercare_daily_test'),'enrolled','V second enrolled');
SELECT is(crm_private.enrol_booked_session_in_lifecycle(
 'f3760000-0000-4000-8000-222222222221','aftercare_daily_test'),'enrolled','K first enrolled');
SELECT is(crm_private.enrol_booked_session_in_lifecycle(
 'f3760000-0000-4000-8000-222222222222','aftercare_daily_test'),'enrolled','K second enrolled');

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
SELECT lives_ok('SELECT public.service_run_automation_tick(500)',
 'materialise future client-lifecycle jobs without dispatch');
RESET ROLE;

UPDATE public.sessions SET status='completed'
WHERE id IN (
 'f3760000-0000-4000-8000-111111111111',
 'f3760000-0000-4000-8000-111111111112',
 'f3760000-0000-4000-8000-222222222221',
 'f3760000-0000-4000-8000-222222222222'
);

SELECT is((SELECT count(*)::int FROM public.automation_jobs
 WHERE session_id IN ('f3760000-0000-4000-8000-111111111112',
                      'f3760000-0000-4000-8000-222222222222')
   AND message_purpose='post_session_aftercare' AND status='pending'),
 2,'both later-day aftercare jobs are prepared');

SELECT is((SELECT count(*)::int FROM public.automation_jobs
 WHERE session_id IN ('f3760000-0000-4000-8000-111111111112',
                      'f3760000-0000-4000-8000-222222222222')
   AND message_purpose='post_session_aftercare'
   AND crm_private.lifecycle_block_disposition(id)='eligible'),
 0,'both second-day aftercare repeats are suppressed');

SELECT is((SELECT count(*)::int FROM public.automation_jobs
 WHERE session_id IN ('f3760000-0000-4000-8000-111111111111',
                      'f3760000-0000-4000-8000-222222222221')
   AND message_purpose='post_session_checkin'
   AND crm_private.lifecycle_block_disposition(id)='defer'),
 2,'first-day check-ins remain suppressed');

SELECT is((SELECT count(*)::int FROM public.automation_jobs
 WHERE session_id IN ('f3760000-0000-4000-8000-111111111112',
                      'f3760000-0000-4000-8000-222222222222')
   AND message_purpose='post_session_checkin'
   AND crm_private.lifecycle_block_disposition(id)='eligible'),
 2,'last-day check-ins remain eligible');

-- Simulate a normal system email INSERT with its authoritative aftercare job
-- and reviewed artist-specific template. All provider calls are absent.
INSERT INTO public.email_messages(
 status,artist_id,client_id,project_id,to_email,subject,body,
 template_key,template_version,created_by_kind,approved_at,automation_job_id
)
SELECT 'approved',j.artist_id,s.client_id,s.project_id,c.email,
 t.subject,t.body,t.purpose,t.version,'system',now(),j.id
FROM public.automation_jobs j
JOIN public.sessions s ON s.id=j.session_id
JOIN public.clients c ON c.id=s.client_id
JOIN LATERAL (
 SELECT mt.* FROM public.message_templates mt
 JOIN public.artists a ON a.id=j.artist_id
 WHERE mt.workspace_id=a.workspace_id AND
   (mt.artist_id=j.artist_id OR mt.artist_id IS NULL)
   AND mt.purpose='post_session_aftercare' AND mt.channel='email'
   AND mt.locale='en' AND mt.status='active'
 ORDER BY (mt.artist_id IS NOT NULL) DESC,mt.version DESC,mt.id LIMIT 1
) t ON true
WHERE j.session_id IN (
 'f3760000-0000-4000-8000-111111111111',
 'f3760000-0000-4000-8000-222222222221')
AND j.message_purpose='post_session_aftercare'
AND crm_private.lifecycle_notification_required(j.id);

SELECT is((SELECT count(*)::int FROM public.email_messages
 WHERE client_id IN ('f3761111-1111-4111-8111-111111111111',
                     'f3761111-1111-4111-8111-222222222222')
   AND template_key='post_session_aftercare'),2,
 'only first-day guides are materialised, no provider send');

SELECT is((SELECT count(*)::int FROM public.email_messages m
 JOIN public.automation_jobs j ON j.id=m.automation_job_id
 WHERE j.session_id IN ('f3760000-0000-4000-8000-111111111111',
                        'f3760000-0000-4000-8000-222222222221')
   AND m.html_body LIKE '%Thank you for today.%'),2,
 'first-day emails keep original complete guide CTA');

SELECT is((SELECT count(*)::int FROM public.email_messages m
 JOIN public.automation_jobs j ON j.id=m.automation_job_id
 WHERE j.session_id IN ('f3760000-0000-4000-8000-111111111112',
                        'f3760000-0000-4000-8000-222222222222')
   AND j.message_purpose='post_session_aftercare'),0,
 'no second-day guide or follow-up email is materialised');

SELECT ok((SELECT m.body LIKE '%https://vishartattoo.com/aftercare/%'
   AND m.body NOT LIKE '%kristinavishar.com%'
 FROM public.email_messages m JOIN public.automation_jobs j
 ON j.id=m.automation_job_id
 WHERE j.session_id='f3760000-0000-4000-8000-111111111111'),
 'Vladimir first-day guide includes only his link');

SELECT ok((SELECT m.body LIKE '%https://www.kristinavishar.com/aftercare/%'
   AND m.body NOT LIKE '%vishartattoo.com/aftercare/%'
 FROM public.email_messages m JOIN public.automation_jobs j
 ON j.id=m.automation_job_id
 WHERE j.session_id='f3760000-0000-4000-8000-222222222221'),
 'Kristina first-day guide includes only her link');

-- Backend JWT is simulated above; the private helper itself is not
-- grantable to service_role and is invoked under its SECURITY DEFINER owner.
SELECT is((SELECT crm_private.queue_lifecycle_whatsapp_job(id)
 FROM public.automation_jobs WHERE session_id='f3760000-0000-4000-8000-111111111112'
 AND message_purpose='post_session_aftercare'),
 'unavailable','Meta-approved first-day WhatsApp template is never reused on a suppressed day');

-- Historical blocked pending jobs must not back-send after this migration.
UPDATE public.automation_jobs SET scheduled_at=now()-interval '8 hours'
WHERE session_id='f3760000-0000-4000-8000-111111111112'
 AND message_purpose='post_session_aftercare';
SELECT is((SELECT crm_private.lifecycle_block_disposition(id)
 FROM public.automation_jobs WHERE session_id='f3760000-0000-4000-8000-111111111112'
 AND message_purpose='post_session_aftercare'),'defer',
 'historical overdue aftercare reminders do not get unexpectedly sent');

SELECT ok(
 NOT has_function_privilege('authenticated',
   'crm_private.lifecycle_aftercare_followup(uuid)','execute')
 AND NOT has_function_privilege('anon',
   'crm_private.lifecycle_aftercare_followup(uuid)','execute'),
 'day detection stays private');
SELECT * FROM finish();
ROLLBACK;
