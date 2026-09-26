-- 303_intake_preflight_telemetry.sql
--
-- Intake preflight telemetry keeps metadata only, rejects anything outside
-- its bounded vocabulary, and a browser-supplied event id can mark an event
-- once. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table ids (name text primary key, id uuid);

insert into ids select 'clarify', public.service_record_intake_preflight(jsonb_build_object('id', gen_random_uuid(),
  'version', 'intake-preflight.2026-09-26', 'form_path', 'external', 'status', 'clarify',
  'categories', jsonb_build_array('placement', 'size'), 'provider', 'jev', 'outcome', 'ok', 'latency_ms', 180));
select is((select status || ':' || array_to_string(categories, '+') from crm_private.intake_preflight_events
           where id = (select id from ids where name = 'clarify')), 'clarify:placement+size',
  'a clarification is stored as status and categories');

insert into ids select 'skipped', public.service_record_intake_preflight(jsonb_build_object('id', gen_random_uuid(),
  'version', 'intake-preflight.2026-09-26', 'form_path', 'hosted', 'status', 'skipped',
  'categories', '[]'::jsonb, 'outcome', 'timeout', 'latency_ms', 1200));
select is((select provider from crm_private.intake_preflight_events where id = (select id from ids where name = 'skipped')),
  null, 'a skipped preflight may carry no provider');

select throws_ok($$ select public.service_record_intake_preflight(jsonb_build_object('id', gen_random_uuid(),
  'version', 'intake-preflight.2026-09-26', 'form_path', 'external', 'status', 'clarify',
  'categories', jsonb_build_array('price'), 'outcome', 'ok')) $$,
  '23514', null, 'a category outside the vocabulary is rejected');
select throws_ok($$ select public.service_record_intake_preflight(jsonb_build_object('id', gen_random_uuid(),
  'version', 'intake-preflight.2026-09-26', 'form_path', 'external', 'status', 'booked',
  'categories', '[]'::jsonb, 'outcome', 'ok')) $$,
  '23514', null, 'a status outside the vocabulary is rejected');
select throws_ok($$ select public.service_record_intake_preflight(jsonb_build_object('id', gen_random_uuid(),
  'version', 'intake-preflight.2026-09-26', 'form_path', 'external', 'status', 'ready',
  'categories', '[]'::jsonb, 'outcome', 'Client wrote: my name is Ana')) $$,
  '23514', null, 'free text cannot be smuggled in through the outcome code');

select is(public.service_mark_intake_preflight_submitted((select id from ids where name = 'clarify'), 'send_anyway', null) ->> 'status',
  'marked', 'the real submit marks the preflight it followed');
select is(public.service_mark_intake_preflight_submitted((select id from ids where name = 'clarify'), 'corrected', null) ->> 'status',
  'ignored', 'an event is marked once');
select is((select submit_choice from crm_private.intake_preflight_events where id = (select id from ids where name = 'clarify')),
  'send_anyway', 'and the first choice stands');
select is(public.service_mark_intake_preflight_submitted(gen_random_uuid(), 'corrected', null) ->> 'status',
  'ignored', 'an unknown id changes nothing');
select is(public.service_mark_intake_preflight_submitted((select id from ids where name = 'skipped'), 'whatever', null) ->> 'status',
  'ignored', 'an unknown choice changes nothing');

update crm_private.intake_preflight_events set created_at = now() - interval '2 days' where id = (select id from ids where name = 'skipped');
select is(public.service_mark_intake_preflight_submitted((select id from ids where name = 'skipped'), 'unchanged', null) ->> 'status',
  'ignored', 'an event older than a day cannot be marked');

select throws_ok($$ select public.service_record_intake_preflight(jsonb_build_object(
  'version', 'intake-preflight.2026-09-26', 'form_path', 'external', 'status', 'ready', 'categories', '[]'::jsonb, 'outcome', 'ok')) $$,
  '22023', null, 'an event needs a Worker-minted id');

select ok(
  not has_table_privilege('service_role', 'crm_private.intake_preflight_events', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.intake_preflight_events', 'SELECT')
  and not has_table_privilege('anon', 'crm_private.intake_preflight_events', 'SELECT'),
  'the telemetry table is private');
select ok(
  not exists (select 1 from information_schema.columns
              where table_schema = 'crm_private' and table_name = 'intake_preflight_events'
                and column_name in ('placement', 'size', 'idea', 'email', 'name', 'client_id', 'text')),
  'the table has no column that could hold enquiry text or a client identifier');

select * from finish();
rollback;
