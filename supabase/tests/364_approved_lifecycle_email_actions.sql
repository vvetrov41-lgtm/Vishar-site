-- Accepted 72-hour / 24-hour / consultation reminder Email contracts.
-- Synthetic sessions exist only inside this rolled-back pgTAP transaction.
BEGIN;
SELECT no_plan();
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);

INSERT INTO public.clients(id,full_name,email) VALUES (
  'ff201111-1111-4111-8111-111111111111',
  'Reminder Actions Client',
  'reminder-actions@example.test'
);

INSERT INTO public.sessions(
  id,client_id,artist_id,appointment_type,status,
  start_at,end_at,duration_hours,currency
) VALUES
('ff202222-2222-4222-8222-222222222222',
 'ff201111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 'tattoo_session','confirmed',
 date_trunc('hour',now())+interval '36 days',
 date_trunc('hour',now())+interval '36 days 7 hours',7,'GBP'),
('ff203333-3333-4333-8333-333333333333',
 'ff201111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 'in_person_consultation','confirmed',
 date_trunc('hour',now())+interval '37 days',
 date_trunc('hour',now())+interval '37 days 30 minutes',0.5,'GBP'),
('ff204444-4444-4444-8444-444444444444',
 'ff201111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 'video_consultation','confirmed',
 date_trunc('hour',now())+interval '38 days',
 date_trunc('hour',now())+interval '38 days 30 minutes',0.5,'GBP');

CREATE TEMP TABLE action_links AS
SELECT
  'https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64) AS confirm,
  'https://booking.vishartattoo.com/appointments/respond/'||repeat('b',64) AS reschedule,
  'https://booking.vishartattoo.com/appointments/respond/'||repeat('c',64) AS cancel;

WITH payload AS (
 SELECT crm_private.render_approved_lifecycle_email_html(
   'ff202222-2222-4222-8222-222222222222',
   'session_reminder_72h',
   'Confirm attendance: '||confirm||E'\nNeed another time: '||reschedule
 ) AS html FROM action_links
)
SELECT ok(html LIKE '%Confirm attendance%'
  AND html LIKE '%Need another time%'
  AND html LIKE '%Preparation guide%'
  AND html NOT LIKE '%Cancel appointment%'
  AND html NOT LIKE '%I&#39;ll be there%', '72h Email has exactly the approved two actions') FROM payload;

WITH payload AS (
 SELECT crm_private.render_approved_lifecycle_email_html(
   'ff202222-2222-4222-8222-222222222222',
   'session_reminder_24h',
   'Need another time: '||reschedule
 ) AS html FROM action_links
)
SELECT ok(html LIKE '%Need another time%'
  AND html LIKE '%arrival instructions%'
  AND html NOT LIKE '%Confirm attendance%'
  AND html NOT LIKE '%Cancel appointment%', '24h Email has only reschedule control') FROM payload;

WITH payload AS (
 SELECT crm_private.render_approved_lifecycle_email_html(
   'ff203333-3333-4333-8333-333333333333',
   'consultation_reminder',
   'Confirm consultation: '||confirm||E'\nNeed another time: '||reschedule
 ) AS html FROM action_links
)
SELECT ok(html LIKE '%Confirm consultation%'
  AND html LIKE '%Need another time%'
  AND html LIKE '%16 Exhibition House%'
  AND html LIKE '%Get directions%'
  AND html NOT LIKE '%York House%'
  AND html NOT LIKE '%Cancel appointment%', 'in-person consultation reminder has correct studio and only two actions') FROM payload;

WITH payload AS (
 SELECT crm_private.render_approved_lifecycle_email_html(
   'ff204444-4444-4444-8444-444444444444',
   'consultation_reminder',
   'Confirm consultation: '||confirm||E'\nNeed another time: '||reschedule
 ) AS html FROM action_links
)
SELECT ok(html LIKE '%video call you on WhatsApp%'
  AND html NOT LIKE '%16 Exhibition House%'
  AND html NOT LIKE '%Get directions%'
  AND html LIKE '%Confirm consultation%', 'video consultation reminder has WhatsApp call and no street address') FROM payload;

SELECT is(
 crm_private.render_approved_lifecycle_email_html(
   'ff202222-2222-4222-8222-222222222222',
   'session_reminder_72h',
   'Confirm: https://attacker.example/a Reschedule: https://attacker.example/b'
 ),
 NULL::text,'untrusted action URLs cannot become HTML buttons'
);

SELECT is(
 crm_private.render_approved_lifecycle_email_html(
   'ff202222-2222-4222-8222-222222222222',
   'session_reminder_72h',
   (SELECT confirm||E'\n'||confirm FROM action_links)
 ),
 NULL::text,'duplicate action capabilities are refused'
);

SELECT is(
 crm_private.render_approved_lifecycle_email_html(
   'ff202222-2222-4222-8222-222222222222',
   'session_reminder_24h',
   (SELECT confirm||E'\n'||reschedule FROM action_links)
 ),
 NULL::text,'24h reminder refuses unexpected two-action shape'
);

SELECT is(
 (SELECT count(*)::integer FROM public.message_templates t
  WHERE t.artist_id IN (
    'a1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222'
  ) AND t.channel='email' AND t.locale='en'
    AND t.status='active' AND t.purpose IN (
      'session_reminder_72h','session_reminder_24h','consultation_reminder')),
 6,'all six artist-scoped reviewed Email templates are active'
);

SELECT ok(
 (SELECT count(*)=2 FROM public.message_templates t
  WHERE t.artist_id IN (
    'a1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222')
    AND t.channel='email' AND t.locale='en' AND t.status='active'
    AND t.purpose='session_reminder_24h'
    AND position('{{reschedule_link}}' in t.body)>0
    AND position('{{confirm_link}}' in t.body)=0
    AND position('{{cancel_link}}' in t.body)=0
 ),'both 24h approved Email templates omit unnecessary actions'
);

SELECT ok(
 NOT has_function_privilege('authenticated',
   'crm_private.render_approved_lifecycle_email_html(uuid,text,text)','EXECUTE')
 AND NOT has_function_privilege('anon',
   'crm_private.render_approved_lifecycle_email_html(uuid,text,text)','EXECUTE'),
 'HTML renderer is not callable by public browser roles'
);

SELECT ok(
 EXISTS (
   SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.email_messages'::regclass
     AND tgname='email_messages_approved_tattoo_reminder_html'
     AND NOT tgisinternal
 ),'Tattoo reminder Email HTML decorator is installed'
);

SELECT * FROM finish(true);
ROLLBACK;
