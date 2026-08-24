-- 244_deposit_policy_email_chain.sql
--
-- Synthetic-only validation of the client-visible deposit policy chain shipped
-- by 0099. The test uses the ordinary deposit and manual-payment RPCs, never a
-- provider API, and rolls every row back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f9111111-1111-4111-8111-111111111111', 'deposit-chain-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f9111111-1111-4111-8111-111111111111', 'deposit-chain-owner@example.test',
   'Deposit Chain Owner', 'owner', true);

create function pg_temp.as_owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}',
    true)::void;
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

create temporary table t_artist as
select a.id, a.workspace_id
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';
grant select on t_artist to public;

select set_eq(
  $$select purpose from public.message_template_purposes
    where purpose in ('deposit_request','deposit_confirmation')
      and classification = 'service'::public.message_classification$$,
  $$values ('deposit_request'), ('deposit_confirmation')$$,
  'deposit request and confirmation are service-message purposes'
);

select ok(
  exists (select 1 from public.message_template_variables where variable = 'payment_link'),
  'payment_link is a catalogued template variable'
);

select is(
  (select count(*)::int
   from public.message_templates t
   where t.workspace_id = (select workspace_id from t_artist)
     and t.artist_id is null
     and t.purpose in ('deposit_request','deposit_confirmation')
     and t.channel = 'email'
     and t.locale = 'en'
     and t.status = 'active'),
  2,
  'the active workspace has request and confirmation templates'
);

select ok(
  (select bool_and(body like '%within 72 hours of its scheduled start time%'
                   and body like '%deposit is non-refundable%')
   from public.message_templates
   where workspace_id = (select workspace_id from t_artist)
     and purpose in ('deposit_request','deposit_confirmation')
     and status = 'active'),
  'both deposit messages state the same 72-hour cancellation rule'
);

select ok(
  (select body like '%in 72 hours%'
          and body like '%from this point the deposit is non-refundable if you cancel the appointment.%'
   from public.message_templates
   where workspace_id = (select workspace_id from t_artist)
     and purpose = 'session_reminder_72h'
     and status = 'active'),
  'the 72-hour reminder explicitly links back to the disclosed deposit rule'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_messages'
      and column_name = 'payment_request_id'
  ),
  'email messages have explicit payment-request provenance'
);

insert into public.clients (id, full_name, email) values
  ('f9211111-1111-4111-8111-111111111111',
   'Deposit Policy Client', 'deposit-policy-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'f9311111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  (select id from t_artist),
  'PENDING', 'f9411111-1111-4111-8111-111111111111', repeat('f', 64),
  'accepted', 'complete', 'Deposit Policy Client', 'deposit-policy-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'f9511111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'f9311111-1111-4111-8111-111111111111',
  (select id from t_artist),
  'Deposit policy project', 'active', 'GBP'
);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id, appointment_type,
  status, start_at, end_at, title
) values (
  'f9611111-1111-4111-8111-111111111111',
  'f9511111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'f9311111-1111-4111-8111-111111111111',
  (select id from t_artist),
  'tattoo_session', 'confirmed',
  date_trunc('day', now()) + interval '30 days 10 hours',
  date_trunc('day', now()) + interval '30 days 17 hours',
  'Deposit policy appointment'
);

select pg_temp.as_owner();
set local role authenticated;

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      (select id from t_artist),
      'https://monzo.com/pay/r/synthetic-deposit-policy-chain',
      true
    )$$,
  'owner configures the ordinary Monzo deposit route'
);

create temporary table t_request as
select public.request_session_deposit(
  'f9611111-1111-4111-8111-111111111111',
  'f9711111-1111-4111-8111-111111111111',
  'email'
) as result;
grant select on t_request to public;

reset role;

create temporary table t_payment as
select (result ->> 'payment_request_id')::uuid as id,
       (result ->> 'payment_link_id')::uuid as link_id,
       (result ->> 'amount')::numeric as amount
from t_request;
grant select on t_payment to public;

select is((select amount from t_payment), 250::numeric,
  'a seven-hour appointment uses the existing GBP 250 deposit tier');

select is(
  (select count(*)::int
   from public.email_messages m
   where m.payment_request_id = (select id from t_payment)
     and m.template_key = 'deposit_request'),
  1,
  'requesting the deposit creates exactly one request email'
);

select ok(
  (select m.status = 'approved'::public.email_message_status
          and m.created_by_kind = 'system'
          and m.created_by is null
          and m.approved_by is null
          and m.approved_at is not null
          and m.automation_job_id is null
          and m.payment_request_id = (select id from t_payment)
   from public.email_messages m
   where m.payment_request_id = (select id from t_payment)
     and m.template_key = 'deposit_request'),
  'deposit request mail is system-approved only by payment provenance'
);

