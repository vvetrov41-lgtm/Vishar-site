begin;

select plan(37);

select ok(
  'google_contact_create' = any(enum_range(null::public.outbox_kind)::text[]),
  'google_contact_create outbox kind exists'
);

select ok(
  to_regprocedure('public.set_google_contacts_sync(uuid,text,boolean)') is not null,
  'Google Contacts capability RPC exists'
);
select ok(
  to_regprocedure('public.claim_google_contact_outbox(text,integer,integer)') is not null,
  'Google Contacts claim RPC exists'
);
select ok(
  to_regprocedure('public.record_google_contact_outbox_result(uuid,text,boolean,text,text)') is not null,
  'Google Contacts acknowledgement RPC exists'
);
select ok(
  to_regprocedure('crm_private.enqueue_google_contact_create(uuid,uuid)') is not null,
  'private linked-client enqueue helper exists'
);
select ok(
  to_regprocedure('crm_private.reconcile_google_contact_sync(uuid)') is not null,
  'private reconciliation helper exists'
);

select ok(
  (
    select p.provolatile = 'v'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'crm_private'
      and p.proname = 'google_contacts_sync_enabled'
      and pg_get_function_identity_arguments(p.oid) = 'p_artist_id uuid'
  ),
  'Google Contacts capability check is VOLATILE so same-RPC enablement is visible'
);

select ok(
  '+447700919611' ~ E'^\\+[1-9][0-9]{7,14}$',
  'explicit E.164 regex matches a valid canonical phone'
);

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  (
    'dc611111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'calendar',
    'google',
    'google_calendar_vladimir',
    '{"google_contacts_sync":false}'::jsonb,
    true
  )
on conflict (artist_id, integration_type, integration_key) do update
set provider = excluded.provider,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled;

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  (
    'dc612222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111',
    'whatsapp',
    'meta_cloud_api',
    'vladimir-production',
    '{}'::jsonb,
    true
  )
on conflict (artist_id, integration_type, integration_key) do update
set provider = excluded.provider,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled;

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca611111-1111-4111-8111-111111111111',
    'Google Contact Reconcile Fixture',
    '+44 7700 919611',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.communication_conversations
  (id, artist_id, channel, integration_key, external_contact_id, client_id, link_state)
values
  (
    'cc611111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'whatsapp',
    'vladimir-production',
    '447700919611',
    'ca611111-1111-4111-8111-111111111111',
    'linked'
  );

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca611111-1111-4111-8111-111111111111'
  ),
  0,
  'disabled Google Contacts capability does not enqueue a linked WhatsApp client'
);

update public.artist_integrations
set configuration = jsonb_set(configuration, '{google_contacts_sync}', 'true'::jsonb, true)
where artist_id='a1111111-1111-4111-8111-111111111111'
  and integration_type='calendar'::public.artist_integration_type
  and provider='google'
  and integration_key='google_calendar_vladimir';

select is(
  crm_private.reconcile_google_contact_sync('a1111111-1111-4111-8111-111111111111'::uuid),
  1,
  'reconciliation enqueues a valid E.164 linked WhatsApp client'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (
    select job_valid
    from public.claim_google_contact_outbox('google-contacts-test', 1, 120)
    where client_id = 'ca611111-1111-4111-8111-111111111111'
  ),
  true,
  'claim marks a valid E.164 linked WhatsApp Google Contact job as valid'
);

select is(
  (
    public.record_google_contact_outbox_result(
      (
        select id
        from public.integration_outbox
        where kind = 'google_contact_create'::public.outbox_kind
          and client_id = 'ca611111-1111-4111-8111-111111111111'
      ),
      'google-contacts-test',
      false,
      null,
      'google_contacts_provider_rejected_http_400_invalid_argument'
    ) ->> 'status'
  ),
  'dead',
  'safe Google Contacts provider diagnostics are terminal and do not retry'
);

select is(
  (
    select last_error_code
    from public.integration_outbox
    where kind = 'google_contact_create'::public.outbox_kind
      and client_id = 'ca611111-1111-4111-8111-111111111111'
  ),
  'google_contacts_provider_rejected_http_400_invalid_argument',
  'terminal Google Contacts provider diagnostics remain available for diagnosis'
);

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca612222-2222-4222-8222-222222222222',
    'Google Contact Trigger Fixture',
    '+44 7700 919612',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.communication_conversations
  (id, artist_id, channel, integration_key, external_contact_id, client_id, link_state)
