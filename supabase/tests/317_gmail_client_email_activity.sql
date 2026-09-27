-- 317_gmail_client_email_activity.sql
--
-- Email conversation history is recognised automatically from Gmail metadata
-- and history lookups, without opening a thread in the CRM.

begin;
select no_plan();

select ok(
  has_function_privilege('service_role', 'public.service_list_gmail_mailboxes()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_list_gmail_mailboxes()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_list_gmail_mailboxes()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_list_gmail_history_candidates(uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_list_gmail_history_candidates(uuid,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_record_gmail_client_history(uuid,uuid,timestamptz,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_record_gmail_client_history(uuid,uuid,timestamptz,text)', 'EXECUTE'),
  'the Gmail backend RPCs are service-only'
);

select ok(
  not has_table_privilege('service_role', 'crm_private.gmail_client_email_activity', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.gmail_client_email_activity', 'SELECT'),
  'the durable Gmail activity record is private'
);

select throws_ok(
  $$ select * from public.service_list_gmail_mailboxes() $$,
  '42501', 'Gmail mailbox listing is backend-only',
  'a non-backend caller cannot list mailboxes'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
)
select 'a1111111-1111-4111-8111-111111111111', 'email', 'google', 'google_gmail_vladimir',
  'Studio@Example.test', '{}'::jsonb, true
where not exists (
  select 1 from public.artist_integrations i
  where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
    and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
);

select ok(
  exists (
    select 1 from public.service_list_gmail_mailboxes() m
    where m.artist_id = 'a1111111-1111-4111-8111-111111111111'
      and m.external_account_label = lower(btrim((
        select i.external_account_label from public.artist_integrations i
        where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
          and i.integration_type = 'email'::public.artist_integration_type
          and i.provider = 'google'
        limit 1)))
  ),
  'the backend lists the enabled Gmail mailbox without reading the table directly'
);

update crm_private.booking_card_artist_settings
set email_enabled = true,
    whatsapp_enabled = true,
    whatsapp_consultation_template_name = 'booking_card_consultation_v1',
    whatsapp_tattoo_template_name = 'booking_card_tattoo_v1',
    whatsapp_consultation_template_status = 'APPROVED',
    whatsapp_tattoo_template_status = 'APPROVED',
    appointment_start_from = null
where artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.clients (id, full_name, email, phone) values
  ('ff1a1111-1111-4111-8111-111111111111', 'Email Only Client', 'email-history@example.test', '+447700900601'),
  ('ff1b1111-1111-4111-8111-111111111111', 'Stranger', 'stranger@example.test', '+447700900602'),
  ('ff1c1111-1111-4111-8111-111111111111', 'Snapshot Client', 'snapshot@example.test', '+447700900603');

-- A future appointment makes the email-only client a history candidate.
-- Booked with no conversation in the CRM at all.
insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency
) values
  ('ff6a1111-1111-4111-8111-111111111111', 'ff1a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '70 days 11 hours',
   date_trunc('day', now()) + interval '70 days 11 hours 30 minutes', 0.5, null, 'GBP'),
  ('ff6c1111-1111-4111-8111-111111111111', 'ff1c1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '71 days 11 hours',
   date_trunc('day', now()) + interval '71 days 11 hours 30 minutes', 0.5, null, 'GBP');

select results_eq(
  $$ select x.outcome from crm_private.booking_card_channel_decisions x
     join crm_private.booking_cards b on b.id = x.booking_card_id
     where b.session_id = 'ff6a1111-1111-4111-8111-111111111111' $$,
  $$ values ('no_conversation_channel'::text) $$,
  'before Gmail history is known the card waits'
);

select ok(
  exists (
    select 1 from public.service_list_gmail_history_candidates('a1111111-1111-4111-8111-111111111111', 10) c
    where c.client_id = 'ff1a1111-1111-4111-8111-111111111111'
      and c.client_email = 'email-history@example.test'
  ),
  'a client with an upcoming appointment is a Gmail history candidate'
);

select ok(
  not exists (
    select 1 from public.service_list_gmail_history_candidates('a1111111-1111-4111-8111-111111111111', 10) c
    where c.client_id = 'ff1b1111-1111-4111-8111-111111111111'
  ),
  'a client without an appointment with this artist is not looked up'
);

