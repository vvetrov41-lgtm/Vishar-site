begin;

select plan(16);

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

select * from finish();
rollback;
