-- 199_whatsapp_outbox_drain.sql
--
-- Migration 0048: backend-only WhatsApp claim, lease and acknowledgement.
--
-- Everything is synthetic. No Meta endpoint is contacted and no credential
-- exists; the suite proves lease ownership, bounded retry, dead-lettering and
-- that the claim projection cannot be reached by a browser session.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- ACLs
-- ---------------------------------------------------------------------------

select has_function('public', 'claim_whatsapp_outbox',
                    array['text', 'integer', 'integer'], 'the batched claim exists');
select has_function('public', 'claim_whatsapp_outbox_by_id',
                    array['uuid', 'text', 'integer'], 'the exact-id claim exists');
select has_function('public', 'record_whatsapp_outbox_result',
                    array['uuid', 'text', 'boolean', 'text', 'text'], 'the acknowledgement exists');

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    where p.oid = 'public.claim_whatsapp_outbox(text,integer,integer)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no direct EXECUTE grant on the WhatsApp claim'
);

select ok(
  not has_function_privilege('anon', 'public.' || sig, 'EXECUTE'),
  'anon cannot reach ' || sig
) from unnest(array[
  'claim_whatsapp_outbox(text,integer,integer)',
  'claim_whatsapp_outbox_by_id(uuid,text,integer)',
  'record_whatsapp_outbox_result(uuid,text,boolean,text,text)'
]) as sig;

select ok(
  not has_function_privilege('authenticated', 'public.' || sig, 'EXECUTE'),
  'a CRM browser session cannot reach ' || sig
) from unnest(array[
  'claim_whatsapp_outbox(text,integer,integer)',
  'claim_whatsapp_outbox_by_id(uuid,text,integer)',
  'record_whatsapp_outbox_result(uuid,text,boolean,text,text)'
]) as sig;

select ok(
  has_function_privilege('service_role', 'public.' || sig, 'EXECUTE'),
  'the trusted backend may call ' || sig
) from unnest(array[
  'claim_whatsapp_outbox(text,integer,integer)',
  'claim_whatsapp_outbox_by_id(uuid,text,integer)',
  'record_whatsapp_outbox_result(uuid,text,boolean,text,text)'
]) as sig;

select ok(
  (select p.prosecdef from pg_catalog.pg_proc p
   where p.oid = 'public.claim_whatsapp_outbox(text,integer,integer)'::regprocedure),
  'the batched claim is SECURITY DEFINER'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(p.proconfig)
   from pg_catalog.pg_proc p
   where p.oid = 'public.claim_whatsapp_outbox(text,integer,integer)'::regprocedure),
  'the batched claim has a fixed search_path'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(p.proconfig)
   from pg_catalog.pg_proc p
   where p.oid = 'public.record_whatsapp_outbox_result(uuid,text,boolean,text,text)'::regprocedure),
  'the acknowledgement has a fixed search_path'
);

