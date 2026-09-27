-- 312_booking_card_template_maintenance.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'service_role',
    'public.service_claim_booking_card_template_targets(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_claim_booking_card_template_targets(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.service_claim_booking_card_template_targets(integer)',
    'EXECUTE'
  ),
  'only the trusted backend can claim Meta booking-card template maintenance'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.service_record_booking_card_template_status(uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_record_booking_card_template_status(uuid,text,text,text)',
    'EXECUTE'
  ),
  'only the trusted backend can record safe Meta template status'
);

select throws_ok(
  $$ select public.service_record_booking_card_template_status(
    gen_random_uuid(),
    'approved<script>',
    'APPROVED',
    null
  ) $$,
  '22023', null,
  'provider status is bounded to a safe machine vocabulary shape'
);

select throws_ok(
  $$ update crm_private.booking_card_artist_settings
     set whatsapp_enabled = true
     where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid $$,
  '23514', null,
  'WhatsApp booking cards cannot be enabled before both Meta templates are approved'
);

select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'APPROVED',
    'APPROVED',
    null
  ) $$,
  'provider approval readback is accepted through the backend status path'
);

select ok(
  (select whatsapp_enabled
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  'WhatsApp booking cards activate automatically only after both templates are approved'
);

select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'REJECTED',
    'APPROVED',
    'whatsapp_template_rejected'
  ) $$,
  'provider approval regression is recorded through the backend status path'
);

select ok(
  not (select whatsapp_enabled
       from crm_private.booking_card_artist_settings
       where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  'template approval regression disables WhatsApp booking cards immediately'
);

select * from finish(true);
rollback;
