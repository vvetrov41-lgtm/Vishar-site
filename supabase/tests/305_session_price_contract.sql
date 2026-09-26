-- 305_session_price_contract.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'authenticated',
    'public.set_appointment_price(uuid,numeric)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.set_appointment_price(uuid,numeric)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.set_appointment_price(uuid,numeric)',
    'EXECUTE'
  ),
  'only signed-in CRM operators can enter an appointment price'
);

insert into auth.users (id, email) values
  ('f7111111-1111-4111-8111-111111111111', 'price-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f7111111-1111-4111-8111-111111111111', 'price-manager@example.test',
   'Price Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'f7111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manager', true, true, true, false, true
);

insert into public.clients (id, full_name, email) values (
  'f7211111-1111-4111-8111-111111111111',
  'Price Contract Client',
  'price-contract@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'f7311111-1111-4111-8111-111111111111',
  'f7211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-9711',
  'f7411111-1111-4111-8111-111111111111',
  repeat('7', 64),
  'accepted', 'complete', 'Price Contract Client',
  'price-contract@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'f7511111-1111-4111-8111-111111111111',
  'f7211111-1111-4111-8111-111111111111',
  'f7311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Price contract project', 'active', 'GBP'
);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, currency
) values
(
  'f7611111-1111-4111-8111-111111111111',
  'f7511111-1111-4111-8111-111111111111',
  'f7211111-1111-4111-8111-111111111111',
  'f7311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'tattoo_session', 'proposed',
  now() + interval '20 days', now() + interval '20 days 7 hours',
  7, 'GBP'
),
(
  'f7622222-2222-4222-8222-222222222222',
  null,
  'f7211111-1111-4111-8111-111111111111',
  null,
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation', 'proposed',
  now() + interval '21 days', now() + interval '21 days 30 minutes',
  0.5, 'GBP'
);

create function pg_temp.price_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.price_claims(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.price_claims(
  '{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select is(
  public.set_appointment_price(
    'f7611111-1111-4111-8111-111111111111',
    980.00
  ) ->> 'changed',
  'true',
  'a finance manager can set the exact tattoo session price'
);

select is(
  (select price from public.sessions
   where id = 'f7611111-1111-4111-8111-111111111111'),
  980.00::numeric,
  'the exact price is stored on the session'
);

select throws_ok(
  $$ select public.set_appointment_price(
    'f7622222-2222-4222-8222-222222222222',
    50.00
  ) $$,
  '23514', null,
  'a consultation cannot acquire a price'
);

select throws_ok(
  $$ select public.set_appointment_price(
    'f7611111-1111-4111-8111-111111111111',
    980.001
  ) $$,
  '22023', null,
  'session price has at most two decimal places'
);

create temporary table priced_booking_result (payload jsonb);
grant insert, select on priced_booking_result to authenticated;

insert into priced_booking_result(payload)
select public.schedule_appointment_with_price(
  'a1111111-1111-4111-8111-111111111111',
  'f7211111-1111-4111-8111-111111111111',
  'tattoo_session',
  now() + interval '60 days',
  now() + interval '60 days 7 hours',
  'proposed',
  'f7311111-1111-4111-8111-111111111111',
  'f7511111-1111-4111-8111-111111111111',
  null,
  910.00
);

select is(
  (select s.price
   from public.sessions s
   where s.id = (
     select (payload ->> 'appointment_id')::uuid
     from priced_booking_result
   )),
  910.00::numeric,
  'booking with an explicit price stores appointment and price atomically'
);

select is(
  (select payload ->> 'price' from priced_booking_result),
  '910.00',
  'priced booking response reports the stored explicit price'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.schedule_appointment_with_price(uuid,uuid,appointment_type,timestamptz,timestamptz,session_status,uuid,uuid,text,numeric)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.schedule_appointment_with_price(uuid,uuid,appointment_type,timestamptz,timestamptz,session_status,uuid,uuid,text,numeric)',
    'EXECUTE'
  ),
  'priced booking is available only to a signed-in CRM operator'
);

reset role;

select is(
  (select count(*)::int
   from public.activity_log
   where session_id = 'f7611111-1111-4111-8111-111111111111'
     and event_type = 'appointment.price_changed'),
  1,
  'price changes are audited'
);

select * from finish(true);
rollback;
