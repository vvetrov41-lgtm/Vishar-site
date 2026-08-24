-- 230_message_templates_and_consent.sql
--
-- Migration 0082: templates, and the consent/suppression gate.
--
-- Client lifecycle automation now consumes this gate, so these assertions pin
-- the policy the send path must obey. The questions worth answering are the
-- ones every automated service message still asks:
--
--   can a template call itself service traffic when it is a promotion?
--   does silence count as consent?
--   does an unsubscribe stop the reminder for an appointment they booked?
--   does a bounced address stop a message they did consent to?
--
-- Everything is synthetic and rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and ACL
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where oid in ('public.message_template_purposes'::regclass,
                 'public.message_template_variables'::regclass,
                 'public.message_templates'::regclass,
                 'public.client_marketing_consent'::regclass,
                 'public.communication_suppressions'::regclass)),
  'row level security is enabled and forced on every new table'
);
select ok(
  (select bool_and(
     not has_table_privilege('authenticated', t, 'SELECT')
     and not has_table_privilege('authenticated', t, 'INSERT')
     and not has_table_privilege('anon', t, 'SELECT'))
   from unnest(array['public.message_templates', 'public.client_marketing_consent',
                     'public.communication_suppressions']) t),
  'no browser session reads or writes templates, consent or suppressions directly'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.proname in ('may_contact_client', 'resolve_message_template',
                       'upsert_message_template', 'record_client_marketing_consent',
                       'suppress_client_communications',
                       'client_send_block_reason', 'guard_message_template_scope')),
  'every entry point is SECURITY DEFINER with a pinned search_path'
);
select ok(
  not has_function_privilege('service_role', 'public.record_client_marketing_consent(uuid,public.message_template_channel,public.consent_state,text,text)', 'EXECUTE'),
  'the Worker credential cannot record consent on a client''s behalf'
);

-- The acknowledgement recorded at intake is not consent, and nothing in the
-- gate may quietly start reading it as though it were.
select ok(
  (select pg_get_functiondef(p.oid) not like '%privacy_acknowledged%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'crm_private' and p.proname = 'client_send_block_reason'),
  'the gate does not read the privacy acknowledgement as consent'
);

-- ---------------------------------------------------------------------------
-- Classification is catalogued, not chosen
-- ---------------------------------------------------------------------------

select is(
  (select classification::text from public.message_template_purposes
   where purpose = 'session_reminder_24h'),
  'service',
  'an appointment reminder is service traffic'
);
select is(
  (select classification::text from public.message_template_purposes
   where purpose = 'availability_announcement'),
  'marketing',
  'an availability announcement is marketing'
);
select hasnt_column(
  'public', 'message_templates', 'classification',
  'a template has no classification column of its own to disagree with its purpose'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('b9111111-1111-4111-8111-111111111111', 'tpl.artist@example.test'),
  ('b9222222-2222-4222-8222-222222222222', 'tpl.admin@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('b9111111-1111-4111-8111-111111111111', 'tpl.artist@example.test', 'Tpl Artist', 'booking_manager', true),
  ('b9222222-2222-4222-8222-222222222222', 'tpl.admin@example.test', 'Tpl Admin', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type) values
  ('b7111111-1111-4111-8111-111111111111', 'tpl-studio', 'Template Studio', 'studio'),
  ('b7222222-2222-4222-8222-222222222222', 'tpl-rival', 'Rival Studio', 'studio');

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('b8111111-1111-4111-8111-111111111111', 'tpl-alice', 'Alice',
   'b7111111-1111-4111-8111-111111111111', true),
  ('b8222222-2222-4222-8222-222222222222', 'tpl-carol', 'Carol',
   'b7222222-2222-4222-8222-222222222222', true);

insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_integrations, is_active)
values
  ('b9111111-1111-4111-8111-111111111111', 'b8111111-1111-4111-8111-111111111111',
   'artist', true, true);

insert into public.workspace_memberships
  (profile_id, workspace_id, workspace_role, can_manage_workspace,
   can_manage_team, can_manage_integrations, is_active)
values
  ('b9222222-2222-4222-8222-222222222222', 'b7111111-1111-4111-8111-111111111111',
   'admin', true, true, true, true);

insert into public.clients (id, full_name, email) values
  ('b6111111-1111-4111-8111-111111111111', 'Consenting Client', 'yes@example.test'),
  ('b6222222-2222-4222-8222-222222222222', 'Silent Client', 'silent@example.test'),
  ('b6333333-3333-4333-8333-333333333333', 'Archived Client', 'gone@example.test');

update public.clients set archived_at = now()
where id = 'b6333333-3333-4333-8333-333333333333';

-- A client is in an artist's scope through the work that links them, so the
-- consenting client needs an enquiry before Alice may record anything for them.
insert into public.enquiries
  (id, artist_id, client_id, reference_number, idempotency_key,
   intake_fingerprint, status, intake_state, submitted_full_name,
   submitted_email, privacy_notice_version, privacy_acknowledged_at)
values
  ('b5111111-1111-4111-8111-111111111111', 'b8111111-1111-4111-8111-111111111111',
   'b6111111-1111-4111-8111-111111111111', 'ENQ-2026-8001',
   'b4111111-1111-4111-8111-111111111111', repeat('b', 64),
   'new', 'complete', 'Consenting Client', 'yes@example.test',
   '2026-07-29', now());

create function pg_temp.tpl_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.tpl_as(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Silence is not consent
-- ---------------------------------------------------------------------------

select ok(
  public.may_contact_client('b6222222-2222-4222-8222-222222222222',
                            'email', 'session_reminder_24h'),
  'a client with no consent record still receives service traffic'
);
select ok(
  not public.may_contact_client('b6222222-2222-4222-8222-222222222222',
                                'email', 'availability_announcement'),
  'and receives no marketing, because an absent record is not consent'
);
select is(
  crm_private.client_send_block_reason('b6222222-2222-4222-8222-222222222222',
                                       'email', 'marketing'),
  'no_marketing_consent',
  'the refusal names the missing consent rather than looking like an error'
);

select throws_ok(
  $$select public.may_contact_client('b6222222-2222-4222-8222-222222222222',
                                     'email', 'quietly_promotional')$$,
  '22023', null,
  'an uncatalogued purpose is refused rather than defaulting to service'
);

-- ---------------------------------------------------------------------------
-- Consent is per channel, and withdrawal is honoured
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select ok(
  public.record_client_marketing_consent(
    'b6111111-1111-4111-8111-111111111111', 'email', 'granted', 'booking_form'),
  'consent can be recorded for one channel'
);
reset role;

select ok(
  public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                            'email', 'availability_announcement'),
  'a consenting client may receive marketing on that channel'
);
select ok(
  not public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                                'whatsapp', 'availability_announcement'),
  'consent on email says nothing about WhatsApp'
);

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select ok(
  not public.record_client_marketing_consent(
    'b6111111-1111-4111-8111-111111111111', 'email', 'withdrawn', 'client_request'),
  'consent can be withdrawn'
);
reset role;

select ok(
  not public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                                'email', 'availability_announcement'),
  'and withdrawal immediately stops marketing'
);
select ok(
  public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                            'email', 'session_reminder_24h'),
  'while the reminder for work they booked still goes out'
);

