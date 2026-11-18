-- 397_review_request_suggestions.sql
-- Google review request, phase 1: suggest asking how a tattoo healed 28+
-- days after the last attended visit of a block, and record the artist's
-- "later" / "don't ask" decisions. Nothing is sent or queued. Every row is
-- synthetic and rolled back.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_rr_artist as
select a.id, a.workspace_id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_rr_artist to public;

insert into auth.users (id, email) values
  ('e9700000-0000-4000-8000-0000000000a1', 'rr-manager@example.test'),
  ('e9700000-0000-4000-8000-0000000000a2', 'rr-other-artist@example.test'),
  ('e9700000-0000-4000-8000-0000000000a3', 'rr-read-only@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9700000-0000-4000-8000-0000000000a1', 'rr-manager@example.test', 'RR Manager', 'booking_manager', true),
  ('e9700000-0000-4000-8000-0000000000a2', 'rr-other-artist@example.test', 'RR Other', 'booking_manager', true),
  ('e9700000-0000-4000-8000-0000000000a3', 'rr-read-only@example.test', 'RR Read', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e9700000-0000-4000-8000-0000000000a1', (select id from t_rr_artist),
   'manager', false, false, true, false, true),
  ('e9700000-0000-4000-8000-0000000000a2', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true),
  ('e9700000-0000-4000-8000-0000000000a3', (select id from t_rr_artist),
   'read_only', false, false, false, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;

-- Whole hours, a five-minute step, so session time checks hold.
create function pg_temp.days_ago(p int) returns timestamptz language sql stable as $$
  select date_trunc('hour', now()) - make_interval(days => p);
$$;
grant execute on function pg_temp.days_ago(int) to public;

-- ---------------------------------------------------------------- fixtures
insert into public.clients (id, full_name, email, workspace_id)
select v.id, v.name, v.email, (select workspace_id from t_rr_artist) from (values
  ('e97c0000-0000-4000-8000-000000000001'::uuid, 'Alice Healed', 'rr-a@example.test'),
  ('e97c0000-0000-4000-8000-000000000002', 'Ben Recent', 'rr-b@example.test'),
  ('e97c0000-0000-4000-8000-000000000003', 'Cara Midproject', 'rr-c@example.test'),
  ('e97c0000-0000-4000-8000-000000000004', 'Dan Booked', 'rr-d@example.test'),
  ('e97c0000-0000-4000-8000-000000000005', 'Ella Unsubscribed', 'rr-e@example.test'),
  ('e97c0000-0000-4000-8000-000000000006', 'Finn Long Ago', 'rr-f@example.test'),
  ('e97c0000-0000-4000-8000-000000000007', 'Hal Touchup', 'rr-h@example.test'),
  ('e97c0000-0000-4000-8000-000000000008', 'Ivy Asked', 'rr-i@example.test')
) v(id, name, email);

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, currency)
select ('e97d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e97c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       (select id from t_rr_artist), 'active', 'RR project ' || v.n, 'not_required', 'GBP'
from (values ('1'), ('2'), ('3'), ('4'), ('5'), ('6'), ('7'), ('8')) v(n);

insert into public.communication_suppressions (client_id, channel, reason, is_active)
values ('e97c0000-0000-4000-8000-000000000005', 'whatsapp', 'unsubscribed', true);

-- Past visits: session n<k> belongs to client n.
insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency)
select ('e9750000-0000-4000-8000-0000000000' || v.s)::uuid, (select id from t_rr_artist),
       ('e97c0000-0000-4000-8000-00000000000' || left(v.s, 1))::uuid,
       ('e97d0000-0000-4000-8000-00000000000' || left(v.s, 1))::uuid,
       v.kind::public.appointment_type, v.status::public.session_status,
       pg_temp.days_ago(v.d), pg_temp.days_ago(v.d) + interval '4 hours', 4, 'GBP'
from (values
  ('11', 'tattoo_session', 'completed', 40),
  ('21', 'tattoo_session', 'completed', 10),
  ('31', 'tattoo_session', 'completed', 40),
  ('41', 'tattoo_session', 'completed', 40),
  ('51', 'tattoo_session', 'completed', 40),
  ('61', 'tattoo_session', 'completed', 200),
  ('71', 'tattoo_session', 'completed', 50),
  ('72', 'touch_up', 'completed', 30),
  ('81', 'tattoo_session', 'completed', 45)
) v(s, kind, status, d);

