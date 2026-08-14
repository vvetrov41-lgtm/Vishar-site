-- 194_artist_availability_time_off.sql
--
-- Artist availability is a database-authoritative scheduling boundary. Direct
-- table access remains closed, management follows can_manage_sessions, and the
-- block applies to both current appointment RPCs and legacy session wrappers.

begin;
select no_plan();

select has_type('public', 'availability_block_kind', 'availability block kind enum exists');
select is(
  (select enum_range(null::public.availability_block_kind)::text),
  '{day_off,holiday,personal,other}',
  'availability block kind vocabulary is closed and ordered'
);
select has_table('public', 'artist_availability_blocks', 'artist availability table exists');
select has_column('public', 'artist_availability_blocks', 'cancelled_at', 'availability blocks soft-cancel');

select ok(
  has_function_privilege(
    'authenticated',
    'public.list_artist_availability_blocks(uuid,timestamptz,timestamptz,boolean)',
    'EXECUTE'
  ),
  'authenticated CRM sessions may list artist availability through the protected RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)',
    'EXECUTE'
  ),
  'authenticated CRM sessions may call the protected availability create RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)',
    'EXECUTE'
  ),
  'authenticated CRM sessions may call the protected availability update RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.cancel_artist_availability_block(uuid)',
    'EXECUTE'
  ),
  'authenticated CRM sessions may call the protected availability cancel RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)',
    'EXECUTE'
  ),
  'anonymous callers cannot create availability blocks'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)',
    'EXECUTE'
  ),
  'service role is not an artist availability manager'
);
select ok(
  not has_table_privilege('authenticated', 'public.artist_availability_blocks', 'SELECT'),
  'authenticated users have no direct availability table read privilege'
);
select ok(
  not has_table_privilege('authenticated', 'public.artist_availability_blocks', 'INSERT'),
  'authenticated users have no direct availability table insert privilege'
);
select ok(
  not has_table_privilege('authenticated', 'public.artist_availability_blocks', 'UPDATE'),
  'authenticated users have no direct availability table update privilege'
);
select ok(
  not has_table_privilege('authenticated', 'public.artist_availability_blocks', 'DELETE'),
  'authenticated users have no direct availability table delete privilege'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e8111111-1111-4111-8111-111111111111', 'availability-manager@example.test'),
  ('e8122222-2222-4222-8222-222222222222', 'availability-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('e8111111-1111-4111-8111-111111111111', 'availability-manager@example.test',
   'Availability Manager', 'booking_manager', true),
  ('e8122222-2222-4222-8222-222222222222', 'availability-reader@example.test',
   'Availability Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e8111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('e8111111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222',
   'manager', false, false, true, false, true),
  ('e8122222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.availability_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.availability_claims(text)
  to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('e8211111-1111-4111-8111-111111111111', 'Availability Client', 'availability-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e8311111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e8411111-1111-4111-8111-111111111111', repeat('e', 64),
  'accepted', 'complete', 'Availability Client',
  'availability-client@example.test', '2026-07-29', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'e8511111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'e8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Availability compatibility project', 'active', 'GBP'
);

set local role authenticated;
select pg_temp.availability_claims(
  '{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table availability_result as
select public.create_artist_availability_block(
  'a1111111-1111-4111-8111-111111111111',
  'holiday',
  '2026-10-01T00:00:00Z',
  '2026-10-04T00:00:00Z',
  true,
  'Synthetic holiday'
) as result;
grant select on availability_result to authenticated, service_role;

select is(
  (select (result ->> 'changed')::boolean from availability_result),
  true,
  'manager creates an artist-scoped availability block'
);
select is(
  (select count(*)::int
   from public.list_artist_availability_blocks(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', false
   )),
  1,
  'availability read RPC returns the active block in range'
);
select is(
  (select count(*)::int
   from public.list_artist_availability_blocks(
     'a2222222-2222-4222-8222-222222222222',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', false
   )),
  0,
  'Vladimir availability does not leak into Kristina artist scope'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a2222222-2222-4222-8222-222222222222',
      'e8211111-1111-4111-8111-111111111111',
      'video_consultation',
      '2026-10-02T10:00:00Z', '2026-10-02T10:30:00Z',
      'proposed', null, null, 'Synthetic Kristina isolation appointment'
    )$$,
  'another artist can use the same clock time'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'e8211111-1111-4111-8111-111111111111',
      'video_consultation',
      '2026-10-02T10:00:00Z', '2026-10-02T10:30:00Z',
      'proposed', null, null, 'Blocked appointment'
    )$$,
  '22023', null,
  'proposed appointments are hard-rejected inside time off'
);

create temporary table blocked_draft as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'video_consultation',
  '2026-10-02T11:00:00Z', '2026-10-02T11:30:00Z',
  'draft', null, null, 'Draft inside time off'
) as result;
grant select on blocked_draft to authenticated, service_role;

