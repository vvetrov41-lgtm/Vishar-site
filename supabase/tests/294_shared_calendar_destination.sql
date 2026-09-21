-- 294_shared_calendar_destination.sql
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.artists (id, slug, display_name, is_active)
values ('a2940000-0000-4000-8000-000000000001', 'shared-target-fixture', 'Shared Target Fixture', true);

set local role service_role;
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a2940000-0000-4000-8000-000000000001',
    'google_calendar_shared-target-fixture',
    'shared-target-fixture@example.test',
    true
  )$$,
  'a new artist still defaults to its own primary calendar'
);
reset role;

select is(
  (
    select configuration ->> 'calendar_id'
    from public.artist_integrations
    where artist_id = 'a2940000-0000-4000-8000-000000000001'
      and integration_type = 'calendar'
  ),
  'primary',
  'new artists default to primary until server configuration chooses another destination'
);

update public.artist_integrations
set configuration = configuration
  || jsonb_build_object(
       'calendar_id', 'shared-fixture@group.calendar.google.com',
       'destination_event_label_id', '0df5fe2d-13a3-42ae-8e07-8dc2c62c97a1'
     )
where artist_id = 'a2940000-0000-4000-8000-000000000001'
  and integration_type = 'calendar';

set local role service_role;
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a2940000-0000-4000-8000-000000000001',
    'google_calendar_shared-target-fixture',
    'shared-target-fixture@example.test',
    true
  )$$,
  'reconnect preserves a server-owned shared destination'
);
reset role;

select is(
  (
    select configuration ->> 'calendar_id'
    from public.artist_integrations
    where artist_id = 'a2940000-0000-4000-8000-000000000001'
      and integration_type = 'calendar'
  ),
  'shared-fixture@group.calendar.google.com',
  'reconnect does not silently reset the destination to primary'
);

select is(
  (
    select configuration ->> 'destination_event_label_id'
    from public.artist_integrations
    where artist_id = 'a2940000-0000-4000-8000-000000000001'
      and integration_type = 'calendar'
  ),
  '0df5fe2d-13a3-42ae-8e07-8dc2c62c97a1',
  'destination-specific event label metadata survives reconnect'
);

select * from finish();
rollback;
