-- 278_workspace_client_isolation.sql
--
-- A real person may contact several independent artists. Each solo workspace
-- must receive its own client card, and each artist must be able to manage only
-- their copy. Enquiry deletion is an audited soft-delete within that same
-- artist scope and must refuse active work.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('78111111-1111-4111-8111-111111111111', 'isolation-owner@example.test', now()),
  ('78222222-2222-4222-8222-222222222222', 'isolation-a@example.test', now()),
  ('78333333-3333-4333-8333-333333333333', 'isolation-b@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('78111111-1111-4111-8111-111111111111', 'isolation-owner@example.test', 'Isolation Installation Owner', 'owner', true);

create function pg_temp.claims(p_sub uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.claims(uuid) to authenticated, service_role;

-- Enable the existing self-service path, then found two genuinely independent
-- solo workspaces. This mirrors Dmitriy/Andrei/Oleg rather than inventing a
-- special test-only membership topology.
set local role authenticated;
select pg_temp.claims('78111111-1111-4111-8111-111111111111');
select public.set_self_service_signup(true);

reset role;
set local role authenticated;
select pg_temp.claims('78222222-2222-4222-8222-222222222222');
select public.bootstrap_artist_account('Isolation A', 'Isolation A');

reset role;
set local role authenticated;
select pg_temp.claims('78333333-3333-4333-8333-333333333333');
select public.bootstrap_artist_account('Isolation B', 'Isolation B');

reset role;
create temporary table pg_temp.isolation_tenants as
select profile_id, artist_id, workspace_id
from crm_private.self_service_accounts
where profile_id in (
  '78222222-2222-4222-8222-222222222222',
  '78333333-3333-4333-8333-333333333333'
);
grant select on pg_temp.isolation_tenants to authenticated, service_role;

select is(
  (select count(distinct workspace_id)::int from pg_temp.isolation_tenants),
  2,
  'the fixtures are two independent workspaces'
);

-- Same person identifiers, two workspaces: two cards.
set local role authenticated;
select pg_temp.claims('78222222-2222-4222-8222-222222222222');
create temporary table pg_temp.enquiry_a as
select public.create_manual_enquiry(
  '78444444-4444-4444-8444-444444444441',
  (select artist_id from pg_temp.isolation_tenants where profile_id='78222222-2222-4222-8222-222222222222'),
  '{"full_name":"Shared Person A","email":"same-person@example.test","phone":"+447700900777","preferred_contact":"WhatsApp"}'::jsonb,
  '{"project_type":"Portrait","idea":"Workspace A copy"}'::jsonb,
  true
) as r;
grant select on pg_temp.enquiry_a to authenticated, service_role;

reset role;
set local role authenticated;
select pg_temp.claims('78333333-3333-4333-8333-333333333333');
create temporary table pg_temp.enquiry_b as
select public.create_manual_enquiry(
  '78444444-4444-4444-8444-444444444442',
  (select artist_id from pg_temp.isolation_tenants where profile_id='78333333-3333-4333-8333-333333333333'),
  '{"full_name":"Shared Person B","email":"same-person@example.test","phone":"+447700900777","preferred_contact":"Email"}'::jsonb,
  '{"project_type":"Portrait","idea":"Workspace B copy"}'::jsonb,
  true
) as r;
grant select on pg_temp.enquiry_b to authenticated, service_role;

reset role;
select isnt(
  (select r ->> 'client_id' from pg_temp.enquiry_a),
  (select r ->> 'client_id' from pg_temp.enquiry_b),
  'equal email and phone values do not merge client cards across workspaces'
);

select is(
  (select c.workspace_id::text
   from public.clients c
   where c.id = (select (r ->> 'client_id')::uuid from pg_temp.enquiry_a)),
  (select workspace_id::text from pg_temp.isolation_tenants where profile_id='78222222-2222-4222-8222-222222222222'),
  'workspace A client card is owned by workspace A'
);
select is(
  (select c.workspace_id::text
   from public.clients c
   where c.id = (select (r ->> 'client_id')::uuid from pg_temp.enquiry_b)),
  (select workspace_id::text from pg_temp.isolation_tenants where profile_id='78333333-3333-4333-8333-333333333333'),
  'workspace B client card is owned by workspace B'
);

-- The owner/manager of A may edit A without needing access to B, and B remains
-- byte-for-byte independent on the fields being changed.
set local role authenticated;
select pg_temp.claims('78222222-2222-4222-8222-222222222222');
select lives_ok(
  format(
    $$select public.update_client_details(%L::uuid, '{"full_name":"A Local Name","email":"same-person@example.test","phone":"+447700900777","preferred_contact":"Instagram"}'::jsonb)$$,
    (select r ->> 'client_id' from pg_temp.enquiry_a)
  ),
  'workspace A can edit its own client card even when the same person exists elsewhere'
);

reset role;
select is(
  (select full_name from public.clients where id=(select (r ->> 'client_id')::uuid from pg_temp.enquiry_a)),
  'A Local Name',
  'workspace A edit is saved on A card'
);
select is(
  (select full_name from public.clients where id=(select (r ->> 'client_id')::uuid from pg_temp.enquiry_b)),
  'Shared Person B',
  'workspace A edit does not change workspace B card'
);
select is(
  (select preferred_contact from public.clients where id=(select (r ->> 'client_id')::uuid from pg_temp.enquiry_b)),
  'Email',
  'workspace B preferred contact is independent too'
);

-- A business row cannot be forged across tenant boundaries once the client has
-- an existing owner relationship.
select throws_ok(
  format(
    $sql$insert into public.enquiries (
      client_id, reference_number, idempotency_key, intake_fingerprint,
      status, intake_state, submitted_full_name, submitted_email,
      project_type, source, privacy_notice_version, privacy_acknowledged_at,
      artist_id
    ) values (
      %L::uuid, 'PENDING', gen_random_uuid(), repeat('a',64),
      'new','complete','Cross Workspace','cross@example.test',
      'Test','crm_manual','2026-07-29',now(),%L::uuid
    )$sql$,
    (select r ->> 'client_id' from pg_temp.enquiry_a),
    (select artist_id::text from pg_temp.isolation_tenants where profile_id='78333333-3333-4333-8333-333333333333')
  ),
  '23514', null,
  'cross-workspace client links are rejected by the database'
);

-- A scoped booking manager can delete an erroneous enquiry from their own
-- workspace. This is a soft delete, so audit/history remains available.
set local role authenticated;
select pg_temp.claims('78222222-2222-4222-8222-222222222222');
select is(
  public.update_enquiry_details(
    (select (r ->> 'enquiry_id')::uuid from pg_temp.enquiry_a),
    '{"_archive":true}'::jsonb
  ) ->> 'changed',
  'true',
  'workspace A can delete its own enquiry'
);

reset role;
select ok(
  (select archived_at is not null from public.enquiries where id=(select (r ->> 'enquiry_id')::uuid from pg_temp.enquiry_a)),
  'deleted enquiry is retained as an archived audit record'
);
select is(
  (select count(*)::int from public.activity_log
   where enquiry_id=(select (r ->> 'enquiry_id')::uuid from pg_temp.enquiry_a)
     and event_type='enquiry.archived'),
  1,
  'enquiry deletion writes one audit event'
);

-- B cannot delete A's enquiry, even though both users have the same coarse CRM
-- role. Tenant membership is the authority.
set local role authenticated;
select pg_temp.claims('78333333-3333-4333-8333-333333333333');
select throws_ok(
  format(
    $$select public.update_enquiry_details(%L::uuid, '{"_archive":true}'::jsonb)$$,
    (select r ->> 'enquiry_id' from pg_temp.enquiry_a)
  ),
  '42501', null,
  'another workspace cannot delete the enquiry'
);

-- Active appointments block deletion so the calendar never loses its source
-- enquiry from the working model.
create temporary table pg_temp.enquiry_active as
select public.create_manual_enquiry(
  '78444444-4444-4444-8444-444444444443',
  (select artist_id from pg_temp.isolation_tenants where profile_id='78333333-3333-4333-8333-333333333333'),
  '{"full_name":"Appointment Client","email":"active-appointment@example.test"}'::jsonb,
  '{"project_type":"Consultation","idea":"Keep while appointment is active"}'::jsonb,
  true
) as r;
grant select on pg_temp.enquiry_active to authenticated, service_role;

reset role;
set local role service_role;
insert into public.sessions (
  artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at
) values (
  (select artist_id from pg_temp.isolation_tenants where profile_id='78333333-3333-4333-8333-333333333333'),
  (select (r ->> 'client_id')::uuid from pg_temp.enquiry_active),
  (select (r ->> 'enquiry_id')::uuid from pg_temp.enquiry_active),
  'in_person_consultation', 'proposed',
  '2035-01-08T10:00:00Z', '2035-01-08T10:30:00Z'
);

create function pg_temp.refusal_hint(p_sql text) returns text language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return coalesce(v_hint, '');
end;
$$;
grant execute on function pg_temp.refusal_hint(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.claims('78333333-3333-4333-8333-333333333333');
select is(
  pg_temp.refusal_hint(format(
    $$select public.update_enquiry_details(%L::uuid, '{"_archive":true}'::jsonb)$$,
    (select r ->> 'enquiry_id' from pg_temp.enquiry_active)
  )),
  'ENQUIRY_HAS_ACTIVE_APPOINTMENT',
  'an enquiry with an active appointment cannot be deleted'
);

reset role;
select * from finish();
rollback;
