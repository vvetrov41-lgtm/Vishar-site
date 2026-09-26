-- 310_booking_card_whatsapp_actions.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'service_role',
    'public.service_apply_whatsapp_booking_card_action(uuid,text,text,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_apply_whatsapp_booking_card_action(uuid,text,text,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.service_apply_whatsapp_booking_card_action(uuid,text,text,text,timestamptz,text)',
    'EXECUTE'
  ),
  'only the trusted backend can apply a WhatsApp booking-card action'
);

select throws_ok(
  $$ select public.service_apply_whatsapp_booking_card_action(
    null, 'vladimir-production', '447700900001',
    'wamid.SYNTHETICTEST0001', now(),
    'booking_action:' || repeat('a', 64)
  ) $$,
  '22023', null,
  'the service action rejects an invalid signed-route envelope before lookup'
);

select * from finish();
rollback;
