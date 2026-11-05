begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

-- In an isolated local pgTAP transaction only: no production client/contact is created.
insert into public.clients(id,full_name,email)
values ('dc101111-1111-4111-8111-111111111111',
        'Consultation Design Test','consultation-design@example.test');

insert into public.sessions (
  id,client_id,artist_id,appointment_type,status,
  start_at,end_at,duration_hours,currency
) values
 ('dc102222-2222-4222-8222-222222222222',
  'dc101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation','confirmed',
  date_trunc('hour',now())+interval '22 days',
  date_trunc('hour',now())+interval '22 days 30 minutes',0.5,'GBP'),
 ('dc103333-3333-4333-8333-333333333333',
  'dc101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'video_consultation','confirmed',
  date_trunc('hour',now())+interval '23 days',
  date_trunc('hour',now())+interval '23 days 30 minutes',0.5,'GBP');

select is(
 (select studio_address from crm_private.consultation_email_location()),
 'Unit B, York House, Avonmore Place, London W14 8RL',
 'consultation studio uses the requested Unit B address'
);

select is(
 (select studio_map_url from crm_private.consultation_email_location()),
 'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic',
 'location uses the explicitly provided Google Maps pin'
);

select ok(
 (select html_body like '%Unit B, York House, Avonmore Place%'
    and html_body like '%maps.app.goo.gl/zfTRAJ4MXEHcHf3S6%'
    and html_body not like '%Addison Bridge Place%'
  from crm_private.render_booking_card_email(
    (select id from crm_private.booking_cards
     where session_id='dc102222-2222-4222-8222-222222222222'
       and superseded_at is null),
    repeat('a',64),repeat('b',64))),
 'in-person consultation confirmation has new address in HTML'
);

select ok(
 (select body like '%Unit B, York House, Avonmore Place%'
    and body like '%maps.app.goo.gl/zfTRAJ4MXEHcHf3S6%'
  from crm_private.render_booking_card_email(
    (select id from crm_private.booking_cards
     where session_id='dc102222-2222-4222-8222-222222222222'
       and superseded_at is null),
    repeat('a',64),repeat('b',64))),
 'in-person consultation confirmation has new address in plain text'
);

select ok(
 (select body not like '%Unit B, York House%'
     and html_body not like '%Unit B, York House%'
     and html_body ilike '%video consultation%'
  from crm_private.render_booking_card_email(
    (select id from crm_private.booking_cards
     where session_id='dc103333-3333-4333-8333-333333333333'
       and superseded_at is null),
    repeat('a',64),repeat('b',64))),
 'video consultation confirmation never includes the studio location'
);

with example as (
 select crm_private.render_consultation_reminder_html(
   'dc102222-2222-4222-8222-222222222222',
   array[
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64),
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('b',64),
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('c',64)
   ]) as html
)
select ok(html like '%Confirm attendance%'
      and html like '%Request a different time%'
      and html like '%Cancel appointment%'
      and html like '%Get directions%'
      and html like '%Unit B, York House%'
      and html like '%/respond/'||repeat('a',64)||'%',
      'Gmail reminder displays three action links, correct address and directions')
from example;

with example as (
 select crm_private.render_consultation_reminder_html(
   'dc103333-3333-4333-8333-333333333333',
   array[
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64),
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('b',64),
    'https://booking.vishartattoo.com/appointments/respond/'||repeat('c',64)
   ]) as html
)
select ok(html ilike '%video consultation%'
       and html not like '%Unit B, York House%'
       and html not like '%Get directions%',
       'video reminder has online wording and no physical address')
from example;

select is(
 crm_private.render_consultation_reminder_html(
   'dc102222-2222-4222-8222-222222222222',
   array['https://attacker.example/a','https://attacker.example/b','https://attacker.example/c']),
 null::text,
 'untrusted action URLs are refused'
);

select is(
 crm_private.render_consultation_reminder_html(
   'dc102222-2222-4222-8222-222222222222',
   array['https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64),
         'https://booking.vishartattoo.com/appointments/respond/'||repeat('a',64),
         'https://booking.vishartattoo.com/appointments/respond/'||repeat('c',64)]),
 null::text,
 'duplicate action capabilities are refused'
);

select ok(
 exists (select 1 from pg_trigger t
        where t.tgrelid='public.email_messages'::regclass
          and t.tgname='email_messages_consultation_reminder_html'
          and not t.tgisinternal),
 'new approved reminder emails gain their HTML in the queue insert trigger'
);

select * from finish(true);
rollback;