-- ---------------------------------------------------------------------------
-- Suppression outranks consent
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select ok(
  public.record_client_marketing_consent(
    'b6111111-1111-4111-8111-111111111111', 'email', 'granted', 'client_request') is not null,
  'the client opts back in'
);
reset role;

select ok(
  public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                            'email', 'availability_announcement'),
  'marketing resumes'
);

-- An unsubscribe is a marketing instruction and must not stop a service message
-- about an appointment the client booked.
insert into public.communication_suppressions (client_id, channel, reason)
values ('b6111111-1111-4111-8111-111111111111', 'email', 'unsubscribed');

select ok(
  not public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                                'email', 'availability_announcement'),
  'an unsubscribe stops marketing even while consent says granted'
);
select ok(
  public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                            'email', 'session_reminder_24h'),
  'but does not stop the reminder for work they booked'
);

update public.communication_suppressions
set is_active = false, released_at = now()
where reason = 'unsubscribed';

-- Every other reason means the address itself is unusable, so it stops service
-- traffic too: a bounced address cannot receive a message they did consent to.
insert into public.communication_suppressions (client_id, channel, reason)
values ('b6111111-1111-4111-8111-111111111111', 'email', 'bounced');

select ok(
  not public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                                'email', 'session_reminder_24h'),
  'a bounced address stops service traffic as well'
);
select ok(
  not public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                                'email', 'availability_announcement'),
  'and marketing, whatever consent says'
);
select is(
  crm_private.client_send_block_reason('b6111111-1111-4111-8111-111111111111',
                                       'email', 'service'),
  'suppressed',
  'the refusal names suppression'
);
select ok(
  public.may_contact_client('b6111111-1111-4111-8111-111111111111',
                            'whatsapp', 'session_reminder_24h'),
  'a suppression on one channel does not silence the others'
);

-- Releasing is recorded rather than deleted, so the history survives.
select is(
  (select count(*)::int from public.communication_suppressions
   where client_id = 'b6111111-1111-4111-8111-111111111111'),
  2,
  'a released suppression is kept as history'
);

-- ---------------------------------------------------------------------------
-- An archived client is contacted about nothing
-- ---------------------------------------------------------------------------

