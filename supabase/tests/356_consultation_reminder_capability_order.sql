begin;
select no_plan();

with sample(body) as (
 select 'Confirm attendance:' || E'\n'
   || 'https://booking.vishartattoo.com/appointments/respond/' || repeat('a',64)
   || E'\nRequest a different time:\n'
   || 'https://booking.vishartattoo.com/appointments/respond/' || repeat('b',64)
   || E'\nCancel this appointment:\n'
   || 'https://booking.vishartattoo.com/appointments/respond/' || repeat('c',64)
)
select is(
  crm_private.consultation_reminder_action_urls(body),
  array[
    'https://booking.vishartattoo.com/appointments/respond/' || repeat('a',64),
    'https://booking.vishartattoo.com/appointments/respond/' || repeat('b',64),
    'https://booking.vishartattoo.com/appointments/respond/' || repeat('c',64)
  ]::text[],
  'confirmed, rescheduled and cancelled capabilities preserve their source order'
) from sample;

select is(
 crm_private.consultation_reminder_action_urls(
  'https://attacker.example/appointments/respond/'||repeat('a',64)),
 array[]::text[],
 'untrusted response-link hosts are never included'
);

select is(
 crm_private.consultation_reminder_action_urls(
  'https://booking.vishartattoo.com/appointments/respond/' || repeat('b',64)
  || E'\n'
  || 'https://booking.vishartattoo.com/appointments/respond/' || repeat('a',64)),
 array[
  'https://booking.vishartattoo.com/appointments/respond/' || repeat('b',64),
  'https://booking.vishartattoo.com/appointments/respond/' || repeat('a',64)
 ]::text[],
 'explicit position order is respected when input is reordered'
);

select ok(
  pg_get_functiondef('crm_private.render_approved_lifecycle_email_html(uuid,text,text)'::regprocedure)
    like '%crm_private.consultation_reminder_action_urls(p_body)%'
  and pg_get_functiondef('crm_private.decorate_consultation_reminder_email()'::regprocedure)
    like '%crm_private.render_approved_lifecycle_email_html(%',
  'new email decorator renders approved buttons from the ordered URL extractor'
);

select * from finish(true);
rollback;
