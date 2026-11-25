-- Synthetic multi-channel healing flow, rolled back without provider calls.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_fu_artist as
select a.id, a.workspace_id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_fu_artist to public;

insert into auth.users (id, email) values
  ('e9900000-0000-4000-8000-0000000000a1', 'fu-manager@example.test'),
  ('e9900000-0000-4000-8000-0000000000a3', 'fu-read-only@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9900000-0000-4000-8000-0000000000a1', 'fu-manager@example.test', 'FU Manager', 'booking_manager', true),
  ('e9900000-0000-4000-8000-0000000000a3', 'fu-read-only@example.test', 'FU Read', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e9900000-0000-4000-8000-0000000000a1', (select id from t_fu_artist),
   'manager', false, false, true, false, true),
  ('e9900000-0000-4000-8000-0000000000a3', (select id from t_fu_artist),
   'read_only', false, false, false, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;

create function pg_temp.days_ago(p int) returns timestamptz language sql stable as $$
  select date_trunc('hour', now()) - make_interval(days => p);
$$;
grant execute on function pg_temp.days_ago(int) to public;

-- ---------------------------------------------------------------- fixtures
-- 1 Alice: healed, WhatsApp conversation. 2 Ben: visit 10 days ago.
-- 3 Hal: healed, no WhatsApp conversation.
insert into public.clients (id, full_name, email, phone, workspace_id)
select v.id, v.name, v.email, v.phone, (select workspace_id from t_fu_artist) from (values
  ('e99c0000-0000-4000-8000-000000000001'::uuid, 'Alice Healed', 'fu-a@example.test', '+447700900801'),
  ('e99c0000-0000-4000-8000-000000000002', 'Ben Recent', 'fu-b@example.test', '+447700900802'),
  ('e99c0000-0000-4000-8000-000000000003', 'Hal Nochat', 'fu-h@example.test', '+447700900803')
) v(id, name, email, phone);

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, currency)
select ('e99d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       (select id from t_fu_artist), 'active', 'FU project ' || v.n, 'not_required', 'GBP'
from (values ('1'), ('2'), ('3')) v(n);

insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency)
select ('e9950000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_fu_artist),
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e99d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'completed', pg_temp.days_ago(v.d),
       pg_temp.days_ago(v.d) + interval '4 hours', 4, 'GBP'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, outcome, work_result,
   worked_minutes, confirmed_at)
select ('e9950000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_fu_artist),
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'confirmed', 'attended', 'work_complete', 240,
       pg_temp.days_ago(v.d) + interval '5 hours'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.artist_integrations(
  artist_id, integration_type, provider, integration_key, external_account_label, is_enabled)
select a.id, 'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic healing route', true
from t_fu_artist a
where not exists (
  select 1 from public.artist_integrations i where i.artist_id = a.id
    and i.integration_type = 'whatsapp' and i.provider = 'meta_cloud_api'
    and i.integration_key = 'vladimir-production');

insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state)
select 'e99e0000-0000-4000-8000-000000000001', id, 'whatsapp', 'vladimir-production',
       '447700900801', 'e99c0000-0000-4000-8000-000000000001', 'linked', 'open'
from t_fu_artist;

-- Synthetic Meta approval, as the maintenance poller would record it.
insert into crm_private.lifecycle_whatsapp_template_candidates (
  artist_id, purpose, template_name, template_language, approval_status,
  provider_template_id, verified_at)
select id, 'healing_check', 'vishar_healing_check_v1', 'en_GB', 'APPROVED', '2100052927362795', now()
from t_fu_artist
on conflict (artist_id, purpose) do update set
  template_name = excluded.template_name, template_language = excluded.template_language,
  approval_status = excluded.approval_status,
  provider_template_id = excluded.provider_template_id, verified_at = excluded.verified_at;



-- Use a connected test mailbox and explicit heartbeat. Existing mailbox rows
-- are disabled only in this transaction so ambiguous routing is never hidden.
update public.artist_integrations set is_enabled=false where artist_id=(select id from t_fu_artist)
  and integration_type='email';
insert into public.artist_integrations(artist_id,integration_type,provider,integration_key,external_account_label,is_enabled)
select id,'email','google','review-test-mailbox','artist@example.test',true from t_fu_artist;
select public.service_list_review_email_checks((select id from t_fu_artist),'review-test-mailbox','artist@example.test');
-- Existing seeded Instagram route is the authoritative test identity.
update public.artist_integrations set is_enabled=true where artist_id=(select id from t_fu_artist)
  and integration_type='instagram' and integration_key='vladimir-instagram';
insert into public.communication_conversations(id,artist_id,channel,integration_key,external_contact_id,client_id,link_state,state,last_inbound_at,last_message_at)
select 'e99e0000-0000-4000-8000-000000000002',id,'instagram','vladimir-instagram','987654321001',
  'e99c0000-0000-4000-8000-000000000001','linked','open',clock_timestamp(),clock_timestamp()
