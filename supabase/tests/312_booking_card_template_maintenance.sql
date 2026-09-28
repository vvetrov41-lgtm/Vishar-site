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
    'public.service_record_booking_card_template_status(uuid,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_record_booking_card_template_status(uuid,text,text,text,jsonb,jsonb)',
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

-- Meta's failure detail is kept in a bounded, content-free shape.
select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'UNKNOWN',
    'UNKNOWN',
    'whatsapp_template_rejected',
    '{"stage":"create_tattoo","http_status":400,"code":100,"subcode":2388024,"type":"OAuthException","message":"Invalid parameter","fbtrace_id":"AbCdEf123456","error_user_msg":"Hi {{1}}","extra":"x"}'::jsonb
  ) $$,
  'a provider failure is recorded with its diagnostic'
);

select is(
  (select whatsapp_template_last_provider_error
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  '{"stage":"create_tattoo","http_status":400,"code":100,"subcode":2388024,"type":"OAuthException","message":"Invalid parameter","fbtrace_id":"AbCdEf123456"}'::jsonb,
  'the allow-listed diagnostic is stored; user text and unknown keys are dropped'
);

select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'UNKNOWN',
    'UNKNOWN',
    'whatsapp_template_rejected',
    '{"stage":"create_tattoo","http_status":400,"code":100,"message":"Echo Hi {{1}}, booked","fbtrace_id":"x"}'::jsonb
  ) $$,
  'a message carrying a template placeholder is accepted'
);

select is(
  (select whatsapp_template_last_provider_error
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  '{"stage":"create_tattoo","http_status":400,"code":100}'::jsonb,
  'a message with a template placeholder and a malformed trace id are dropped'
);

select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'UNKNOWN',
    'UNKNOWN',
    'whatsapp_template_rejected',
    '{"stage":"drop table","http_status":"400","code":"1; select","type":"<script>"}'::jsonb
  ) $$,
  'malformed diagnostic values do not fail the status write'
);

select is(
  (select whatsapp_template_last_provider_error
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  null::jsonb,
  'malformed diagnostic values are dropped rather than stored'
);

select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'APPROVED',
    'APPROVED',
    null,
    '{"stage":"list","http_status":400,"code":200}'::jsonb
  ) $$,
  'a success call is accepted'
);

select ok(
  (select whatsapp_template_last_provider_error is null
      and whatsapp_template_last_error_code is null
      and whatsapp_enabled
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  'a successful check clears the previous diagnostic'
);

-- Meta's WABA health is stored alongside, bounded to its two keys.
select lives_ok(
  $$ select public.service_record_booking_card_template_status(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'UNKNOWN',
    'UNKNOWN',
    'whatsapp_template_rejected',
    '{"stage":"create_tattoo","http_status":400,"code":100,"subcode":2494160,"type":"OAuthException"}'::jsonb,
    '{"can_send_message":"LIMITED","entities":[{"entity_type":"WABA","can_send_message":"LIMITED","errors":[{"error_code":141010,"error_description":"d","possible_solution":"s"}]}]}'::jsonb
  ) $$,
  'a template restriction and WABA health are recorded'
);

select is(
  (select whatsapp_waba_health ->> 'can_send_message'
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  'LIMITED',
  'WABA health is stored'
);

-- While the restriction is recorded, the target is probed once a day.
insert into public.artist_integrations
  (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
select 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
       'vladimir-template-backoff-312', '{}'::jsonb, true
where not exists (
  select 1 from public.artist_integrations
  where artist_id = 'a1111111-1111-4111-8111-111111111111'
    and integration_type = 'whatsapp' and provider = 'meta_cloud_api' and is_enabled
);

update crm_private.booking_card_artist_settings
set whatsapp_template_checked_at = now() - interval '2 hours'
where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid;

select is(
  (select count(*)::int from public.service_claim_booking_card_template_targets(5)
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  0,
  'a restricted WABA is not retried two hours later'
);

update crm_private.booking_card_artist_settings
set whatsapp_template_checked_at = now() - interval '25 hours'
where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid;

select is(
  (select count(*)::int from public.service_claim_booking_card_template_targets(5)
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  1,
  'a restricted WABA is probed again after a day'
);

update crm_private.booking_card_artist_settings
set whatsapp_template_last_provider_error = '{"stage":"list","http_status":400,"code":200}'::jsonb,
    whatsapp_template_checked_at = now() - interval '2 hours'
where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid;

select is(
  (select count(*)::int from public.service_claim_booking_card_template_targets(5)
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  1,
  'any other failure keeps the normal 30-minute cadence'
);

-- An approved WABA is re-read daily for health, not every cycle.
update crm_private.booking_card_artist_settings
set whatsapp_template_last_provider_error = null,
    whatsapp_template_last_error_code = null,
    whatsapp_tattoo_template_status = 'APPROVED',
    whatsapp_consultation_template_status = 'APPROVED',
    whatsapp_waba_health_checked_at = now() - interval '2 hours',
    whatsapp_template_checked_at = now() - interval '2 hours'
where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid;

select is(
  (select count(*)::int from public.service_claim_booking_card_template_targets(5)
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  0,
  'an approved WABA with fresh health is not re-read'
);

update crm_private.booking_card_artist_settings
set whatsapp_waba_health_checked_at = now() - interval '25 hours',
    whatsapp_template_checked_at = now() - interval '2 hours'
where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid;

select is(
  (select count(*)::int from public.service_claim_booking_card_template_targets(5)
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid),
  1,
  'an approved WABA is re-read once its health is a day old'
);

select * from finish(true);
rollback;