-- Dan has his next session booked.
insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency)
values ('e9750000-0000-4000-8000-000000000042', (select id from t_rr_artist),
        'e97c0000-0000-4000-8000-000000000004', 'e97d0000-0000-4000-8000-000000000004',
        'tattoo_session', 'confirmed', date_trunc('hour', now()) + interval '20 days',
        date_trunc('hour', now()) + interval '20 days 4 hours', 4, 'GBP');

insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, outcome, work_result,
   worked_minutes, confirmed_at)
select ('e9750000-0000-4000-8000-0000000000' || v.s)::uuid, (select id from t_rr_artist),
       ('e97c0000-0000-4000-8000-00000000000' || left(v.s, 1))::uuid,
       v.kind::public.appointment_type, 'confirmed', 'attended', v.work_result, 240,
       pg_temp.days_ago(v.d) + interval '5 hours'
from (values
  ('11', 'tattoo_session', 'work_complete', 40),
  ('21', 'tattoo_session', 'work_complete', 10),
  ('31', 'tattoo_session', 'next_session_needed', 40),
  ('41', 'tattoo_session', 'work_complete', 40),
  ('51', 'tattoo_session', 'work_complete', 40),
  ('61', 'tattoo_session', 'work_complete', 200),
  ('71', 'tattoo_session', 'touch_up_needed', 50),
  ('72', 'touch_up', 'work_complete', 30),
  ('81', 'tattoo_session', 'work_complete', 45)
) v(s, kind, work_result, d);

-- Ivy was already asked how her tattoo healed.
insert into public.review_requests
  (artist_id, client_id, anchor_session_id, state, healing_asked_at, last_operation_id)
values ((select id from t_rr_artist), 'e97c0000-0000-4000-8000-000000000008',
        'e9750000-0000-4000-8000-000000000081', 'healing_asked', now() - interval '2 days',
        'e97a0000-0000-4000-8000-0000000000ff');

create function pg_temp.suggested() returns text[] language sql as $$
  select coalesce(array_agg(x ->> 'client_name' order by ord), '{}')
  from jsonb_array_elements(public.list_review_suggestions((select id from t_rr_artist)) -> 'suggestions')
    with ordinality as t(x, ord);
$$;
grant execute on function pg_temp.suggested() to public;

-- ------------------------------------------------------------- the seeded links
select is(
  (select count(*)::int from crm_private.artist_review_settings rs
   join public.artists a on a.id = rs.artist_id
   where (a.slug, rs.google_review_url) in (
     ('vladimir', 'https://g.page/r/CRBB4T36uQ6wEBI/review'),
     ('kristina', 'https://g.page/r/CTWQsqzepVfJEBI/review'))),
  (select count(*)::int from public.artists where slug in ('vladimir', 'kristina')),
  'each artist has the Google review link from their own site');
select throws_ok(
  $$insert into crm_private.artist_review_settings (artist_id, google_review_url)
    values ('e9700000-0000-4000-8000-0000000000ff', 'https://example.test/review')$$,
  '23514', null, 'a review link outside Google is rejected');

-- ------------------------------------------------------------- suggestions
select pg_temp.as_profile('e9700000-0000-4000-8000-0000000000a1');

select is(pg_temp.suggested(), array['Alice Healed', 'Hal Touchup'],
  'only finished, healed-long-enough, unbooked, unsuppressed, never-asked clients are suggested, oldest first');

select is(
  (select x from jsonb_array_elements(public.list_review_suggestions((select id from t_rr_artist)) -> 'suggestions') x
   where x ->> 'client_name' = 'Hal Touchup') ->> 'anchor_session_id',
  'e9750000-0000-4000-8000-000000000072',
  'the anchor is the last attended visit of the block, here the touch-up');

select is(
  (public.list_review_suggestions((select id from t_rr_artist)) -> 'suggestions' -> 0 ->> 'draft_message'),
  'Hi Alice, I hope all is well with you. How has your tattoo healed?',
  'the draft is the approved healing question with the first name');

select is(
  (public.list_review_suggestions((select id from t_rr_artist)) -> 'suggestions' -> 0 ->> 'days_since')::int,
  40, 'days since the visit');

select ok(
  (public.list_review_suggestions((select id from t_rr_artist)) ->> 'review_url_configured')::boolean,
  'the artist has a review link configured');