from t_fu_artist;

select pg_temp.as_profile('e9900000-0000-4000-8000-0000000000a1');
select ok(exists(select 1 from jsonb_array_elements(public.list_review_suggestions((select id from t_fu_artist))->'suggestions') s
  cross join lateral jsonb_array_elements(s->'channels') c
  where s->>'client_id'='e99c0000-0000-4000-8000-000000000003' and c->>'channel'='email' and (c->>'available')::boolean),
  'email is available without WhatsApp');
select ok(exists(select 1 from jsonb_array_elements(public.list_review_suggestions((select id from t_fu_artist))->'suggestions') s
  cross join lateral jsonb_array_elements(s->'channels') c
  where s->>'client_id'='e99c0000-0000-4000-8000-000000000001' and c->>'channel'='instagram' and (c->>'available')::boolean),
  'linked Instagram with open window is available');

create temporary table t_multi as select
  public.send_healing_question_v2((select id from t_fu_artist),'e9950000-0000-4000-8000-000000000001',
    'e99a0000-0000-4000-8000-000000000101','instagram') as ig,
  public.send_healing_question_v2((select id from t_fu_artist),'e9950000-0000-4000-8000-000000000003',
    'e99a0000-0000-4000-8000-000000000103','email') as em;
select is((select ig->>'channel' from t_multi),'instagram','Instagram chosen explicitly');
select is((select em->>'channel' from t_multi),'email','Email chosen explicitly');
select ok((select em->>'healing_message_id' from t_multi) is null,'email has no fabricated Meta message');
select is((select count(*)::int from public.integration_outbox o where o.email_message_id=(select (em->>'healing_email_message_id')::uuid from t_multi)),1,'one email outbox');
select is(public.send_healing_question_v2((select id from t_fu_artist),'e9950000-0000-4000-8000-000000000003',
  'e99a0000-0000-4000-8000-000000000103','email'),(select em from t_multi),'same operation replays');
select throws_ok($$select public.send_healing_question_v2((select id from t_fu_artist),'e9950000-0000-4000-8000-000000000003',
  'e99a0000-0000-4000-8000-000000000103','instagram')$$,'22023',null,'same operation cannot switch channel');
select throws_ok($$select public.ask_for_review_v2((select id from t_fu_artist),(select (em->>'id')::uuid from t_multi),
  'e99a0000-0000-4000-8000-000000000104','Thanks','email')$$,'55000',null,'no review until actual email reply');

-- Simulated backend lease and acknowledgement, never a provider call.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.integration_outbox set status='leased',leased_by='review-test-worker',leased_at=now(),lease_expires_at=now()+interval '2 minutes'
  where email_message_id=(select (em->>'healing_email_message_id')::uuid from t_multi);
select ok((select delivery_allowed from public.service_resolve_gmail_outbox_target(
  (select id from public.integration_outbox where email_message_id=(select (em->>'healing_email_message_id')::uuid from t_multi)),
  'review-test-worker')),'email resolver accepts exact review job without enquiry');
select public.service_record_review_email_sent(
  (select id from public.integration_outbox where email_message_id=(select (em->>'healing_email_message_id')::uuid from t_multi)),
  'review-test-worker','sent123','thread123','<healing@example.test>');
select is((select status::text from public.email_messages where id=(select (em->>'healing_email_message_id')::uuid from t_multi)),
  'sent','provider acknowledgement stores durable send');
select throws_ok($$select public.service_record_review_email_check((select id from t_fu_artist),'review-test-mailbox',
  (select (em->>'healing_email_message_id')::uuid from t_multi),'wrong123','reply123',clock_timestamp(),'Unrelated')$$,
  '42501',null,'unrelated thread rejected');
select public.service_record_review_email_check((select id from t_fu_artist),'review-test-mailbox',
  (select (em->>'healing_email_message_id')::uuid from t_multi),'thread123','reply123',clock_timestamp(),'Healed well!');
select pg_temp.as_profile('e9900000-0000-4000-8000-0000000000a1');
select ok(exists(select 1 from jsonb_array_elements(public.list_review_followups((select id from t_fu_artist))->'items') s
  where s->>'review_request_id'=(select em->>'id' from t_multi) and s->>'status'='replied' and s->>'reply_text'='Healed well!'),
  'verified email reply opens the review step');
select is(public.ask_for_review_v2((select id from t_fu_artist),(select (em->>'id')::uuid from t_multi),
  'e99a0000-0000-4000-8000-000000000105','Thanks, a review would help!','email')->>'state','review_asked','review may be queued by email');
select ok(not has_function_privilege('authenticated','public.service_record_review_email_check(uuid,text,uuid,text,text,timestamptz,text)','execute'),
  'browser cannot fabricate a reply');
select * from finish(true);
rollback;
