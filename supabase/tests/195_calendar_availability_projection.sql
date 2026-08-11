-- 195_calendar_availability_projection.sql
--
-- Calendar projection for artist Availability / Time Off remains durable,
-- artist-scoped, versioned and provider-inert inside the database. No provider
-- credential or Time Off note is allowed into the outbox projection.

begin;
select no_plan();

select ok(
  position('calendar_availability_create' in enum_range(null::public.outbox_kind)::text) > 0,
  'outbox kind includes calendar_availability_create'
);
select ok(
  position('calendar_availability_update' in enum_range(null::public.outbox_kind)::text) > 0,
  'outbox kind includes calendar_availability_update'
);
select ok(
  position('calendar_availability_cancel' in enum_range(null::public.outbox_kind)::text) > 0,
  'outbox kind includes calendar_availability_cancel'
);
select has_column(
  'public', 'artist_availability_blocks', 'calendar_version',
  'availability blocks carry an independent Calendar projection version'
);
select has_column(
  'public', 'artist_availability_blocks', 'calendar_event_id',
  'availability blocks retain provider event identity'
);
select has_column(
  'public', 'integration_outbox', 'availability_block_id',
  'integration outbox carries an explicit Time Off identity'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_calendar_availability_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'service backend may lease Time Off Calendar jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'service backend may acknowledge Time Off Calendar jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_calendar_availability_outbox(text,integer,integer)',
    'EXECUTE'
  ),
  'CRM browser cannot lease Time Off Calendar jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_calendar_availability_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'CRM browser cannot acknowledge Time Off Calendar jobs'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f9111111-1111-4111-8111-111111111111', 'availability-calendar-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f9111111-1111-4111-8111-111111111111', 'availability-calendar-manager@example.test',
   'Availability Calendar Manager', 'booking_manager', true);

-- Calendar integration management is deliberately false. Managing Time Off is
-- a scheduling capability, not a credential-management capability.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f9111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('f9111111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222',
   'manager', false, false, true, false, true);

create function pg_temp.calendar_availability_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.calendar_availability_claims(text)
  to authenticated, service_role;

-- Configure synthetic provider metadata before blocks exist. This exercises the
-- exact Vladimir/Kristina route keys without creating reconciliation jobs yet.
select public.set_calendar_connection_metadata(
  'a1111111-1111-4111-8111-111111111111',
  'google_calendar_vladimir',
  'vladimir-calendar@example.test',
  true
);
select public.set_calendar_connection_metadata(
  'a2222222-2222-4222-8222-222222222222',
  'google_calendar_kristina',
  'kristina-calendar@example.test',
  true
);

set local role authenticated;
select pg_temp.calendar_availability_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table vladimir_block as
select public.create_artist_availability_block(
  'a1111111-1111-4111-8111-111111111111',
  'holiday',
  '2026-10-23T23:00:00Z',
  '2026-10-28T00:00:00Z',
  true,
  'Private synthetic note that must stay inside CRM'
) as result;
grant select on vladimir_block to authenticated, service_role;

select is(
  (select (result ->> 'calendar_version')::integer from vladimir_block),
  0,
  'new Time Off begins at projection version zero'
);
select is(
  (select result ->> 'calendar_operation' from vladimir_block),
  'create',
  'new Time Off reports a create projection operation'
);

reset role;
select pg_temp.calendar_availability_claims('{"role":"service_role"}');

