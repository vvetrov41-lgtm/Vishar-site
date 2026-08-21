-- 227_hosted_booking_forms.sql
--
-- Migration 0079: external and hosted booking sources have separate transport
-- authority, CRM creation is capability-scoped, and hosted intake still lands
-- in the same durable artist-scoped enquiry pipeline.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Shape, defaults and ACL
-- ---------------------------------------------------------------------------

select has_column('public', 'booking_sources', 'source_kind',
                  'booking sources expose an explicit source kind');
select has_column('public', 'booking_sources', 'display_label',
                  'booking sources carry a bounded presentation label');
select has_column('public', 'booking_sources', 'form_template',
                  'booking sources carry an allow-listed form template');

select is(
  (select source_kind from public.booking_sources where source_key = 'vladimir-website'),
  'external',
  'existing website sources are backfilled as external'
);
select is(
  (select form_template from public.booking_sources where source_key = 'vladimir-website'),
  'tattoo-enquiry',
  'existing website sources are backfilled onto the supported template'
);

select ok(
  has_function_privilege('service_role', 'public.resolve_hosted_booking_source(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.resolve_hosted_booking_source(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_hosted_booking_source(uuid)', 'EXECUTE'),
  'hosted public-page resolution is backend-only'
);
select ok(
  has_function_privilege('service_role', 'public.create_hosted_enquiry_intake(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.create_hosted_enquiry_intake(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_hosted_enquiry_intake(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'hosted durable intake is backend-only'
);
select ok(
  has_function_privilege('authenticated', 'public.list_booking_sources(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_booking_source(uuid,text,text,text,text,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.update_booking_source(uuid,text,text,boolean)', 'EXECUTE'),
  'the CRM receives only named booking-source management RPCs'
);
select ok(
  not has_table_privilege('authenticated', 'public.booking_sources', 'INSERT')
  and not has_table_privilege('authenticated', 'public.booking_sources', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.booking_sources', 'DELETE'),
  'self-service booking sources do not introduce direct browser table writes'
);

-- ---------------------------------------------------------------------------
-- One manager may manage only the artist membership they actually hold
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('97111111-1111-4111-8111-111111111111', 'hosted-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('97111111-1111-4111-8111-111111111111',
   'hosted-manager@example.test', 'Hosted Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '97111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manager', false, false, true, true, true
);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

create temporary table t_hosted (
  id uuid,
  public_source_id uuid
);
grant select, insert, update on t_hosted to authenticated, service_role;

set local role authenticated;
select pg_temp.claims(
  '{"sub":"97111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

insert into t_hosted(id)
select public.create_booking_source(
  'a1111111-1111-4111-8111-111111111111',
  'hosted',
  'Vladimir hosted booking form',
  null,
  'tattoo-enquiry',
  true
);

select is(
  (select count(*)::int from public.list_booking_sources('a1111111-1111-4111-8111-111111111111')
   where source_kind = 'hosted' and display_label = 'Vladimir hosted booking form'),
  1,
  'the manager can list the hosted source they created for their artist'
);

select alike(
  (select public_path from public.list_booking_sources('a1111111-1111-4111-8111-111111111111')
   where source_kind = 'hosted' and display_label = 'Vladimir hosted booking form'),
  '/forms/%',
  'the CRM receives a stable relative hosted-form path rather than provider configuration'
);

select throws_ok(
  $$select public.create_booking_source(
      'a2222222-2222-4222-8222-222222222222',
      'hosted', 'Forbidden Kristina form', null, 'tattoo-enquiry', true
    )$$,
  '42501', null,
  'a manager cannot create a hosted source for an artist they do not manage'
);

select throws_ok(
  $$select public.create_booking_source(
      'a1111111-1111-4111-8111-111111111111',
      'hosted', 'Invalid hosted Origin', 'https://external.example.test',
      'tattoo-enquiry', true
    )$$,
  '22023', null,
  'hosted source creation refuses an external Origin'
);

select throws_ok(
  $$insert into public.booking_sources
      (artist_id, source_key, allowed_origin, form_version, is_active,
       source_kind, display_label, form_template)
    values (
      'a1111111-1111-4111-8111-111111111111',
      'browser-direct-source', null, 'booking-v1', true,
      'hosted', 'Direct browser write', 'tattoo-enquiry'
    )$$,
  '42501', null,
  'the authenticated browser cannot bypass the named source-management RPC'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update t_hosted h
set public_source_id = s.public_source_id
from public.booking_sources s
where s.id = h.id;

select is(
  (select source_key ~ '^booking-[0-9a-f]{32}$'
   from public.booking_sources s join t_hosted h on h.id = s.id),
  true,
  'self-service source_key is generated by the server and is not operator input'
);
select is(
  (select allowed_origin from public.booking_sources s join t_hosted h on h.id = s.id),
  null::text,
  'a hosted source has no external Origin authority'
);

-- ---------------------------------------------------------------------------
-- External and hosted resolution cannot be confused
-- ---------------------------------------------------------------------------

update public.booking_sources
set allowed_origin = 'https://vishartattoo.com', is_active = true
where source_key = 'vladimir-website';

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

select is(
  (select source_key from public.resolve_booking_source_public(
    '39680fe5-6da0-48c0-bb6b-b543928747e2',
    'https://vishartattoo.com'
  )),
  'vladimir-website',
  'the external resolver still accepts the exact public id plus exact Origin'
);

select throws_ok(
  format(
    'select * from public.resolve_booking_source_public(%L::uuid, %L)',
    (select public_source_id from t_hosted),
    'https://vishartattoo.com'
  ),
  '42501', null,
  'a hosted public id cannot be replayed through the external Origin resolver'
);

select throws_ok(
  $$select * from public.resolve_hosted_booking_source(
      '39680fe5-6da0-48c0-bb6b-b543928747e2'::uuid
    )$$,
  '42501', null,
  'an external public id cannot be replayed through the hosted resolver'
);

select is(
  (select artist_id from public.resolve_hosted_booking_source(
    (select public_source_id from t_hosted)
  )),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the hosted resolver derives Vladimir from the source registry'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- External Origin exclusivity remains intact across artists.
select throws_ok(
  $$insert into public.booking_sources
      (artist_id, source_key, allowed_origin, form_version, is_active,
       source_kind, display_label, form_template)
    values (
      'a2222222-2222-4222-8222-222222222222',
      'kristina-conflicting-origin', 'https://vishartattoo.com', 'booking-v1', true,
      'external', 'Forbidden external source', 'tattoo-enquiry'
    )$$,
  '23514', null,
  'two artists still cannot share one active external Origin'
);

-- Hosted sources deliberately have no Origin, so two artists can use the same
-- deployed Worker host without weakening external-site routing.
select lives_ok(
  $$insert into public.booking_sources
      (artist_id, source_key, allowed_origin, form_version, is_active,
       source_kind, display_label, form_template)
    values (
      'a2222222-2222-4222-8222-222222222222',
      'kristina-hosted-worker-test', null, 'booking-v1', true,
      'hosted', 'Kristina hosted form', 'tattoo-enquiry'
    )$$,
  'different artists can independently own hosted forms on the common Worker'
);

select throws_ok(
  $$update public.booking_sources
    set source_kind = 'external'
    where source_key = 'kristina-hosted-worker-test'$$,
  '23514', null,
  'source kind is immutable after creation'
);

-- ---------------------------------------------------------------------------
-- Hosted intake enters the same durable booking pipeline
-- ---------------------------------------------------------------------------

create function pg_temp.files(n integer)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'hosted-reference-' || i || '.jpg'
  )), '[]'::jsonb)
  from generate_series(1, n) as i;
$$;

grant execute on function pg_temp.files(integer) to service_role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');

create temporary table t_intake as
select public.create_hosted_enquiry_intake(
  (select public_source_id from t_hosted),
  '97999999-9999-4999-8999-999999999999',
  jsonb_build_object(
    'full_name', 'Hosted Client',
    'email', 'hosted-client@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Colour realism',
    'placement', 'Outer forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Hosted source durable intake test.',
    'source', '/forms/test',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  pg_temp.files(1)
) as r;

grant select on t_intake to public;

select is(
  (select r ->> 'artist_id' from t_intake),
  'a1111111-1111-4111-8111-111111111111',
  'hosted intake returns the database-derived artist'
);

-- The Worker credential writes enquiries through RPCs and holds no SELECT on
-- the table itself, which is deliberate. Verifying what actually landed is a
-- test-owner read, not something service_role should be able to do - asserting
-- it from inside the service_role context would have quietly required widening
-- that grant.
reset role;

select ok(
  not has_table_privilege('service_role', 'public.enquiries', 'SELECT'),
  'the backend credential still cannot read the enquiry table directly'
);
select is(
  (select e.artist_id
   from public.enquiries e
   where e.id = (select (r ->> 'enquiry_id')::uuid from t_intake)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'hosted intake persists the enquiry in Vladimir scope'
);
select is(
  (select e.booking_source_id
   from public.enquiries e
   where e.id = (select (r ->> 'enquiry_id')::uuid from t_intake)),
  (select id from t_hosted),
  'hosted intake pins the durable enquiry to the exact hosted source'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Deactivation removes the public hosted route and intake authority immediately.
update public.booking_sources
set is_active = false
where id = (select id from t_hosted);

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select throws_ok(
  format(
    'select * from public.resolve_hosted_booking_source(%L::uuid)',
    (select public_source_id from t_hosted)
  ),
  '42501', null,
  'deactivating a hosted source removes its public routing authority'
);
reset role;

select * from finish();
rollback;