-- The projection must not expose a credential. It does deliberately expose the
-- destination and body, which the backend cannot deliver without.
select ok(
  not (
    pg_get_function_result('public.claim_whatsapp_outbox(text,integer,integer)'::regprocedure)
      ilike any(array['%token%', '%secret%', '%credential%', '%password%'])
  ),
  'the claim projection exposes no token, secret or credential column'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
('da111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp', 'meta_cloud_api', 'vladimir-production',
 'Synthetic Vladimir WhatsApp', '{"coexistence":true}'::jsonb, true),
('da222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'whatsapp', 'meta_cloud_api', 'kristina-production',
 'Synthetic Kristina WhatsApp', '{"coexistence":true}'::jsonb, true);

insert into public.clients (id, full_name, email) values
  ('cd111111-1111-4111-8111-111111111111', 'Drain Vladimir Client', 'drain.v@example.test'),
  ('cd222222-2222-4222-8222-222222222222', 'Drain Kristina Client', 'drain.k@example.test');

insert into public.whatsapp_conversations (
  id, artist_id, client_id, integration_key, contact_wa_id
) values
('cb111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'cd111111-1111-4111-8111-111111111111', 'vladimir-production', '447700900011'),
('cb222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'cd222222-2222-4222-8222-222222222222', 'kristina-production', '447700900022');

insert into public.whatsapp_messages (
  id, conversation_id, artist_id, direction, origin, status, body
) values
('cc111111-1111-4111-8111-111111111111', 'cb111111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111', 'outbound', 'crm', 'queued', 'Vladimir queued reply'),
('cc222222-2222-4222-8222-222222222222', 'cb222222-2222-4222-8222-222222222222',
 'a2222222-2222-4222-8222-222222222222', 'outbound', 'crm', 'queued', 'Kristina queued reply'),
('cc333333-3333-4333-8333-333333333333', 'cb111111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111', 'outbound', 'crm', 'queued', 'Vladimir retry probe');

-- The rollout cutoff is DB-authoritative, so synthetic jobs are backdated past
-- it exactly the way the Telegram suite does.
update crm_private.outbox_drain_rollouts
set automatic_after = now() - interval '1 day',
    created_at = now() - interval '1 day'
where kind = 'whatsapp_message';

insert into public.integration_outbox (
  id, artist_id, kind, dedupe_key, payload, whatsapp_message_id,
  client_id, status, next_attempt_at, created_at
) values
('ce111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp_message', 'whatsapp:send:drain-vladimir',
 '{"whatsapp_message_id":"cc111111-1111-4111-8111-111111111111"}'::jsonb,
 'cc111111-1111-4111-8111-111111111111', 'cd111111-1111-4111-8111-111111111111',
 'pending', now() - interval '3 minutes', now() - interval '3 hours'),
('ce222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'whatsapp_message', 'whatsapp:send:drain-kristina',
 '{"whatsapp_message_id":"cc222222-2222-4222-8222-222222222222"}'::jsonb,
 'cc222222-2222-4222-8222-222222222222', 'cd222222-2222-4222-8222-222222222222',
 'pending', now() - interval '2 minutes', now() - interval '2 hours'),
('ce333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp_message', 'whatsapp:send:drain-retry',
 '{"whatsapp_message_id":"cc333333-3333-4333-8333-333333333333"}'::jsonb,
 'cc333333-3333-4333-8333-333333333333', 'cd111111-1111-4111-8111-111111111111',
 'pending', now() - interval '1 minute', now() - interval '1 hour');

-- ---------------------------------------------------------------------------
-- A browser session can never claim
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select * from public.claim_whatsapp_outbox('whatsapp-worker-browser', 1, 120)$$,
  '42501', 'WhatsApp outbox claiming is backend-only',
  'a CRM session cannot claim WhatsApp jobs even if it reaches the function'
);
select throws_ok(
  $$select public.record_whatsapp_outbox_result(
      'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-browser', true, 'wamid.X0000001')$$,
  '42501', 'WhatsApp outbox acknowledgement is backend-only',
  'a CRM session cannot acknowledge WhatsApp jobs'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Bounds
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select * from public.claim_whatsapp_outbox('whatsapp-worker-a', 21, 120)$$,
  '22023', null, 'the claim batch is capped at 20'
);
select throws_ok(
  $$select * from public.claim_whatsapp_outbox('whatsapp-worker-a', 0, 120)$$,
  '22023', null, 'the claim batch must be at least 1'
);
select throws_ok(
  $$select * from public.claim_whatsapp_outbox('whatsapp-worker-a', 1, 29)$$,
  '22023', null, 'the lease has a minimum'
);
select throws_ok(
  $$select * from public.claim_whatsapp_outbox('whatsapp-worker-a', 1, 601)$$,
  '22023', null, 'the lease has a maximum'
);
select throws_ok(
  $$select * from public.claim_whatsapp_outbox('BAD WORKER', 1, 120)$$,
  '22023', null, 'a malformed worker id is refused'
);

-- ---------------------------------------------------------------------------
-- Claim and artist isolation
-- ---------------------------------------------------------------------------

create temporary table wa_claim as
select c.outbox_id, c.artist_id, c.integration_key, c.contact_wa_id, c.body, c.job_valid
from public.claim_whatsapp_outbox('whatsapp-worker-first', 2, 120) as c;

select is((select count(*)::int from wa_claim), 2, 'the batch bound is honoured');
select ok((select bool_and(job_valid) from wa_claim), 'both synthetic jobs are valid');

select is(
  (select integration_key from wa_claim where artist_id = 'a1111111-1111-4111-8111-111111111111'),
  'vladimir-production', 'Vladimir claims his own integration key'
);
select is(
  (select integration_key from wa_claim where artist_id = 'a2222222-2222-4222-8222-222222222222'),
  'kristina-production', 'Kristina claims her own integration key'
);
select is(
  (select contact_wa_id from wa_claim where artist_id = 'a1111111-1111-4111-8111-111111111111'),
  '447700900011', 'the destination is recomputed from the conversation'
);
select ok(
  (select count(distinct integration_key)::int from wa_claim) = 2,
  'the two artists never share one integration key'
);

select ok(
  (select bool_and(
     o.status = 'leased'
     and o.leased_by = 'whatsapp-worker-first'
     and o.leased_at is not null
     and o.lease_expires_at > o.leased_at)
   from public.integration_outbox o
   join wa_claim c on c.outbox_id = o.id),
  'the claim sets complete lease ownership atomically'
);

-- A second worker cannot steal a live lease.
select is(
  (select count(*)::int from public.claim_whatsapp_outbox('whatsapp-worker-second', 5, 120)
   where outbox_id in (select outbox_id from wa_claim)),
  0,
  'a live lease is not re-claimable by another worker'
);

-- ---------------------------------------------------------------------------
-- Acknowledgement
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.record_whatsapp_outbox_result(
      'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-wrong', true, 'wamid.X0000001')$$,
  '42501', 'WhatsApp outbox lease is not owned by this worker',
  'a different worker cannot acknowledge the lease'
);
select throws_ok(
  $$select public.record_whatsapp_outbox_result(
      'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-first', true, null)$$,
  '22023', null,
  'a successful send must report a provider message id'
);
select throws_ok(
  $$select public.record_whatsapp_outbox_result(
      'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-first', false, null, 'Bad Code')$$,
  '22023', null,
  'a failure must report a safe machine error code'
);

select is(
  (public.record_whatsapp_outbox_result(
     'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-first', true,
     'wamid.SYNTHETICSEND0001') ->> 'status'),
  'succeeded',
  'the lease owner records a successful send'
);
select is(
  (select status::text from public.whatsapp_messages
   where id = 'cc111111-1111-4111-8111-111111111111'),
  'sent', 'the CRM message becomes sent'
);
select is(
  (select provider_message_id from public.whatsapp_messages
   where id = 'cc111111-1111-4111-8111-111111111111'),
  'wamid.SYNTHETICSEND0001', 'the provider message id is stored for status callbacks'
);

-- Replaying the same successful acknowledgement is idempotent.
select is(
  (public.record_whatsapp_outbox_result(
     'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-first', true,
     'wamid.SYNTHETICSEND0001') ->> 'changed')::text,
  'false',
  'a replayed successful acknowledgement changes nothing'
);
select throws_ok(
  $$select public.record_whatsapp_outbox_result(
      'ce111111-1111-4111-8111-111111111111', 'whatsapp-worker-impostor', true,
      'wamid.SYNTHETICSEND0001')$$,
  '42501', 'WhatsApp outbox lease is not owned by this worker',
  'a worker that never held the lease cannot replay a success'
);

-- The audit trail records the attempt without contact data or message text.
select ok(
  (select count(*) from public.activity_log
   where outbox_id = 'ce111111-1111-4111-8111-111111111111'
     and event_type = 'outbox.succeeded') > 0,
  'a successful send writes an audit event'
);
select ok(
  not exists (
    select 1 from public.activity_log
    where outbox_id = 'ce111111-1111-4111-8111-111111111111'
      and (metadata::text like '%447700900011%'
           or metadata::text ilike '%queued reply%'
           or metadata::text ilike '%wamid%')
  ),
  'the audit trail records no contact number, message body or provider id'
);

-- ---------------------------------------------------------------------------
-- Bounded retry and dead-lettering
-- ---------------------------------------------------------------------------

-- The "second worker" probe above legitimately leased the remaining job, so it
-- is released here before the retry sequence takes ownership of it.
update public.integration_outbox
set max_attempts = 2,
    status = 'pending',
    leased_by = null,
    leased_at = null,
    lease_expires_at = null,
    next_attempt_at = now() - interval '1 minute'
where id = 'ce333333-3333-4333-8333-333333333333';

create temporary table wa_retry as
select c.outbox_id
from public.claim_whatsapp_outbox_by_id(
  'ce333333-3333-4333-8333-333333333333', 'whatsapp-worker-retry', 120) as c;
select is((select count(*)::int from wa_retry), 1, 'the exact-id claim leases one job');

select is(
  (public.record_whatsapp_outbox_result(
     'ce333333-3333-4333-8333-333333333333', 'whatsapp-worker-retry', false,
     null, 'whatsapp_provider_unavailable') ->> 'status'),
  'failed',
  'the first failure schedules a retry rather than dying'
);
select is(
  (select status::text from public.whatsapp_messages
   where id = 'cc333333-3333-4333-8333-333333333333'),
  'queued',
  'a retryable failure leaves the CRM message queued'
);
select ok(
  (select next_attempt_at > now() from public.integration_outbox
   where id = 'ce333333-3333-4333-8333-333333333333'),
  'a retryable failure backs the job off'
);
select ok(
  (select leased_by is null and leased_at is null and lease_expires_at is null
   from public.integration_outbox where id = 'ce333333-3333-4333-8333-333333333333'),
  'the lease is released on failure'
);

-- Second and final attempt.
update public.integration_outbox
set next_attempt_at = now() - interval '1 minute'
where id = 'ce333333-3333-4333-8333-333333333333';

select is(
  (select count(*)::int from public.claim_whatsapp_outbox_by_id(
     'ce333333-3333-4333-8333-333333333333', 'whatsapp-worker-retry2', 120)),
  1, 'the backed-off job becomes claimable again'
);
select is(
  (public.record_whatsapp_outbox_result(
     'ce333333-3333-4333-8333-333333333333', 'whatsapp-worker-retry2', false,
     null, 'whatsapp_provider_unavailable') ->> 'status'),
  'dead',
  'exhausting max_attempts dead-letters the job'
);
select is(
  (select status::text from public.whatsapp_messages
   where id = 'cc333333-3333-4333-8333-333333333333'),
  'failed',
  'only a terminal failure marks the CRM message failed'
);
select is(
  (select error_code from public.whatsapp_messages
   where id = 'cc333333-3333-4333-8333-333333333333'),
  'whatsapp_provider_unavailable',
  'the terminal failure keeps its safe machine error code'
);
select is(
  (select count(*)::int from public.claim_whatsapp_outbox_by_id(
     'ce333333-3333-4333-8333-333333333333', 'whatsapp-worker-retry3', 120)),
  0, 'a dead job is never claimed again'
);
select ok(
  (select count(*) from public.activity_log
   where outbox_id = 'ce333333-3333-4333-8333-333333333333'
     and event_type = 'outbox.failed'
     and metadata ->> 'dead_letter' = 'true') > 0,
  'dead-lettering is visible in the audit trail'
);

-- ---------------------------------------------------------------------------
-- A job whose artist route is disabled claims as invalid
-- ---------------------------------------------------------------------------

update public.artist_integrations
set is_enabled = false
where id = 'da222222-2222-4222-8222-222222222222';

update public.integration_outbox
set status = 'pending', leased_by = null, leased_at = null,
    lease_expires_at = null, next_attempt_at = now() - interval '1 minute'
where id = 'ce222222-2222-4222-8222-222222222222';

select is(
  (select job_valid from public.claim_whatsapp_outbox_by_id(
     'ce222222-2222-4222-8222-222222222222', 'whatsapp-worker-noroute', 120)),
  false,
  'a job whose artist has no enabled WhatsApp integration is claimed as invalid'
);

select * from finish(true);
rollback;