select ok(
  not public.may_contact_client('b6333333-3333-3333-8333-333333333333'::uuid,
                                'email', 'session_reminder_24h'),
  'an unknown client id is refused'
);
select is(
  crm_private.client_send_block_reason('b6333333-3333-4333-8333-333333333333',
                                       'email', 'service'),
  'client_archived',
  'an archived client is not contacted, even for service traffic'
);

-- ---------------------------------------------------------------------------
-- Templates: no template language
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.tpl_as('b9222222-2222-4222-8222-222222222222');

select lives_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'session_reminder_24h', 'email'::public.message_template_channel,
      'Hi {{client_first_name}}, your appointment with {{artist_display_name}} is on {{appointment_date}}.',
      'en', 'Your appointment tomorrow')$$,
  'a workspace admin may write a template using catalogued variables'
);

select throws_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'session_reminder_24h', 'whatsapp'::public.message_template_channel,
      'Hi {{clients.email}}, see you soon.')$$,
  '23514', null,
  'a body cannot reference a column through an uncatalogued variable'
);
select throws_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'session_reminder_24h', 'whatsapp'::public.message_template_channel,
      'Hi {{ 1+1 }}, see you soon.')$$,
  '23514', null,
  'and cannot smuggle an expression into one'
);
select throws_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'not_a_real_purpose', 'email'::public.message_template_channel, 'Body')$$,
  '22023', null,
  'an uncatalogued purpose is refused'
);
reset role;

-- A template is created as a draft, so nothing can select copy nobody approved.
select is(
  (select count(*)::int from public.message_templates where status = 'active'),
  0,
  'a new template is a draft until somebody activates it'
);

select is(
  (select count(*)::int from public.resolve_message_template(
     'b8111111-1111-4111-8111-111111111111', 'session_reminder_24h', 'email')),
  0,
  'and a draft is never resolved for sending'
);

-- ---------------------------------------------------------------------------
-- Scope: workspace default, artist override, and no crossing
-- ---------------------------------------------------------------------------

update public.message_templates set status = 'active';

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select is(
  (select scope from public.resolve_message_template(
     'b8111111-1111-4111-8111-111111111111', 'session_reminder_24h', 'email')),
  'workspace',
  'an artist with no override resolves the workspace template'
);
reset role;

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select lives_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'session_reminder_24h', 'email'::public.message_template_channel,
      'Alice here — see you on {{appointment_date}}.',
      'en', 'See you tomorrow',
      'b8111111-1111-4111-8111-111111111111'::uuid)$$,
  'the artist may write their own override'
);
select throws_ok(
  $$select public.upsert_message_template(
      'b7111111-1111-4111-8111-111111111111'::uuid,
      'studio_news', 'email'::public.message_template_channel,
      'News', 'en', 'News', 'b8222222-2222-4222-8222-222222222222'::uuid)$$,
  '42501', null,
  'and cannot write copy for an artist in another workspace'
);
reset role;

update public.message_templates set status = 'active'
where artist_id = 'b8111111-1111-4111-8111-111111111111';

set local role authenticated;
select pg_temp.tpl_as('b9111111-1111-4111-8111-111111111111');
select is(
  (select scope from public.resolve_message_template(
     'b8111111-1111-4111-8111-111111111111', 'session_reminder_24h', 'email')),
  'artist',
  'an artist override wins over the workspace default'
);
select is(
  (select classification::text from public.resolve_message_template(
     'b8111111-1111-4111-8111-111111111111', 'session_reminder_24h', 'email')),
  'service',
  'and the resolved template carries the classification its purpose decides'
);
reset role;

-- An artist template must belong to the workspace that owns it, whatever a
-- direct insert claims.
select throws_ok(
  $$insert into public.message_templates
      (workspace_id, artist_id, purpose, channel, body)
    values ('b7111111-1111-4111-8111-111111111111',
            'b8222222-2222-4222-8222-222222222222',
            'studio_news', 'email', 'Cross workspace')$$,
  '23514', null,
  'a cross-workspace artist template is refused at the table'
);

-- Two active templates for the same slot would make selection a coin toss.
select throws_ok(
  $$insert into public.message_templates
      (workspace_id, purpose, channel, locale, body, status)
    values ('b7111111-1111-4111-8111-111111111111',
            'session_reminder_24h', 'email', 'en', 'Duplicate', 'active')$$,
  '23505', null,
  'a second active workspace template for the same slot is refused'
);

-- ---------------------------------------------------------------------------
-- Client automation is now explicit, and the old tripwire becomes a contract.
-- Tests 240/241 prove this action is wired through the service-purpose,
-- suppression, template, artist/session and Gmail gates above rather than
-- bypassing them.
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(e.enumlabel::text order by e.enumsortorder)
   from pg_type t
   join pg_enum e on e.enumtypid = t.oid
   join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
     and t.typname = 'automation_action_type'),
  array['notify_artist_team','send_client_message'],
  'the automation action catalogue contains only the reviewed staff and gated client actions'
);

select * from finish(true);
rollback;