select throws_ok(
  format(
    $$select public.set_appointment_status(%L, 'proposed')$$,
    (select result ->> 'appointment_id' from blocked_draft)
  ),
  '22023', null,
  'a draft inside time off cannot become proposed'
);

create temporary table movable_appointment as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'video_consultation',
  '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z',
  'proposed', null, null, 'Movable appointment'
) as result;
grant select on movable_appointment to authenticated, service_role;

select throws_ok(
  format(
    $$select public.reschedule_appointment(%L, '2026-10-02T12:00:00Z', '2026-10-02T12:30:00Z')$$,
    (select result ->> 'appointment_id' from movable_appointment)
  ),
  '22023', null,
  'an active appointment cannot be rescheduled into time off'
);

select throws_ok(
  $$select public.schedule_session(
      'e8511111-1111-4111-8111-111111111111',
      '2026-10-02T09:00:00Z', '2026-10-02T16:00:00Z',
      'proposed', 'Legacy blocked session'
    )$$,
  '22023', null,
  'legacy schedule_session cannot bypass availability'
);

select throws_ok(
  $$select public.create_artist_availability_block(
      'a1111111-1111-4111-8111-111111111111',
      'day_off',
      '2026-10-05T09:00:00Z', '2026-10-05T18:00:00Z',
      false, 'Would cover active appointment'
    )$$,
  '22023', null,
  'time off cannot silently cover an existing active appointment'
);

select throws_ok(
  $$select public.create_artist_availability_block(
      'a1111111-1111-4111-8111-111111111111',
      'personal',
      '2026-10-03T09:00:00Z', '2026-10-03T12:00:00Z',
      false, 'Overlapping block'
    )$$,
  '22023', null,
  'active availability blocks cannot overlap each other'
);

select lives_ok(
  format(
    $$select public.update_artist_availability_block(
        %L, 'personal',
        '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z',
        true, 'Synthetic updated holiday'
      )$$,
    (select result ->> 'availability_block_id' from availability_result)
  ),
  'manager may edit an active availability block'
);

select is(
  (select block_kind::text
   from public.list_artist_availability_blocks(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', false
   ) limit 1),
  'personal',
  'availability update is visible through the protected read RPC'
);

select pg_temp.availability_claims(
  '{"sub":"e8122222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  (select count(*)::int
   from public.list_artist_availability_blocks(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', false
   )),
  1,
  'read-only staff with artist access may read availability'
);
select throws_ok(
  $$select public.create_artist_availability_block(
      'a1111111-1111-4111-8111-111111111111',
      'day_off',
      '2026-10-10T09:00:00Z', '2026-10-10T17:00:00Z',
      false, null
    )$$,
  '42501', null,
  'read-only staff cannot manage availability'
);

select pg_temp.availability_claims(
  '{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  format(
    $$select public.cancel_artist_availability_block(%L)$$,
    (select result ->> 'availability_block_id' from availability_result)
  ),
  'manager may soft-cancel an availability block'
);
select is(
  (select count(*)::int
   from public.list_artist_availability_blocks(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', false
   )),
  0,
  'cancelled time off no longer blocks the active availability view'
);
select is(
  (select count(*)::int
   from public.list_artist_availability_blocks(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z', true
   )),
  1,
  'cancelled time off remains available to an explicit audit-oriented read'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'e8211111-1111-4111-8111-111111111111',
      'video_consultation',
      '2026-10-02T14:00:00Z', '2026-10-02T14:30:00Z',
      'proposed', null, null, 'Allowed after block cancellation'
    )$$,
  'cancelling time off makes the interval schedulable again'
);

reset role;
select pg_temp.availability_claims('{"role":"service_role"}');

select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'availability.block_created'
     and actor_profile_id = 'e8111111-1111-4111-8111-111111111111'),
  1,
  'availability creation is audited once'
);
select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'availability.block_updated'
     and actor_profile_id = 'e8111111-1111-4111-8111-111111111111'),
  1,
  'availability update is audited once'
);
select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'availability.block_cancelled'
     and actor_profile_id = 'e8111111-1111-4111-8111-111111111111'),
  1,
  'availability cancellation is audited once'
);
select is(
  (select count(*)::int
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from availability_result)
     and cancelled_at is not null),
  1,
  'soft-cancelled block remains in the authoritative table'
);

select * from finish();
rollback;
