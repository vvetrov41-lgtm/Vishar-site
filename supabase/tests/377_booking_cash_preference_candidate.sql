-- Cash-preference confirmation, Vladimir tattoo only.
-- No client messages or test bookings. All checks are read-only and rolled back.
begin;
select no_plan();

select is(
 (select template_name from crm_private.whatsapp_template_proposals
  where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    and kind='booking_tattoo_cash'),
 'booking_card_tattoo_cash_v3'::text,
 'the new Meta candidate has its own immutable name');

select is(
 (select approval_status from crm_private.whatsapp_template_proposals
  where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    and kind='booking_tattoo_cash'),
 'UNKNOWN'::text,
 'candidate is not incorrectly marked approved');

select ok(
 not exists(select 1 from crm_private.booking_card_artist_settings
  where whatsapp_tattoo_template_name='booking_card_tattoo_cash_v3'),
 'candidate cannot send to clients before provider approval and later promotion');

select ok(
 not exists(select 1 from crm_private.whatsapp_template_proposals
  where kind='booking_tattoo_cash'
    and artist_id='a2222222-2222-4222-8222-222222222222'::uuid),
 'Kristina has no cash-payment candidate');

select ok(
 strpos(pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure),
        'cash payment is preferred')>0,
 'cash note is present in the email renderer');

select ok(
 strpos(pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure),
        'IF v_card.artist_id=')>0,
 'cash note is gated to an explicit artist');

select ok(
 not has_function_privilege('anon',
      'crm_private.render_booking_card_email(uuid,text,text)','execute')
 and not has_function_privilege('authenticated',
      'crm_private.render_booking_card_email(uuid,text,text)','execute'),
 'email renderer remains privileged');

select * from finish(true);
rollback;