select ok(
  (select m.body like '%within 72 hours of its scheduled start time%'
          and m.body like '%deposit is non-refundable%'
          and m.body like '%https://vishartattoo.com/pay-by-bank-transfer/%'
          and m.body not like '%{{%'
          and m.subject not like '%{{%'
   from public.email_messages m
   where m.payment_request_id = (select id from t_payment)
     and m.template_key = 'deposit_request'),
  'request email renders the 72-hour rule and the request-specific payment link'
);

select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.email_message_id = (
     select m.id from public.email_messages m
     where m.payment_request_id = (select id from t_payment)
       and m.template_key = 'deposit_request'
   )
     and o.kind = 'approved_email'),
  1,
  'legacy deposit intent is converted to the ordinary approved-email outbox'
);

select is(
  (select count(*)::int
   from public.integration_outbox o
   where o.artist_id = (select id from t_artist)
     and o.client_id = 'f9211111-1111-4111-8111-111111111111'
     and o.kind = 'transactional_email'),
  0,
  'no dead transactional-email row remains for the deposit request'
);

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.request_session_deposit(
      'f9611111-1111-4111-8111-111111111111',
      'f9722222-2222-4222-8222-222222222222',
      'email'
    )$$,
  're-requesting the same pending deposit is safe'
);
reset role;

select is(
  (select count(*)::int from public.email_messages
   where payment_request_id = (select id from t_payment)
     and template_key = 'deposit_request'),
  1,
  're-requesting cannot duplicate the request email'
);
select is(
  (select count(*)::int from public.integration_outbox
   where dedupe_key = 'email:deposit:' || (select id from t_payment)::text || ':request'),
  1,
  're-requesting cannot duplicate the request outbox item'
);

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.record_manual_payment(
      (select id from t_payment),
      'f9811111-1111-4111-8111-111111111111',
      (select amount from t_payment),
      date_trunc('second', now()),
      'deposit_policy_test'
    )$$,
  'ordinary payment recording settles the deposit'
);
reset role;

select is(
  (select status::text from public.payment_requests where id = (select id from t_payment)),
  'paid',
  'the authoritative payment request is paid'
);

select is(
  (select count(*)::int from public.email_messages
   where payment_request_id = (select id from t_payment)
     and template_key = 'deposit_confirmation'),
  1,
  'paid transition creates exactly one confirmation email'
);

select ok(
  (select m.body like '%We have received your £250.00 deposit%'
          and m.body like '%within 72 hours of its scheduled start time%'
          and m.body like '%deposit is non-refundable%'
          and m.body not like '%{{%'
          and m.payment_request_id = (select id from t_payment)
          and m.automation_job_id is null
   from public.email_messages m
   where m.payment_request_id = (select id from t_payment)
     and m.template_key = 'deposit_confirmation'),
  'payment confirmation repeats the same rule and carries payment provenance'
);

select is(
  (select count(*)::int from public.integration_outbox
   where dedupe_key = 'email:deposit:' || (select id from t_payment)::text || ':confirmation'
     and kind = 'approved_email'),
  1,
  'paid confirmation enters the same approved-email delivery path'
);

select pg_temp.as_owner();
set local role authenticated;
select lives_ok(
  $$select public.record_manual_payment(
      (select id from t_payment),
      'f9811111-1111-4111-8111-111111111111',
      (select amount from t_payment),
      date_trunc('second', now()),
      'deposit_policy_test'
    )$$,
  'replaying the same payment is idempotent'
);
reset role;

select is(
  (select count(*)::int from public.email_messages
   where payment_request_id = (select id from t_payment)
     and template_key = 'deposit_confirmation'),
  1,
  'payment replay cannot duplicate confirmation email'
);
select is(
  (select count(*)::int from public.integration_outbox
   where dedupe_key = 'email:deposit:' || (select id from t_payment)::text || ':confirmation'),
  1,
  'payment replay cannot duplicate confirmation outbox item'
);

select throws_ok(
  $$insert into public.email_messages (
      status, artist_id, client_id, project_id, to_email, subject, body,
      template_key, template_version, created_by_kind, approved_at
    ) values (
      'approved', (select id from t_artist),
      'f9211111-1111-4111-8111-111111111111',
      'f9511111-1111-4111-8111-111111111111',
      'deposit-policy-client@example.test', 'Unsafe', 'Unsafe',
      'deposit_request', 1, 'system', now()
    )$$,
  '23514', null,
  'system approval without lifecycle or payment provenance is rejected'
);

select throws_ok(
  $$update public.email_messages
      set automation_job_id = 'f9911111-1111-4111-8111-111111111111'
    where payment_request_id = (select id from t_payment)
      and template_key = 'deposit_confirmation'$$,
  '23514', null,
  'a payment email cannot also claim lifecycle provenance'
);

select * from finish();
rollback;
