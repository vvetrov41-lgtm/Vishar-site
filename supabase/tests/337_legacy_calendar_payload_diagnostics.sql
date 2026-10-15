-- Legacy project bookings must emit the same calendar payload as typed appointments.
begin;
select no_plan();

insert into auth.users (id,email) values
 ('a7311111-1111-4111-8111-111111111111','legacy-calendar-owner@example.test');
insert into public.profiles (id,email,display_name,role,is_active) values
 ('a7311111-1111-4111-8111-111111111111','legacy-calendar-owner@example.test','Legacy Calendar Owner','owner',true);
update public.artist_memberships
set access_level='owner', can_view_finance=true, can_manage_finance=true,
    can_manage_sessions=true, can_manage_integrations=true, is_active=true
where profile_id='a7311111-1111-4111-8111-111111111111'
  and artist_id='a1111111-1111-4111-8111-111111111111';

insert into public.clients (id,full_name,email) values
 ('a7321111-1111-4111-8111-111111111111','Synthetic Legacy Calendar Client','legacy-calendar-client@example.test');
insert into public.projects (id,client_id,artist_id,title,status,currency) values
 ('a7331111-1111-4111-8111-111111111111',
  'a7321111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Legacy calendar payload test','active','GBP');

select set_config('request.jwt.claims',
 '{"sub":"a7311111-1111-4111-8111-111111111111","role":"authenticated"}', true);

create temporary table legacy_confirmed as
select (public.schedule_session(
  'a7331111-1111-4111-8111-111111111111',
  '2027-07-03T11:00:00Z','2027-07-03T18:00:00Z','confirmed','calendar payload regression'
)->>'session_id')::uuid as id;

select is(
 (select o.payload->>'appointment_type' from public.integration_outbox o
  where o.session_id=(select id from legacy_confirmed) and o.kind='calendar_create'),
 'tattoo_session','legacy confirmed booking queues typed calendar payload'
);
select is(
 (select o.payload->>'calendar_version' from public.integration_outbox o
  where o.session_id=(select id from legacy_confirmed) and o.kind='calendar_create'),
 '0','legacy confirmed booking starts at calendar version zero'
);

create temporary table legacy_proposed as
select (public.schedule_session(
  'a7331111-1111-4111-8111-111111111111',
  '2027-07-04T11:00:00Z','2027-07-04T18:00:00Z','proposed','confirm later'
)->>'session_id')::uuid as id;
select is(
 (select count(*)::integer from public.integration_outbox
  where session_id=(select id from legacy_proposed) and kind='calendar_create'),
 0,'proposed booking does not leak into calendar queue'
);
select ok(
 (public.set_session_status((select id from legacy_proposed),'confirmed')->>'changed')::boolean,
 'legacy transition confirms the proposed booking'
);
select is(
 (select o.payload->>'appointment_type' from public.integration_outbox o
  where o.session_id=(select id from legacy_proposed) and o.kind='calendar_create'),
 'tattoo_session','legacy status transition queues typed calendar payload'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
 format(
  'select crm_private.enqueue_outbox(''calendar_create''::public.outbox_kind,''invalid-calendar-contract'',jsonb_build_object(''session_id'',%L::uuid,''calendar_version'',0),null,null,null,%L::uuid)',
  (select id from legacy_confirmed),(select id from legacy_confirmed)
 ),
 '23514','calendar outbox payload does not match the session',
 'the shared enqueue gate rejects missing appointment_type before dispatch'
);
select is(
 (select count(*)::integer from public.integration_outbox where dedupe_key='invalid-calendar-contract'),
 0,'invalid calendar job is never stored'
);

select * from finish();
rollback;
