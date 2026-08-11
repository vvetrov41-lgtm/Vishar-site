-- 190_telegram_outbox_drain.sql
--
-- Exact-ID Telegram leasing and acknowledgement. No provider is called.

begin;
select no_plan();

select has_function(
  'public', 'claim_telegram_outbox_by_id',
  array['uuid','text','integer'],
  'Telegram drain has an exact-ID claim RPC'
);
select has_function(
  'public', 'record_telegram_outbox_result',
  array['uuid','text','boolean','text'],
  'Telegram drain has a lease-aware result RPC'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    where p.oid = 'public.claim_telegram_outbox_by_id(uuid,text,integer)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no direct EXECUTE grant on exact Telegram claim'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    where p.oid = 'public.record_telegram_outbox_result(uuid,text,boolean,text)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no direct EXECUTE grant on Telegram acknowledgement'
);
select ok(
  not has_function_privilege(
    'anon', 'public.claim_telegram_outbox_by_id(uuid,text,integer)', 'EXECUTE'
  ),
  'anon cannot claim Telegram jobs'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.claim_telegram_outbox_by_id(uuid,text,integer)', 'EXECUTE'
  ),
  'authenticated cannot claim Telegram jobs'
);
select ok(
  has_function_privilege(
    'service_role', 'public.claim_telegram_outbox_by_id(uuid,text,integer)', 'EXECUTE'
  ),
  'service_role can claim one exact Telegram job'
);
select ok(
  not has_function_privilege(
    'anon', 'public.record_telegram_outbox_result(uuid,text,boolean,text)', 'EXECUTE'
  ),
  'anon cannot acknowledge Telegram jobs'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.record_telegram_outbox_result(uuid,text,boolean,text)', 'EXECUTE'
  ),
  'authenticated cannot acknowledge Telegram jobs'
);
select ok(
  has_function_privilege(
    'service_role', 'public.record_telegram_outbox_result(uuid,text,boolean,text)', 'EXECUTE'
  ),
  'service_role can acknowledge a leased Telegram job'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values (
  'c9111111-1111-4111-8111-111111111111',
  'Synthetic Telegram Drain Client',
  'telegram-drain@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, client_identifier_conflict,
  submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at
) values (
  'c9211111-1111-4111-8111-111111111111',
  'c9111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING',
  'c9221111-1111-4111-8111-111111111111',
  repeat('e', 64),
  'new', 'complete', true,
  'Synthetic Telegram Drain Client', 'telegram-drain@example.test',
  '2026-08-05', now()
);

insert into public.enquiry_files (
  id, enquiry_id, ordinal, storage_path, safe_extension, mime_type,
  byte_size, checksum, upload_state, uploaded_at
) values (
  'c9311111-1111-4111-8111-111111111111',
  'c9211111-1111-4111-8111-111111111111',
  0,
  public.enquiry_file_storage_path(
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'c9311111-1111-4111-8111-111111111111',
    'jpg'
  ),
  'jpg', 'image/jpeg', 100, repeat('f', 64), 'ready', now()
);

insert into public.integration_outbox (
  id, kind, dedupe_key, status, payload, client_id, enquiry_id, artist_id,
  attempt_count, max_attempts, next_attempt_at
) values
  (
    'c9411111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:target', 'pending',
    '{"reference_number":"FORGED","file_count":999}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 0, 8, now()
  ),
  (
    'c9421111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:sibling', 'failed', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now()
  ),
  (
    'c9431111-1111-4111-8111-111111111111',
    'reconciliation_sweep', 'reconciliation:exact_id:nontelegram', 'pending', '{}'::jsonb,
    null, null, 'a1111111-1111-4111-8111-111111111111', 0, 8, now()
  ),
  (
    'c9441111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:future', 'failed', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now() + interval '1 hour'
  ),
  (
    'c9471111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:retry', 'failed', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now()
  ),
  (
    'c9481111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:dead', 'failed', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 2, 3, now()
  ),
  (
    'c9491111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:invalid', 'pending', '{}'::jsonb,
    null, null, 'a1111111-1111-4111-8111-111111111111', 0, 8, now()
  );

insert into public.integration_outbox (
  id, kind, dedupe_key, status, payload, client_id, enquiry_id, artist_id,
  attempt_count, max_attempts, next_attempt_at,
  leased_by, leased_at, lease_expires_at
) values
  (
    'c9451111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:active_lease', 'leased', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now(),
    'telegram-worker-active', now(), now() + interval '5 minutes'
  ),
  (
    'c9461111-1111-4111-8111-111111111111',
    'telegram_notification', 'telegram:exact_id:expired_lease', 'leased', '{}'::jsonb,
    'c9111111-1111-4111-8111-111111111111',
    'c9211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111', 1, 8, now(),
    'telegram-worker-expired', now() - interval '5 minutes', now() - interval '1 minute'
  );

create temporary table target_claim as
select * from public.claim_telegram_outbox_by_id(
  'c9411111-1111-4111-8111-111111111111', 'telegram-worker-target', 120
);

select is((select count(*)::integer from target_claim), 1,
          'one explicit due Telegram UUID is leased');
select is((select outbox_id from target_claim),
          'c9411111-1111-4111-8111-111111111111'::uuid,
          'the exact requested UUID is returned');
select is((select artist_id from target_claim),
          'a1111111-1111-4111-8111-111111111111'::uuid,
          'the claim retains the event-time artist');
select is((select enquiry_id from target_claim),
          'c9211111-1111-4111-8111-111111111111'::uuid,
          'the claim retains the authoritative enquiry');
select is((select reference_number from target_claim),
          (select reference_number from public.enquiries
           where id = 'c9211111-1111-4111-8111-111111111111'),
          'reference number is read from the enquiry rather than the payload');
select is((select file_count from target_claim), 1,
          'file count is read from authoritative file state rather than the payload');
select ok((select client_conflict from target_claim),
          'client conflict is read from authoritative enquiry state');
select ok((select job_valid from target_claim),
          'the database validates outbox, enquiry, artist, client and ready files');

select is(
  (select status::text from public.integration_outbox
   where id = 'c9421111-1111-4111-8111-111111111111'),
  'failed',
  'a due sibling Telegram job is untouched by exact-ID claim'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = 'c9421111-1111-4111-8111-111111111111'),
  1,
  'the sibling attempt counter is unchanged'
);
select is(
  (select count(*)::integer from public.claim_telegram_outbox_by_id(
    'c9411111-1111-4111-8111-111111111111', 'telegram-worker-second', 120
  )),
  0,
  'a concurrent second claimant cannot take the active exact lease'
);
select is(
  (select count(*)::integer from public.claim_telegram_outbox_by_id(
    'c9431111-1111-4111-8111-111111111111', 'telegram-worker-nontelegram', 120
  )),
  0,
  'a non-Telegram outbox job cannot be claimed'
);
select is(
  (select count(*)::integer from public.claim_telegram_outbox_by_id(
    'c9441111-1111-4111-8111-111111111111', 'telegram-worker-future', 120
  )),
  0,
  'a non-due failed Telegram job cannot be claimed'
);
select is(
  (select count(*)::integer from public.claim_telegram_outbox_by_id(
    'c9451111-1111-4111-8111-111111111111', 'telegram-worker-steal', 120
  )),
  0,
  'an active Telegram lease cannot be stolen'
);

