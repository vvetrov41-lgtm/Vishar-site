-- 1000_telegram_enquiry_dead_letter_self_heal.sql
--
-- Contract for bounded automatic recovery of new-enquiry Telegram dead letters.
-- The scheduler may retry only the narrow, currently-eligible failure class and
-- each outbox id may be auto-recovered at most once.

begin;
select no_plan();

select has_table(
  'crm_private',
  'telegram_enquiry_recovery_marks',
  'one-shot Telegram enquiry recovery marks exist'
);

select col_is_pk(
  'crm_private',
  'telegram_enquiry_recovery_marks',
  'outbox_id',
  'each Telegram enquiry outbox id can be auto-recovered at most once'
);

select has_function(
  'public',
  'service_recover_telegram_enquiry_outbox_batch',
  array['integer'],
  'bounded Telegram enquiry dead-letter recovery sweep exists'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%service_recover_telegram_enquiry_outbox%',
  'automatic recovery delegates to the single-job safety gate'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%telegram_destination_unavailable%',
  'automatic recovery is limited to destination-unavailable dead letters'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%telegram_enquiry_recovery_marks%',
  'automatic recovery is protected by a durable one-shot mark'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%telegram_notification_recipient_eligible%',
  'automatic recovery requires current effective Telegram eligibility'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%outbox.succeeded%'
  and pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%enquiry.created%',
  'automatic recovery checks both durable outbox and notification delivery evidence'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%7 days%',
  'automatic recovery refuses stale historical dead letters'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox_batch(integer)'::regprocedure
  ) ilike '%skip locked%',
  'automatic recovery is concurrency-safe and non-blocking'
);

select ok(
  pg_get_functiondef(
    'public.claim_telegram_outbox(text,integer,integer)'::regprocedure
  ) ilike '%service_recover_telegram_enquiry_outbox_batch%',
  'the existing scheduled claim invokes the bounded recovery sweep'
);

select ok(
  pg_get_functiondef(
    'public.claim_telegram_outbox(text,integer,integer)'::regprocedure
  ) ilike '%outbox_drain_rollouts%',
  'automatic claim retains the rollout cutoff boundary'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.service_recover_telegram_enquiry_outbox_batch(integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot run Telegram recovery'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.service_recover_telegram_enquiry_outbox_batch(integer)',
    'EXECUTE'
  ),
  'browser-authenticated callers cannot run Telegram recovery'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.service_recover_telegram_enquiry_outbox_batch(integer)',
    'EXECUTE'
  ),
  'the batch helper is internal-only; service role enters through claim_telegram_outbox'
);

-- The migration/test owner can still exercise the helper directly while the
-- request JWT proves that its own backend guard remains fail-closed.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select * from public.service_recover_telegram_enquiry_outbox_batch(10)$$,
  '42501',
  'Telegram enquiry recovery sweep is backend-only',
  'recovery refuses a non-service JWT even when invoked by the function owner'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.service_recover_telegram_enquiry_outbox_batch(0)$$,
  '22023',
  'Telegram enquiry recovery limit must be between 1 and 20',
  'recovery limit fails closed below its bounded range'
);

select throws_ok(
  $$select * from public.service_recover_telegram_enquiry_outbox_batch(21)$$,
  '22023',
  'Telegram enquiry recovery limit must be between 1 and 20',
  'recovery limit fails closed above its bounded range'
);

select * from finish(true);
rollback;
