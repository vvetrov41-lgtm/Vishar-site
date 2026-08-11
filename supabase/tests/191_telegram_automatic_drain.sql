-- 191_telegram_automatic_drain.sql
--
-- DB-authoritative rollout cutoff and bounded automatic Telegram leasing. No
-- provider is called and every data mutation is rolled back.

begin;
select no_plan();

select has_table(
  'crm_private', 'outbox_drain_rollouts',
  'automatic outbox rollout metadata is stored in a private schema'
);
select has_function(
  'public', 'claim_telegram_outbox', array['text','integer','integer'],
  'automatic Telegram drain has a bounded claim RPC'
);
select has_index(
  'public', 'integration_outbox', 'integration_outbox_telegram_ready_idx',
  'Telegram ready jobs have a partial ordering index'
);
select ok(
  (select c.relrowsecurity
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm_private' and c.relname = 'outbox_drain_rollouts'),
  'rollout metadata has RLS enabled as defence in depth'
);
select ok(
  not has_table_privilege('anon', 'crm_private.outbox_drain_rollouts', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.outbox_drain_rollouts', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.outbox_drain_rollouts', 'SELECT'),
  'browser, CRM and service roles cannot read rollout metadata directly'
);
select ok(
  not has_table_privilege('anon', 'crm_private.outbox_drain_rollouts', 'INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'crm_private.outbox_drain_rollouts', 'INSERT,UPDATE,DELETE')
  and not has_table_privilege('service_role', 'crm_private.outbox_drain_rollouts', 'INSERT,UPDATE,DELETE'),
  'browser, CRM and service roles cannot write rollout metadata directly'
);
select is(
  (select count(*)::integer from crm_private.outbox_drain_rollouts
   where kind = 'telegram_notification'),
  1,
  'one Telegram rollout cutoff exists'
);
select ok(
  (select automatic_after = created_at and automatic_after <= statement_timestamp()
   from crm_private.outbox_drain_rollouts
   where kind = 'telegram_notification'),
  'the cutoff records the migration application statement time'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    where p.oid = 'public.claim_telegram_outbox(text,integer,integer)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no direct EXECUTE grant on automatic Telegram claim'
);
select ok(
  not has_function_privilege(
    'anon', 'public.claim_telegram_outbox(text,integer,integer)', 'EXECUTE'
  ),
  'anon cannot claim Telegram jobs automatically'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.claim_telegram_outbox(text,integer,integer)', 'EXECUTE'
  ),
  'authenticated CRM sessions cannot claim Telegram jobs automatically'
);
select ok(
  has_function_privilege(
    'service_role', 'public.claim_telegram_outbox(text,integer,integer)', 'EXECUTE'
  ),
  'service_role can invoke the internally guarded automatic claim'
);
select ok(
  (select p.prosecdef
   from pg_catalog.pg_proc p
   where p.oid = 'public.claim_telegram_outbox(text,integer,integer)'::regprocedure),
  'automatic claim is SECURITY DEFINER'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(p.proconfig)
   from pg_catalog.pg_proc p
   where p.oid = 'public.claim_telegram_outbox(text,integer,integer)'::regprocedure),
  'automatic claim has a fixed search_path'
);
select ok(
  lower(pg_get_functiondef('public.claim_telegram_outbox(text,integer,integer)'::regprocedure))
    like '%for update of o skip locked%',
  'overlapping workers use FOR UPDATE SKIP LOCKED'
);
select ok(
  not (
    pg_get_function_result('public.claim_telegram_outbox(text,integer,integer)'::regprocedure)
      ilike any(array['%email%','%phone%','%idea%','%payload%','%token%','%chat%','%credential%'])
  ),
  'claim projection contains no client contact, idea, payload or provider credential fields'
);