values
  (
    'cc612222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111',
    'whatsapp',
    'vladimir-production',
    '447700919612',
    'ca612222-2222-4222-8222-222222222222',
    'linked'
  );

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca612222-2222-4222-8222-222222222222'
  ),
  1,
  'linked WhatsApp trigger enqueues a valid E.164 client when capability is enabled'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.set_google_contacts_sync(uuid,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot toggle Google Contacts capability'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.set_google_contacts_sync(uuid,text,boolean)',
    'EXECUTE'
  ),
  'authenticated browser role cannot toggle Google Contacts capability'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.set_google_contacts_sync(uuid,text,boolean)',
    'EXECUTE'
  ),
  'service backend can toggle Google Contacts capability'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_google_contact_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated browser role cannot lease Google Contacts jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_google_contact_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'service backend can lease Google Contacts jobs'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.communication_conversations'::regclass
      and t.tgname = 'communication_conversations_enqueue_google_contact'
      and not t.tgisinternal
  ),
  'linked WhatsApp Google Contacts trigger exists'
);

select ok(
  pg_get_functiondef('crm_private.enqueue_linked_whatsapp_google_contact()'::regprocedure)
    like '%new.channel <> ''whatsapp''%'
  and pg_get_functiondef('crm_private.enqueue_linked_whatsapp_google_contact()'::regprocedure)
    like '%new.link_state <> ''linked''%'
  and pg_get_functiondef('crm_private.enqueue_linked_whatsapp_google_contact()'::regprocedure)
    like '%new.client_id is null%',
  'trigger ignores non-WhatsApp, unlinked and clientless conversations'
);

select ok(
  pg_get_functiondef('crm_private.enqueue_linked_whatsapp_google_contact()'::regprocedure)
    like '%exception when others%',
  'provider enqueue failures cannot roll back communication linkage'
);

select ok(
  pg_get_functiondef('public.resolve_outbox_route(uuid)'::regprocedure)
    like '%google_contact_create%'
  and pg_get_functiondef('public.resolve_outbox_route(uuid)'::regprocedure)
    like '%google_contacts_sync%',
  'provider route requires explicit Google Contacts capability'
);

select ok(
  pg_get_functiondef('public.list_calendar_connection_status()'::regprocedure)
    like '%google_contact_create%'
  and pg_get_functiondef('public.list_calendar_connection_status()'::regprocedure)
    like '%google_contacts_scope_missing%',
  'Google connection health includes Contacts jobs and legacy-consent reconnect state'
);


-- ---------------------------------------------------------------------------
-- Explicit WhatsApp preference on a trusted enquiry is an independent,
-- fail-closed eligibility proof.
-- ---------------------------------------------------------------------------

select ok(
  to_regprocedure('crm_private.google_contact_client_eligible(uuid,uuid)') is not null,
  'shared Google Contact eligibility helper exists'
);

select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.google_contact_client_eligible(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.google_contact_client_eligible(uuid,uuid)',
    'EXECUTE'
  ),
  'shared eligibility helper remains private even from service_role RPC callers'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.enquiries'::regclass
      and t.tgname = 'enquiries_enqueue_google_contact'
      and not t.tgisinternal
  ),
  'WhatsApp-preferred enquiry Google Contacts trigger exists'
);

select ok(
  pg_get_functiondef(
    'crm_private.enqueue_whatsapp_preferred_enquiry_google_contact()'::regprocedure
  ) like '%exception when others%',
  'enquiry trigger cannot make durable intake depend on Google Contacts enqueue'
);

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca613333-3333-4333-8333-333333333333',
    'WhatsApp Preferred Enquiry Fixture',
    '+44 7700 919613',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict,
  submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at,
  artist_id
) values (
  'e6133333-3333-4333-8333-333333333333',
  'ca613333-3333-4333-8333-333333333333',
  'ENQ-2099-9613',
  '96133333-3333-4333-8333-333333333333',
  repeat('a', 64),
  false,
  'WhatsApp Preferred Enquiry Fixture',
  'whatsapp-preferred@example.test',
  '+44 7700 919613',
  'WhatsApp',
  '2026-07-29',
  now(),
  'a1111111-1111-4111-8111-111111111111'
);

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca613333-3333-4333-8333-333333333333'
  ),
  1,
  'trusted WhatsApp-preferred enquiry enqueues exactly one Google Contact job without a WhatsApp conversation'
);

select is(
  crm_private.google_contact_client_eligible(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'ca613333-3333-4333-8333-333333333333'::uuid
  ),
  true,
  'matching WhatsApp-preferred enquiry qualifies the attached same-workspace client'
);

select is(
  (
    select job_valid
    from public.claim_google_contact_outbox('google-contacts-enquiry-test', 20, 120)
    where client_id = 'ca613333-3333-4333-8333-333333333333'
  ),
  true,
  'claim revalidates and accepts an enquiry-only WhatsApp eligibility proof'
);

