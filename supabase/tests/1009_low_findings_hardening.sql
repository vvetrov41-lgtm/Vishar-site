-- 1009_low_findings_hardening.sql
-- Audit L-1/L-2: advisor search_path, duplicate index, no existence oracles.
begin;
select no_plan();

select ok((select proconfig::text ilike '%search_path%' from pg_proc where oid = 'crm_private.slugify(text)'::regprocedure),
  'slugify pins its search_path');
select ok((select proconfig::text ilike '%search_path%' from pg_proc
           where oid = 'crm_private.capability_from_grant(public.crm_role, public.artist_access_level, boolean, boolean, boolean, boolean, text)'::regprocedure),
  'capability_from_grant pins its search_path');
select is((select count(*)::int from pg_indexes where tablename = 'follow_ups'
           and indexdef ilike '%(due_at) WHERE (status = ''open''%'), 1,
  'exactly one open-follow-up due index remains');

insert into auth.users (id, email) values ('e7011111-1111-4111-8111-111111111111', 'outsider@example.test');
insert into public.profiles (id, email, display_name, role, is_active)
values ('e7011111-1111-4111-8111-111111111111', 'outsider@example.test', 'Outsider', 'read_only', true);
insert into public.clients (id, full_name, email) values
  ('e7021111-1111-4111-8111-111111111111', 'Hidden Client', 'hidden@example.test');

select set_config('request.jwt.claims',
  '{"sub":"e7011111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(public.may_contact_client('e7021111-1111-4111-8111-111111111111', 'email', 'appointment_reminder'), false,
  'a client the caller cannot access is answered like an uncontactable one');
select * from finish(true);
rollback;