select throws_ok(
  $$select public.record_telegram_outbox_result(
      'c9411111-1111-4111-8111-111111111111',
      'telegram-worker-wrong', true, null
    )$$,
  '42501',
  'Telegram outbox lease is not owned by this worker',
  'a different worker cannot acknowledge the exact lease'
);

select is(
  (public.record_telegram_outbox_result(
    'c9411111-1111-4111-8111-111111111111',
    'telegram-worker-target', true, null
  ) ->> 'status'),
  'succeeded',
  'the lease owner records a successful provider attempt'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = 'c9411111-1111-4111-8111-111111111111'),
  1,
  'success increments the attempt counter exactly once'
);
select ok(
  (select leased_by is null and leased_at is null and lease_expires_at is null
   from public.integration_outbox
   where id = 'c9411111-1111-4111-8111-111111111111'),
  'success clears the exact lease'
);
select ok(
  (select last_error_code is null from public.integration_outbox
   where id = 'c9411111-1111-4111-8111-111111111111'),
  'success clears the previous error code'
);
select is(
  (select count(*)::integer from public.activity_log
   where outbox_id = 'c9411111-1111-4111-8111-111111111111'
     and event_type = 'outbox.succeeded'),
  1,
  'success appends one safe Activity Log event'
);
select ok(
  not (public.record_telegram_outbox_result(
    'c9411111-1111-4111-8111-111111111111',
    'telegram-worker-target', true, null
  ) ->> 'changed')::boolean,
  'a repeated successful acknowledgement is idempotent'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = 'c9411111-1111-4111-8111-111111111111'),
  1,
  'the acknowledgement replay does not increment attempts again'
);

