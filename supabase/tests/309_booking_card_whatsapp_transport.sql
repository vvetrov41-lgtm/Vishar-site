-- 309_booking_card_whatsapp_transport.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  not has_table_privilege(
    'service_role',
    'crm_private.booking_card_whatsapp_payloads',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'crm_private.booking_card_whatsapp_payloads',
    'SELECT'
  ),
  'structured WhatsApp booking-card payloads are private'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.service_resolve_whatsapp_booking_card_payload(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_resolve_whatsapp_booking_card_payload(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.service_resolve_whatsapp_booking_card_payload(uuid,text)',
    'EXECUTE'
  ),
  'only the trusted backend can resolve a leased WhatsApp booking-card payload'
);

select throws_ok(
  $$ select * from public.service_resolve_whatsapp_booking_card_payload(
    gen_random_uuid(),
    'worker-valid'
  ) $$,
  '42501', null,
  'service resolver refuses a non-backend request context'
);

select * from finish(true);
rollback;