select is(
  (select count(*)::integer
   from public.integration_outbox o
   where o.availability_block_id =
     (select (result ->> 'availability_block_id')::uuid from vladimir_block)
     and o.kind = 'calendar_availability_create'
     and o.session_id is null),
  1,
  'new Time Off queues exactly one explicit availability create job'
);
select is(
  (select payload ->> 'calendar_version'
   from public.integration_outbox o
   where o.availability_block_id =
     (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  '0',
  'outbox payload carries only the projection version'
);
select ok(
  not exists (
    select 1
    from public.integration_outbox o
    where o.availability_block_id =
      (select (result ->> 'availability_block_id')::uuid from vladimir_block)
      and o.payload::text ilike '%Private synthetic note%'
  ),
  'Time Off note is absent from the provider outbox payload'
);

create temporary table vladimir_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-pgtap', 1, 120
);
grant select on vladimir_claim to authenticated, service_role;

select is(
  (select artist_timezone from vladimir_claim),
  'Europe/London',
  'lease returns the authoritative artist timezone for DST-safe projection'
);
select ok(
  (select job_valid from vladimir_claim),
  'new Time Off create lease is valid'
);
select ok(
  not (select obsolete from vladimir_claim),
  'current Time Off create lease is not obsolete'
);
select is(
  (select integration_key
   from public.resolve_outbox_route((select outbox_id from vladimir_claim))),
  'google_calendar_vladimir',
  'Vladimir Time Off resolves only to Vladimir Calendar metadata'
);

select public.record_calendar_availability_outbox_result(
  (select outbox_id from vladimir_claim),
  'calendar-availability-worker-pgtap',
  0,
  true,
  'synthetic-vladimir-time-off-event',
  null
);

select is(
  (select calendar_sync_status::text
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  'synced',
  'successful create acknowledgement marks Time Off synced'
);
select is(
  (select calendar_event_id
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  'synthetic-vladimir-time-off-event',
  'provider event identity is stored only after successful acknowledgement'
);

reset role;
set local role authenticated;
select pg_temp.calendar_availability_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select is(
  (public.update_artist_availability_block(
    (select (result ->> 'availability_block_id')::uuid from vladimir_block),
    'personal',
    '2026-10-23T23:00:00Z',
    '2026-10-29T00:00:00Z',
    true,
    'Updated private note'
  ) ->> 'calendar_version')::integer,
  1,
  'editing Time Off increments its projection version'
);

reset role;
select pg_temp.calendar_availability_claims('{"role":"service_role"}');

create temporary table vladimir_update_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-update', 1, 120
);
grant select on vladimir_update_claim to authenticated, service_role;

select is(
  (select kind::text from vladimir_update_claim),
  'calendar_availability_update',
  'a block with a provider event queues an explicit update'
);

select public.record_calendar_availability_outbox_result(
  (select outbox_id from vladimir_update_claim),
  'calendar-availability-worker-update',
  1,
  false,
  null,
  'calendar_provider_unavailable'
);
select is(
  (select status::text
   from public.integration_outbox
   where id = (select outbox_id from vladimir_update_claim)),
  'failed',
  'transient provider failure remains retryable'
);
select is(
  (select calendar_sync_status::text
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  'failed',
  'current Time Off exposes a safe failed projection state'
);

update public.integration_outbox
set next_attempt_at = now()
where id = (select outbox_id from vladimir_update_claim);

create temporary table vladimir_retry_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-retry', 1, 120
);
grant select on vladimir_retry_claim to authenticated, service_role;

select public.record_calendar_availability_outbox_result(
  (select outbox_id from vladimir_retry_claim),
  'calendar-availability-worker-retry',
  1,
  true,
  'synthetic-vladimir-time-off-event',
  null
);
select is(
  (select calendar_last_synced_version
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  1,
  'retry success acknowledges exactly the current Time Off version'
);

reset role;
set local role authenticated;
select pg_temp.calendar_availability_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select is(
  (public.cancel_artist_availability_block(
    (select (result ->> 'availability_block_id')::uuid from vladimir_block)
  ) ->> 'calendar_version')::integer,
  2,
  'cancelling Time Off increments the projection version'
);

reset role;
select pg_temp.calendar_availability_claims('{"role":"service_role"}');

create temporary table vladimir_cancel_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-cancel', 1, 120
);
grant select on vladimir_cancel_claim to authenticated, service_role;
select is(
  (select kind::text from vladimir_cancel_claim),
  'calendar_availability_cancel',
  'cancel queues deterministic provider deletion'
);
select public.record_calendar_availability_outbox_result(
  (select outbox_id from vladimir_cancel_claim),
  'calendar-availability-worker-cancel',
  2,
  true,
  null,
  null
);
select is(
  (select calendar_sync_status::text
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  'not_connected',
  'successful provider deletion closes Time Off projection state'
);
select is(
  (select calendar_event_id
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from vladimir_block)),
  null,
  'successful provider deletion clears event identity'
);

-- Stale-result protection on Kristina: update before the original create is
-- claimed, then retire the old version without touching the current block.
reset role;
set local role authenticated;
select pg_temp.calendar_availability_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table kristina_block as
select public.create_artist_availability_block(
  'a2222222-2222-4222-8222-222222222222',
  'day_off',
  '2026-11-10T00:00:00Z',
  '2026-11-11T00:00:00Z',
  true,
  null
) as result;
grant select on kristina_block to authenticated, service_role;

select public.update_artist_availability_block(
  (select (result ->> 'availability_block_id')::uuid from kristina_block),
  'holiday',
  '2026-11-10T00:00:00Z',
  '2026-11-12T00:00:00Z',
  true,
  null
);

reset role;
select pg_temp.calendar_availability_claims('{"role":"service_role"}');

create temporary table kristina_stale_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-stale', 1, 120
);
grant select on kristina_stale_claim to authenticated, service_role;
select ok(
  (select obsolete from kristina_stale_claim),
  'older Kristina Time Off job is leased as obsolete rather than sent'
);
select public.record_calendar_availability_outbox_result(
  (select outbox_id from kristina_stale_claim),
  'calendar-availability-worker-stale',
  (select calendar_version from kristina_stale_claim),
  true,
  null,
  null
);
select is(
  (select calendar_version
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from kristina_block)),
  1,
  'stale acknowledgement never rewinds Kristina Time Off version'
);