select is((select count(*)::int from public.review_requests), 1, 'listing writes nothing');

-- ------------------------------------------------------------- decisions
select is(
  public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000011',
    'snooze', 'e97a0000-0000-4000-8000-000000000001') ->> 'state',
  'snoozed', 'later hides the suggestion');
select is(pg_temp.suggested(), array['Hal Touchup'], 'a snoozed client is not suggested');
select ok(
  (select snoozed_until between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
   from public.review_requests where anchor_session_id = 'e9750000-0000-4000-8000-000000000011'),
  'later defaults to 14 days');

select is(
  (public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000011',
    'snooze', 'e97a0000-0000-4000-8000-000000000001') ->> 'version')::int,
  1, 'a repeated operation id returns the recorded row unchanged');

select is(
  public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000011',
    'dismiss', 'e97a0000-0000-4000-8000-000000000002') ->> 'state',
  'dismissed', 'don''t ask closes it for that visit');
select is(
  (select version from public.review_requests where anchor_session_id = 'e9750000-0000-4000-8000-000000000011'),
  2, 'each decision bumps the version');
select ok(
  (select snoozed_until is null from public.review_requests where anchor_session_id = 'e9750000-0000-4000-8000-000000000011'),
  'a dismissed row has no snooze date');

select is(
  public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000072',
    'snooze', 'e97a0000-0000-4000-8000-000000000003', 3) ->> 'state',
  'snoozed', 'later with a custom number of days');
select is(pg_temp.suggested(), '{}'::text[], 'nothing left to suggest');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.review_requests set snoozed_until = now() - interval '1 minute'
where anchor_session_id = 'e9750000-0000-4000-8000-000000000072';
select pg_temp.as_profile('e9700000-0000-4000-8000-0000000000a1');
select is(pg_temp.suggested(), array['Hal Touchup'], 'an expired snooze shows the suggestion again');

-- ------------------------------------------------------------- refusals
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000081',
      'dismiss', 'e97a0000-0000-4000-8000-000000000004')$$,
  '55000', null, 'a visit whose healing question was sent cannot be snoozed or dismissed here');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000042',
      'dismiss', 'e97a0000-0000-4000-8000-000000000005')$$,
  '23503', null, 'a visit without an attended outcome is refused');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000021',
      'send', 'e97a0000-0000-4000-8000-000000000006')$$,
  '22023', null, 'an unknown action is refused');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000021',
      'snooze', 'e97a0000-0000-4000-8000-000000000007', 0)$$,
  '22023', null, 'snooze days out of range are refused');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000021',
      'snooze', null)$$,
  '22023', null, 'an operation id is required');

select pg_temp.as_profile('e9700000-0000-4000-8000-0000000000a2');
select throws_ok($$select public.list_review_suggestions((select id from t_rr_artist))$$,
  '42501', null, 'another artist''s manager cannot list suggestions');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000021',
      'dismiss', 'e97a0000-0000-4000-8000-000000000008')$$,
  '42501', null, 'another artist''s manager cannot decide');

select pg_temp.as_profile('e9700000-0000-4000-8000-0000000000a3');
select lives_ok($$select public.list_review_suggestions((select id from t_rr_artist))$$,
  'a read-only member can see the suggestions');
select throws_ok(
  $$select public.act_on_review_suggestion((select id from t_rr_artist), 'e9750000-0000-4000-8000-000000000021',
      'dismiss', 'e97a0000-0000-4000-8000-000000000009')$$,
  '42501', null, 'a read-only member cannot decide');

-- ------------------------------------------------------------- privileges
select ok(not has_table_privilege('authenticated', 'public.review_requests', 'select'),
  'the browser cannot read review_requests directly');
select ok(not has_table_privilege('anon', 'public.review_requests', 'select'),
  'anon cannot read review_requests');
select ok(not has_table_privilege('authenticated', 'crm_private.artist_review_settings', 'select'),
  'the browser cannot read review links directly');
select ok(not has_function_privilege('anon', 'public.list_review_suggestions(uuid)', 'execute'),
  'anon cannot list suggestions');
select ok(not has_function_privilege('authenticated', 'crm_private.review_suggestions(uuid,timestamptz)', 'execute'),
  'the private builder is not callable from the browser');

select * from finish(true);
rollback;