select throws_ok(
  $$ select public.service_record_gmail_client_history(
       'a1111111-1111-4111-8111-111111111111', 'ff1b1111-1111-4111-8111-111111111111',
       now() - interval '1 day', 'inbound') $$,
  '22023', 'Gmail history target is unavailable',
  'history cannot be recorded for a client the artist does not work with'
);

select throws_ok(
  $$ select public.service_record_gmail_client_history(
       'a1111111-1111-4111-8111-111111111111', 'ff1a1111-1111-4111-8111-111111111111',
       now() - interval '1 day', 'sideways') $$,
  '22023', 'Gmail activity is invalid',
  'only inbound or outbound direction is accepted'
);

-- The worker found an older Gmail conversation for the email-only client.
select lives_ok(
  $$ select public.service_record_gmail_client_history(
       'a1111111-1111-4111-8111-111111111111', 'ff1a1111-1111-4111-8111-111111111111',
       now() - interval '90 days', 'inbound') $$,
  'the backend records the newest Gmail message time for a client'
);

select results_eq(
  $$ select d.channel::text, count(*)::int
     from crm_private.booking_cards b
     join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
     where b.session_id = 'ff6a1111-1111-4111-8111-111111111111'
       and b.superseded_at is null
     group by d.channel $$,
  $$ values ('email'::text, 1) $$,
  'B: the email-only client is recognised and the waiting card goes by Email only'
);

select results_eq(
  $$ select x.channel, x.outcome, x.evidence_source
     from crm_private.booking_card_channel_decisions x
     join crm_private.booking_cards b on b.id = x.booking_card_id
     where b.session_id = 'ff6a1111-1111-4111-8111-111111111111' and b.superseded_at is null $$,
  $$ values ('email'::text, 'selected'::text, 'gmail_metadata'::text) $$,
  'the decision names Gmail as the evidence'
);

select ok(
  not exists (
    select 1 from public.service_list_gmail_history_candidates('a1111111-1111-4111-8111-111111111111', 10) c
    where c.client_id = 'ff1a1111-1111-4111-8111-111111111111'
  ),
  'a checked client is not looked up again the same day'
);

-- An older result never replaces a newer one.
select public.service_record_gmail_client_history(
  'a1111111-1111-4111-8111-111111111111', 'ff1a1111-1111-4111-8111-111111111111',
  now() - interval '200 days', 'outbound');

select ok(
  (select last_message_at > now() - interval '91 days' and last_direction = 'inbound'
   from crm_private.gmail_client_email_activity
   where client_id = 'ff1a1111-1111-4111-8111-111111111111'),
  'the durable record keeps the newest message'
);

-- The 30-day snapshot feeds the durable record and survives its cleanup.
insert into public.gmail_client_metadata_snapshots (
  artist_id, client_id, subject, last_message_at, direction, refreshed_at
) values (
  'a1111111-1111-4111-8111-111111111111', 'ff1c1111-1111-4111-8111-111111111111',
  'Tattoo', now() - interval '2 days', 'outbound', now()
);

select results_eq(
  $$ select d.channel::text, count(*)::int
     from crm_private.booking_cards b
     join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
     where b.session_id = 'ff6c1111-1111-4111-8111-111111111111'
       and b.superseded_at is null
     group by d.channel $$,
  $$ values ('email'::text, 1) $$,
  'a Gmail snapshot row makes the client an Email conversation automatically'
);

delete from public.gmail_client_metadata_snapshots
where client_id = 'ff1c1111-1111-4111-8111-111111111111';

select ok(
  exists (
    select 1 from crm_private.gmail_client_email_activity
    where client_id = 'ff1c1111-1111-4111-8111-111111111111'
      and last_message_at is not null
  ),
  'the Email evidence survives the snapshot forgetting the client'
);

select ok(
  (select count(*) = 0 from crm_private.gmail_client_email_activity a
   where a.client_id in ('ff1a1111-1111-4111-8111-111111111111', 'ff1c1111-1111-4111-8111-111111111111')
     and a.last_direction not in ('inbound', 'outbound')),
  'only direction and time are stored'
);

select * from finish(true);
rollback;