create temporary table retry_claim as
select * from public.claim_telegram_outbox_by_id(
  'c9471111-1111-4111-8111-111111111111', 'telegram-worker-retry', 120
);
select is((select count(*)::integer from retry_claim), 1,
          'a due failed Telegram job can be claimed by exact UUID');
select is(
  (public.record_telegram_outbox_result(
    'c9471111-1111-4111-8111-111111111111',
    'telegram-worker-retry', false, 'telegram_unreachable'
  ) ->> 'status'),
  'failed',
  'a retryable provider failure returns the job to failed'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = 'c9471111-1111-4111-8111-111111111111'),
  2,
  'a failed retry increments the attempt counter once'
);
select ok(
  (select next_attempt_at > now() from public.integration_outbox
   where id = 'c9471111-1111-4111-8111-111111111111'),
  'a failed retry receives bounded exponential backoff'
);
select is(
  (select last_error_code from public.integration_outbox
   where id = 'c9471111-1111-4111-8111-111111111111'),
  'telegram_unreachable',
  'only the safe provider error code is stored'
);
select ok(
  (select leased_by is null and leased_at is null and lease_expires_at is null
   from public.integration_outbox
   where id = 'c9471111-1111-4111-8111-111111111111'),
  'failure clears the exact lease'
);
select is(
  (select count(*)::integer from public.activity_log
   where outbox_id = 'c9471111-1111-4111-8111-111111111111'
     and event_type = 'outbox.failed'),
  1,
  'failure appends one safe Activity Log event'
);

create temporary table expired_claim as
select * from public.claim_telegram_outbox_by_id(
  'c9461111-1111-4111-8111-111111111111', 'telegram-worker-reclaimed', 120
);
select is((select count(*)::integer from expired_claim), 1,
          'an expired Telegram lease can be reclaimed by exact UUID');
select is(
  (select leased_by from public.integration_outbox
   where id = 'c9461111-1111-4111-8111-111111111111'),
  'telegram-worker-reclaimed',
  'expired lease ownership moves to the exact claimant'
);
select is(
  (public.record_telegram_outbox_result(
    'c9461111-1111-4111-8111-111111111111',
    'telegram-worker-reclaimed', false, 'telegram_unreachable'
  ) ->> 'status'),
  'failed',
  'the reclaimed lease can be acknowledged by its new owner'
);

create temporary table dead_claim as
select * from public.claim_telegram_outbox_by_id(
  'c9481111-1111-4111-8111-111111111111', 'telegram-worker-dead', 120
);
select is(
  (public.record_telegram_outbox_result(
    'c9481111-1111-4111-8111-111111111111',
    'telegram-worker-dead', false, 'telegram_rejected'
  ) ->> 'status'),
  'dead',
  'max-attempt exhaustion dead-letters the exact Telegram job'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = 'c9481111-1111-4111-8111-111111111111'),
  3,
  'dead-lettering records the final attempt exactly once'
);

create temporary table invalid_claim as
select * from public.claim_telegram_outbox_by_id(
  'c9491111-1111-4111-8111-111111111111', 'telegram-worker-invalid', 120
);
select ok(not (select job_valid from invalid_claim),
          'a job without an authoritative enquiry relationship fails validation');
select throws_ok(
  $$select public.record_telegram_outbox_result(
      'c9491111-1111-4111-8111-111111111111',
      'telegram-worker-invalid', true, null
    )$$,
  '23514',
  'Telegram outbox job does not match its enquiry',
  'an invalid relationship cannot acknowledge provider success'
);
select is(
  (public.record_telegram_outbox_result(
    'c9491111-1111-4111-8111-111111111111',
    'telegram-worker-invalid', false, 'telegram_job_invalid'
  ) ->> 'status'),
  'failed',
  'an invalid projection is safely recorded as a failed attempt'
);

select * from finish(true);
rollback;
