begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.clients (id,full_name,email) values (
 'da201111-1111-4111-8111-111111111111',
 'Video Test Client','video-client@example.test'
);
insert into public.sessions (
  id,client_id,artist_id,appointment_type,status,start_at,end_at,duration_hours,currency
) values (
  'da202222-2222-4222-8222-222222222222',
  'da201111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'video_consultation','confirmed',
  date_trunc('hour',now())+interval '21 days',
  date_trunc('hour',now())+interval '21 days 30 minutes',
  0.5,'GBP'
);

select is(
 (select reason from crm_private.booking_card_eligibility('da202222-2222-4222-8222-222222222222')),
 'ready',
 'confirmed video consultation is eligible for a card'
);
select is(
 (select card_kind from crm_private.booking_cards
  where session_id='da202222-2222-4222-8222-222222222222' and superseded_at is null),
 'consultation_booked',
 'video consultation uses the established free consultation card'
);
select ok(
 (select session_price is null and deposit_paid is null and remaining_balance is null
  from crm_private.booking_cards
  where session_id='da202222-2222-4222-8222-222222222222' and superseded_at is null),
 'no prices or deposits appear on video consultation cards'
);
select ok(
 (select body like '%WhatsApp video consultation%'
   and body like '%video call you on WhatsApp at the scheduled time%'
   and body not like '%Confirm video call%'
   and html_body not like '%Get directions%'
   and body not like '%' || (select studio_address from crm_private.booking_card_artist_settings
     where artist_id='a1111111-1111-4111-8111-111111111111') || '%'
  from crm_private.render_booking_card_email(
    (select id from crm_private.booking_cards
      where session_id='da202222-2222-4222-8222-222222222222' and superseded_at is null),
    repeat('a',64),repeat('b',64))),
 'WhatsApp video confirmation is first person and has no studio address'
);
select is(
 (select whatsapp_video_template_status from crm_private.booking_card_artist_settings
  where artist_id='a1111111-1111-4111-8111-111111111111'),
 'UNKNOWN',
 'new WhatsApp video template is not presumed Meta-approved'
);
select * from finish(true);
rollback;