create temporary table kristina_current_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-kristina', 1, 120
);
grant select on kristina_current_claim to authenticated, service_role;
select is(
  (select integration_key
   from public.resolve_outbox_route((select outbox_id from kristina_current_claim))),
  'google_calendar_kristina',
  'Kristina Time Off resolves only to Kristina Calendar metadata'
);
select public.record_calendar_availability_outbox_result(
  (select outbox_id from kristina_current_claim),
  'calendar-availability-worker-kristina',
  1,
  true,
  'synthetic-kristina-time-off-event',
  null
);

-- Reconnection recovery creates a new version instead of retrying the same
-- terminal dedupe key.
select public.set_calendar_connection_metadata(
  'a2222222-2222-4222-8222-222222222222',
  'google_calendar_kristina',
  'kristina-calendar@example.test',
  false
);

reset role;
set local role authenticated;
select pg_temp.calendar_availability_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
create temporary table disconnected_block as
select public.create_artist_availability_block(
  'a2222222-2222-4222-8222-222222222222',
  'personal',
  '2026-12-01T10:00:00Z',
  '2026-12-01T13:00:00Z',
  false,
  null
) as result;
grant select on disconnected_block to authenticated, service_role;

reset role;
select pg_temp.calendar_availability_claims('{"role":"service_role"}');
create temporary table disconnected_claim as
select * from public.claim_calendar_availability_outbox(
  'calendar-availability-worker-disconnected', 1, 120
);
grant select on disconnected_claim to authenticated, service_role;
select public.record_calendar_availability_outbox_result(
  (select outbox_id from disconnected_claim),
  'calendar-availability-worker-disconnected',
  0,
  false,
  null,
  'artist_route_unconfigured'
);
select is(
  (select status::text
   from public.integration_outbox
   where id = (select outbox_id from disconnected_claim)),
  'dead',
  'missing artist route is terminal for that exact projection version'
);

create temporary table reconnect_result as
select public.set_calendar_connection_metadata(
  'a2222222-2222-4222-8222-222222222222',
  'google_calendar_kristina',
  'kristina-calendar@example.test',
  true
) as result;
grant select on reconnect_result to authenticated, service_role;
select ok(
  (select (result ->> 'reconciled_availability_jobs')::integer from reconnect_result) >= 1,
  'reconnecting Kristina queues recovery for unsynced Time Off'
);
select is(
  (select calendar_version
   from public.artist_availability_blocks
   where id = (select (result ->> 'availability_block_id')::uuid from disconnected_block)),
  1,
  'reconnection recovery uses a fresh Time Off projection version'
);
select is(
  (select count(*)::integer
   from public.integration_outbox
   where availability_block_id =
     (select (result ->> 'availability_block_id')::uuid from disconnected_block)
     and kind = 'calendar_availability_create'
     and (payload ->> 'calendar_version')::integer = 1
     and status = 'pending'),
  1,
  'reconnection creates one new deduped recovery job'
);

select * from finish();
rollback;
