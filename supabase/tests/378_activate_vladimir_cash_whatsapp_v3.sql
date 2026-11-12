-- New approved Meta tattoo cash candidate: sender and resolver parity.
-- Read-only pgTAP; no synthetic production bookings or provider sends.
begin;
select no_plan();

select ok(
  strpos(pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure),
    'booking_card_tattoo_cash_v3')>0,
  'Vladimir tattoo card producer accepts approved v3');

select ok(
  strpos(pg_get_functiondef('public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure),
    'booking_card_tattoo_cash_v3')>0,
  'Outbox resolver accepts new tattoo card v3');

select ok(
  strpos(pg_get_functiondef('public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure),
    'booking_tattoo_cash')>0,
  'V3 outbox resolver checks genuine provider approval');

select ok(
  strpos(pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure),
    'when v_template_name=''booking_card_tattoo_cash_v3'' then ''booking_tattoo_cash''')>0,
  'Producer validates new kind against real Meta approval');

select ok(
  strpos(pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure),
    'cash payment is preferred')>0,
  'CRM WhatsApp preview accurately describes optional cash note');

select ok(
  not has_function_privilege('anon',
    'crm_private.activate_vladimir_cash_booking_whatsapp()','EXECUTE')
  and not has_function_privilege('authenticated',
    'crm_private.activate_vladimir_cash_booking_whatsapp()','EXECUTE')
  and not has_function_privilege('service_role',
    'crm_private.activate_vladimir_cash_booking_whatsapp()','EXECUTE'),
  'Provider-only activation remains private to SQL migrations');

select ok(
  not exists(select 1 from crm_private.whatsapp_template_proposals p
    where p.artist_id='a2222222-2222-4222-8222-222222222222'::uuid
      and p.kind='booking_tattoo_cash'),
  'Kristina never receives the Vladimir-only cash candidate');

select ok(
  not exists(select 1 from crm_private.booking_card_artist_settings s
    where s.artist_id='a2222222-2222-4222-8222-222222222222'::uuid
      and s.whatsapp_tattoo_template_name='booking_card_tattoo_cash_v3'),
  'Kristina retains her independent live WhatsApp settings');

select * from finish(true);
rollback;