select is(
  crm_private.enqueue_google_contact_create(
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'ca613333-3333-4333-8333-333333333333'::uuid
  ),
  null::uuid,
  're-enqueue remains idempotent for the same artist and client'
);

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca614444-4444-4444-8444-444444444444',
    'Email Preferred Enquiry Fixture',
    '+44 7700 919614',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict,
  submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at,
  artist_id
) values (
  'e6144444-4444-4444-8444-444444444444',
  'ca614444-4444-4444-8444-444444444444',
  'ENQ-2099-9614',
  '96144444-4444-4444-8444-444444444444',
  repeat('b', 64),
  false,
  'Email Preferred Enquiry Fixture',
  'email-preferred@example.test',
  '+44 7700 919614',
  'Email',
  '2026-07-29',
  now(),
  'a1111111-1111-4111-8111-111111111111'
);

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca614444-4444-4444-8444-444444444444'
  ),
  0,
  'non-WhatsApp enquiry preference does not enqueue a Google Contact job'
);

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca615555-5555-4555-8555-555555555555',
    'Conflicting Enquiry Fixture',
    '+44 7700 919615',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict,
  submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at,
  artist_id
) values (
  'e6155555-5555-4555-8555-555555555555',
  'ca615555-5555-4555-8555-555555555555',
  'ENQ-2099-9615',
  '96155555-5555-4555-8555-555555555555',
  repeat('c', 64),
  true,
  'Conflicting Enquiry Fixture',
  'conflicting-enquiry@example.test',
  '+44 7700 919615',
  'WhatsApp',
  '2026-07-29',
  now(),
  'a1111111-1111-4111-8111-111111111111'
);

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca615555-5555-4555-8555-555555555555'
  ),
  0,
  'identifier-conflict enquiry cannot qualify Google Contact creation'
);

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca616666-6666-4666-8666-666666666666',
    'Phone Mismatch Enquiry Fixture',
    '+44 7700 919616',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict,
  submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at,
  artist_id
) values (
  'e6166666-6666-4666-8666-666666666666',
  'ca616666-6666-4666-8666-666666666666',
  'ENQ-2099-9616',
  '96166666-6666-4666-8666-666666666666',
  repeat('d', 64),
  false,
  'Phone Mismatch Enquiry Fixture',
  'phone-mismatch@example.test',
  '+44 7700 919699',
  'WhatsApp',
  '2026-07-29',
  now(),
  'a1111111-1111-4111-8111-111111111111'
);

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca616666-6666-4666-8666-666666666666'
  ),
  0,
  'submitted phone mismatch cannot independently qualify Google Contact creation'
);

update public.artist_integrations
set configuration = jsonb_set(configuration, '{google_contacts_sync}', 'false'::jsonb, true)
where artist_id='a1111111-1111-4111-8111-111111111111'
  and integration_type='calendar'::public.artist_integration_type
  and provider='google'
  and integration_key='google_calendar_vladimir';

insert into public.clients
  (id, full_name, phone, workspace_id)
values
  (
    'ca617777-7777-4777-8777-777777777777',
    'Deferred Reconcile Enquiry Fixture',
    '+44 7700 919617',
    (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111')
  );

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict,
  submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at,
  artist_id
) values (
  'e6177777-7777-4777-8777-777777777777',
  'ca617777-7777-4777-8777-777777777777',
  'ENQ-2099-9617',
  '96177777-7777-4777-8777-777777777777',
  repeat('e', 64),
  false,
  'Deferred Reconcile Enquiry Fixture',
  'deferred-reconcile@example.test',
  '+44 7700 919617',
  'WhatsApp',
  '2026-07-29',
  now(),
  'a1111111-1111-4111-8111-111111111111'
);

select is(
  (
    select count(*)::integer
    from public.integration_outbox
    where kind='google_contact_create'::public.outbox_kind
      and client_id='ca617777-7777-4777-8777-777777777777'
  ),
  0,
  'disabled Contacts capability keeps a qualifying enquiry inert'
);

update public.artist_integrations
set configuration = jsonb_set(configuration, '{google_contacts_sync}', 'true'::jsonb, true)
where artist_id='a1111111-1111-4111-8111-111111111111'
  and integration_type='calendar'::public.artist_integration_type
  and provider='google'
  and integration_key='google_calendar_vladimir';

select is(
  crm_private.reconcile_google_contact_sync(
    'a1111111-1111-4111-8111-111111111111'::uuid
  ),
  1,
  'reconciliation later picks up a qualifying WhatsApp-preferred enquiry exactly once'
);

select * from finish();
rollback;
