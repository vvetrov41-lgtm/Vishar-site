-- End-to-end scheduler acceptance. Synthetic rows are rolled back;
-- no real client, production mailbox, or provider delivery is involved.
begin;
select no_plan();

create temporary table t_aftercare_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id=a.id and st.is_active
where a.slug='vladimir';
grant select on t_aftercare_artist to public;

insert into public.clients(id,full_name,email)
values ('fa111111-1111-4111-8111-111111111111','Aftercare Test','aftercare-client@example.test');

insert into public.projects(id,client_id,artist_id,title,description)
values ('fa222222-2222-4222-8222-222222222222',
        'fa111111-1111-4111-8111-111111111111',
        (select id from t_aftercare_artist),
        'Aftercare test','Rollback-only aftercare test');

insert into public.sessions
(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours)
select v.id,(select id from t_aftercare_artist),'fa111111-1111-4111-8111-111111111111',
       'fa222222-2222-4222-8222-222222222222',
       v.appointment_type::public.appointment_type,v.status::public.session_status,
       date_trunc('hour',now())+v.lead,
       date_trunc('hour',now())+v.lead+v.duration,
       extract(epoch from v.duration)/3600
from (values
  ('fa000000-0000-4000-8000-000000000001'::uuid,'tattoo_session','confirmed',interval '-4 hours',interval '3 hours'),
  ('fa000000-0000-4000-8000-000000000002'::uuid,'in_person_consultation','confirmed',interval '-7 hours',interval '30 minutes'),
  ('fa000000-0000-4000-8000-000000000003'::uuid,'tattoo_session','no_show',interval '-10 hours',interval '1 hour'),
  ('fa000000-0000-4000-8000-000000000004'::uuid,'tattoo_session','confirmed',interval '24 hours',interval '4 hours')
) v(id,appointment_type,status,lead,duration);

select crm_private.log_artist_activity(
  (select id from t_aftercare_artist),
  'appointment.scheduled','system',null,
  'fa111111-1111-4111-8111-111111111111',null,
  'fa222222-2222-4222-8222-222222222222',
  'fa000000-0000-4000-8000-000000000001',null,
  jsonb_build_object('appointment_type','tattoo_session')
);

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;

select lives_ok(
  $$select public.service_set_gmail_integration(
     (select id from t_aftercare_artist),
     'google_gmail_aftercare_test',
     'artist-aftercare@example.test',
     array['https://www.googleapis.com/auth/gmail.readonly',
           'https://www.googleapis.com/auth/gmail.send']::text[]
   )$$,
  'synthetic Gmail route is set for a rollback-only test'
);



select lives_ok(
  $$select * from public.service_run_automation_tick(100)$$,
  'scheduler auto-completes a past confirmed tattoo and processes its aftercare email'
);
reset role;

select is(
  (select status::text from public.sessions where id='fa000000-0000-4000-8000-000000000001'),
  'completed','ended confirmed tattoo is automatically completed');
select is(
  (select status::text from public.sessions where id='fa000000-0000-4000-8000-000000000002'),
  'confirmed','consultations never auto-complete');
select is(
  (select status::text from public.sessions where id='fa000000-0000-4000-8000-000000000003'),
  'no_show','no-show session is untouched');
select is(
  (select status::text from public.sessions where id='fa000000-0000-4000-8000-000000000004'),
  'confirmed','future session is untouched');
select is(
  (select count(*)::int from public.activity_log
   where session_id='fa000000-0000-4000-8000-000000000001'
     and event_type='appointment.status_changed'
     and actor_kind='system'
     and metadata->>'completion_source'='scheduled_end'),1,
  'completion has an auditable source');
select is(
  (select count(*)::int from public.automation_jobs
   where session_id='fa000000-0000-4000-8000-000000000001'
     and message_purpose='post_session_aftercare'
     and status='completed'),1,
  'immediate aftercare lifecycle job executes once');
select is(
  (select count(*)::int from public.email_messages
   where template_key='post_session_aftercare'
     and client_id='fa111111-1111-4111-8111-111111111111'
     and status='approved'
     and html_body like '%OPEN AFTERCARE GUIDE%'
     and html_body like '%https://vishartattoo.com/aftercare/%'
     and body like '%https://vishartattoo.com/aftercare/%'),1,
  'approved aftercare email contains a visual CTA and plain-text link');
select is(
  (select count(*)::int from public.integration_outbox
   where session_id='fa000000-0000-4000-8000-000000000001'
     and kind='approved_email'),1,
  'provider outbox has one aftercare email');
select is(
  (select count(*)::int from public.automation_jobs
   where session_id='fa000000-0000-4000-8000-000000000001'
     and message_purpose='post_session_checkin'
     and status='pending'),1,
  'existing 24-hour healing follow-up stays pending');

set local role service_role;
select lives_ok(
  $$select * from public.service_run_automation_tick(100)$$,
  'second scheduler tick is safe and idempotent');
reset role;
select is(
  (select count(*)::int from public.email_messages
   where template_key='post_session_aftercare'
     and client_id='fa111111-1111-4111-8111-111111111111'),1,
  'repeated scheduler tick cannot queue a duplicate aftercare email');
select ok(
  not has_function_privilege('authenticated',
   'crm_private.auto_complete_due_tattoo_sessions(integer)','execute')
  and not has_function_privilege('anon',
   'crm_private.auto_complete_due_tattoo_sessions(integer)','execute'),
  'no public CRM role can invoke the completion helper');

reset role;
select is(
  (select count(*)::int
   from public.message_templates mt
   join public.artists a on a.id=mt.artist_id
   where a.slug='kristina'
     and mt.purpose='post_session_aftercare'
     and mt.status='active'
     and position('https://www.kristinavishar.com/aftercare/' in mt.body)>0),1,
  'Kristina aftercare uses her own artist-scoped URL rather than Vladimir site');

select * from finish();
rollback;