select throws_ok(
  $$select * from public.claim_telegram_outbox('x', 10, 120)$$,
  '22023', 'Telegram worker id is invalid',
  'worker id validation fails closed'
);
select throws_ok(
  $$select * from public.claim_telegram_outbox('telegram-worker-limit', 21, 120)$$,
  '22023', 'Telegram claim limit must be between 1 and 20',
  'claim limit is bounded at twenty'
);
select throws_ok(
  $$select * from public.claim_telegram_outbox('telegram-worker-lease', 10, 29)$$,
  '22023', 'Telegram lease must be between 30 and 600 seconds',
  'lease duration is bounded'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table telegram_rollout_cutoff as
select automatic_after
from crm_private.outbox_drain_rollouts
where kind = 'telegram_notification';

insert into public.clients (id, full_name, email) values (
  'ca111111-1111-4111-8111-111111111111',
  'Synthetic Automatic Telegram Client',
  'telegram-automatic@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, client_identifier_conflict,
  submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at
) values (
  'ca211111-1111-4111-8111-111111111111',
  'ca111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING',
  'ca221111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'new', 'complete', false,
  'Synthetic Automatic Telegram Client', 'telegram-automatic@example.test',
  '2026-08-11', now()
);

insert into public.enquiry_files (
  id, enquiry_id, ordinal, storage_path, safe_extension, mime_type,
  byte_size, checksum, upload_state, uploaded_at
) values (
  'ca311111-1111-4111-8111-111111111111',
  'ca211111-1111-4111-8111-111111111111',
  0,
  public.enquiry_file_storage_path(
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'ca311111-1111-4111-8111-111111111111',
    'jpg'
  ),
  'jpg', 'image/jpeg', 100, repeat('b', 64), 'ready', now()
);

insert into public.integration_outbox (
  id, kind, dedupe_key, status, payload, client_id, enquiry_id, artist_id,
  attempt_count, max_attempts, next_attempt_at, created_at, updated_at
) values
  (
    'ca410001-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:pre_pending', 'pending', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 0, 8, now() - interval '20 minutes',
    (select automatic_after - interval '2 seconds' from telegram_rollout_cutoff),
    (select automatic_after - interval '2 seconds' from telegram_rollout_cutoff)
  ),
  (
    'ca410002-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:pre_failed', 'failed', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() - interval '19 minutes',
    (select automatic_after - interval '1 second' from telegram_rollout_cutoff),
    (select automatic_after - interval '1 second' from telegram_rollout_cutoff)
  ),
  (
    'ca410003-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:post_pending', 'pending', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 0, 8, now() - interval '18 minutes',
    (select automatic_after + interval '1 microsecond' from telegram_rollout_cutoff),
    (select automatic_after + interval '1 microsecond' from telegram_rollout_cutoff)
  ),
  (
    'ca410004-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:post_failed', 'failed', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() - interval '17 minutes',
    (select automatic_after + interval '2 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '2 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca410005-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:future', 'failed', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() + interval '1 hour',
    (select automatic_after + interval '3 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '3 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca410006-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:succeeded', 'succeeded', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() - interval '16 minutes',
    (select automatic_after + interval '4 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '4 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca410007-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:dead', 'dead', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 8, 8, now() - interval '15 minutes',
    (select automatic_after + interval '5 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '5 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca410008-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:max_attempts', 'failed', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 8, 8, now() - interval '14 minutes',
    (select automatic_after + interval '6 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '6 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca41000b-1111-4111-8111-111111111111',
    'reconciliation', 'reconciliation:auto:nontelegram', 'pending', '{}'::jsonb,
    null, null, 'a1111111-1111-4111-8111-111111111111', 0, 8,
    now() - interval '13 minutes',
    (select automatic_after + interval '7 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '7 microseconds' from telegram_rollout_cutoff)
  );

insert into public.integration_outbox (
  id, kind, dedupe_key, status, payload, client_id, enquiry_id, artist_id,
  attempt_count, max_attempts, next_attempt_at,
  leased_by, leased_at, lease_expires_at, created_at, updated_at
) values
  (
    'ca410009-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:active_lease', 'leased', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() - interval '12 minutes',
    'telegram-worker-active', now(), now() + interval '5 minutes',
    (select automatic_after + interval '8 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '8 microseconds' from telegram_rollout_cutoff)
  ),
  (
    'ca41000a-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:auto:expired_lease', 'leased', '{}'::jsonb,
    'ca111111-1111-4111-8111-111111111111',
    'ca211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() - interval '11 minutes',
    'telegram-worker-expired', now() - interval '5 minutes', now() - interval '1 minute',
    (select automatic_after + interval '9 microseconds' from telegram_rollout_cutoff),
    (select automatic_after + interval '9 microseconds' from telegram_rollout_cutoff)
  );

create temporary table first_automatic_claim as
select
  c.outbox_id,
  c.artist_id,
  c.kind,
  c.enquiry_id,
  c.attempt_count,
  c.max_attempts,
  c.reference_number,
  c.file_count,
  c.client_conflict,
  c.job_valid,
  c.ordinality as claim_order
from public.claim_telegram_outbox(
  'telegram-worker-first', 2, 120
) with ordinality as c;

select is((select count(*)::integer from first_automatic_claim), 2,
          'p_limit bounds the automatic claim batch');
select results_eq(
  'select outbox_id from first_automatic_claim order by claim_order',
  $$values
    ('ca410003-1111-4111-8111-111111111111'::uuid),
    ('ca410004-1111-4111-8111-111111111111'::uuid)$$,
  'due post-cutoff pending and failed jobs are selected in stable order'
);
select ok(
  (select bool_and(
    o.status = 'leased'
    and o.leased_by = 'telegram-worker-first'
    and o.leased_at is not null
    and o.lease_expires_at > o.leased_at
  )
  from public.integration_outbox o
  join first_automatic_claim c on c.outbox_id = o.id),
  'the bounded claim sets complete lease ownership fields atomically'
);
select ok(
  (select bool_and(job_valid) from first_automatic_claim),
  'automatic claim returns authoritative valid enquiry projections'
);

select is(
  (select count(*)::integer
   from public.claim_telegram_outbox('telegram-worker-second', 20, 120)
   where outbox_id in (
     'ca410003-1111-4111-8111-111111111111'::uuid,
     'ca410004-1111-4111-8111-111111111111'::uuid
   )),
  0,
  'a second worker cannot claim rows with active leases'
);
select is(
  (select leased_by from public.integration_outbox
   where id = 'ca41000a-1111-4111-8111-111111111111'),
  'telegram-worker-second',
  'an expired post-cutoff lease is reclaimable by another worker'
);

select is(
  (select status::text from public.integration_outbox
   where id = 'ca410001-1111-4111-8111-111111111111'),
  'pending',
  'pre-cutoff pending job is excluded'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca410002-1111-4111-8111-111111111111'),
  'failed',
  'pre-cutoff failed job is excluded'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca410005-1111-4111-8111-111111111111'),
  'failed',
  'future next_attempt_at job is excluded'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca410006-1111-4111-8111-111111111111'),
  'succeeded',
  'succeeded job is excluded'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca410007-1111-4111-8111-111111111111'),
  'dead',
  'dead job is excluded'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca410008-1111-4111-8111-111111111111'),
  'failed',
  'max-attempt failed job is excluded'
);
select is(
  (select leased_by from public.integration_outbox
   where id = 'ca410009-1111-4111-8111-111111111111'),
  'telegram-worker-active',
  'active pre-existing lease is not stolen'
);
select is(
  (select status::text from public.integration_outbox
   where id = 'ca41000b-1111-4111-8111-111111111111'),
  'pending',
  'non-Telegram outbox kind is excluded'
);

select is(
  (select count(*)::integer from public.claim_telegram_outbox_by_id(
    'ca410001-1111-4111-8111-111111111111', 'telegram-worker-exact', 120
  )),
  1,
  'exact-ID claim remains compatible and can intentionally address a pre-cutoff row'
);
select throws_ok(
  $$select public.record_telegram_outbox_result(
      'ca410001-1111-4111-8111-111111111111',
      'telegram-worker-wrong', false, 'telegram_unreachable'
    )$$,
  '42501', 'Telegram outbox lease is not owned by this worker',
  'wrong worker cannot acknowledge a Telegram lease'
);
select is(
  (public.record_telegram_outbox_result(
    'ca410001-1111-4111-8111-111111111111',
    'telegram-worker-exact', false, 'telegram_unreachable'
  ) ->> 'status'),
  'failed',
  'existing lease-aware acknowledgement remains compatible'
);

select * from finish(true);
rollback;
