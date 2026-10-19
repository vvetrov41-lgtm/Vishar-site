-- 340_standalone_client_cards.sql
--
-- Migration 20261019200000: a client card created from a conversation works
-- without an enquiry, project or session.
--
-- Regression for the 2026-10-19 incident: create_client_from_communication
-- reported success, then crm_get_client returned not_found, client search
-- returned nothing, crm_update_client returned permission_denied and an
-- internal note failed with "client has no artist-scoped record". The same
-- RPC also rejected every email address.
--
-- Everything here is synthetic.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Hardening of the new surface
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.client_artist_links', 'INSERT')
  and not has_table_privilege('authenticated', 'public.client_artist_links', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.client_artist_links', 'DELETE'),
  'a browser cannot write a client/artist link directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.client_privacy_acknowledgements', 'INSERT')
  and not has_table_privilege('authenticated', 'public.client_privacy_acknowledgements', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.client_privacy_acknowledgements', 'DELETE'),
  'a browser cannot write a privacy acknowledgement directly'
);
select ok(
  not has_table_privilege('anon', 'public.client_artist_links', 'SELECT')
  and not has_table_privilege('anon', 'public.client_privacy_acknowledgements', 'SELECT'),
  'anon reads neither new table'
);
select ok(
  not has_function_privilege('anon', 'public.create_client_from_communication(uuid,text,text,text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.create_client_from_communication(uuid,text,text,text,text,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_client_from_communication(uuid,text,text,text,text,boolean)', 'EXECUTE'),
  'only a signed-in CRM session can create a client from a conversation'
);
select ok(
  not has_function_privilege('anon', 'public.record_client_privacy_acknowledgement(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.record_client_privacy_acknowledgement(uuid,uuid)', 'EXECUTE'),
  'only a signed-in CRM session can record a privacy acknowledgement'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.record_client_privacy_acknowledgement(uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.client_artist_ids(uuid)', 'EXECUTE'),
  'the private helpers are not browser executable'
);
select ok(
  (select bool_and(
     p.prosecdef
     and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   )
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'create_client_from_communication',
       'gpt_create_client_from_communication',
       'record_client_privacy_acknowledgement',
       'link_communication_conversation_client'
     )),
  'every changed RPC is SECURITY DEFINER with a fixed search_path'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
   'vladimir-production', '{}'::jsonb, true),
  ('a2222222-2222-4222-8222-222222222222', 'whatsapp', 'meta_cloud_api',
   'kristina-production', '{}'::jsonb, true);

select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700934001', 'wamid.STANDALONE0001', '2026-10-19 18:00:00+00',
  'text', 'Hi, I had a session with you before'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700934002', 'wamid.STANDALONE0002', '2026-10-19 18:05:00+00',
  'text', 'Second sender'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700934003', 'wamid.STANDALONE0003', '2026-10-19 18:10:00+00',
  'text', 'Third sender'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700934004', 'wamid.STANDALONE0004', '2026-10-19 18:12:00+00',
  'text', 'Fourth sender'
);
select public.record_communication_inbound_message(
  'a2222222-2222-4222-8222-222222222222', 'whatsapp', 'kristina-production',
  '447700934009', 'wamid.STANDALONE0009', '2026-10-19 18:15:00+00',
  'text', 'Kristina sender'
);

insert into auth.users (id, email) values
  ('fa011111-1111-4111-8111-111111111111', 'standalone.vladimir@example.test'),
  ('fa022222-2222-4222-8222-222222222222', 'standalone.kristina@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa011111-1111-4111-8111-111111111111', 'standalone.vladimir@example.test',
   'Standalone Vladimir Manager', 'booking_manager', true),
  ('fa022222-2222-4222-8222-222222222222', 'standalone.kristina@example.test',
   'Standalone Kristina Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('fa011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('fa022222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'manager', false, false, true, false, true);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-gpt-standalone-test',
    can_manage_communications = true,
    can_manage_crm = true,
    can_read_appointments = true,
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.claims(p text) returns void language sql as
  $$select set_config('request.jwt.claims', p, true)::void$$;
grant execute on function pg_temp.claims(text) to authenticated;

create function pg_temp.conversation_for(p_contact text) returns uuid
  language sql stable security definer as
  $$select id from public.communication_conversations where external_contact_id = p_contact$$;
grant execute on function pg_temp.conversation_for(text) to authenticated;

-- Fixture inspection that the role-switched session cannot do itself.
create function pg_temp.count_where(p_sql text) returns integer
  language plpgsql security definer as
  $$declare v integer; begin execute p_sql into v; return v; end$$;
grant execute on function pg_temp.count_where(text) to authenticated;

create temporary table standalone_ids (key text primary key, id uuid not null);
grant select, insert on standalone_ids to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Create a standalone card from WhatsApp (the Adelino case)
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"fa011111-1111-4111-8111-111111111111","role":"authenticated"}');

select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934001'),
      'Bad Email Client', 'not-an-email', null, null, false)$$,
  '22023', 'that email address is not valid',
  'a malformed email is still refused'
);

insert into standalone_ids (key, id)
select 'client', (public.create_client_from_communication(
  pg_temp.conversation_for('447700934001'),
  'Synthetic Adelino', 'adelino.synthetic@live.co.uk', '+44 7700 934001', null, true
) ->> 'client_id')::uuid;

select ok(
  (select id from standalone_ids where key = 'client') is not null,
  'a client is created from a WhatsApp conversation with a co.uk email address'
);
select is(
  (select email from public.clients where id = (select id from standalone_ids where key = 'client')),
  'adelino.synthetic@live.co.uk',
  'the email is stored as entered'
);
select is(
  (select phone_normalized from public.clients where id = (select id from standalone_ids where key = 'client')),
  '+447700934001',
  'the phone is stored and normalised'
);
select is(
  pg_temp.count_where(format(
    $q$select (select count(*) from public.enquiries where client_id = %L)
            + (select count(*) from public.projects where client_id = %L)
            + (select count(*) from public.sessions where client_id = %L)$q$,
    (select id from standalone_ids where key = 'client'),
    (select id from standalone_ids where key = 'client'),
    (select id from standalone_ids where key = 'client'))),
  0,
  'no enquiry, project or session is invented for the card'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.client_artist_links
       where client_id = %L and artist_id = 'a1111111-1111-4111-8111-111111111111'
         and source = 'communication_client_created'$q$,
    (select id from standalone_ids where key = 'client'))),
  1,
  'the card is linked directly to the conversation artist'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.communication_conversations
       where id = %L and client_id = %L and link_state = 'linked'$q$,
    pg_temp.conversation_for('447700934001'),
    (select id from standalone_ids where key = 'client'))),
  1,
  'the existing conversation is linked to the new card'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.communication_messages where conversation_id = %L$q$,
    pg_temp.conversation_for('447700934001'))),
  1,
  'the conversation keeps its message history, without duplicates'
);

-- ---------------------------------------------------------------------------
-- 2. Privacy acknowledgement is recorded with audit data
-- ---------------------------------------------------------------------------

select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.client_privacy_acknowledgements
       where client_id = %L
         and artist_id = 'a1111111-1111-4111-8111-111111111111'
         and source = 'communication_client_created'
         and basis = 'staff_confirmed'
         and recorded_by = 'fa011111-1111-4111-8111-111111111111'
         and communication_conversation_id = %L
         and acknowledged_at is not null
         and privacy_notice_version <> ''$q$,
    (select id from standalone_ids where key = 'client'),
    pg_temp.conversation_for('447700934001'))),
  1,
  'the staff-confirmed acknowledgement records time, source, actor and conversation'
);
select is(
  (select count(*)::int from public.client_privacy_acknowledgements
   where client_id = (select id from standalone_ids where key = 'client')),
  1,
  'the manager can read the acknowledgement on the card'
);

-- ---------------------------------------------------------------------------
-- 3. Replay is safe
-- ---------------------------------------------------------------------------

select is(
  public.create_client_from_communication(
    pg_temp.conversation_for('447700934001'),
    'Synthetic Adelino', 'adelino.synthetic@live.co.uk', '+44 7700 934001', null, true
  ) ->> 'replayed',
  'true',
  'retrying the same create returns the existing card'
);
select is(
  pg_temp.count_where($q$select count(*) from public.clients where full_name = 'Synthetic Adelino'$q$),
  1,
  'a retry does not create a second card'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.client_privacy_acknowledgements where client_id = %L$q$,
    (select id from standalone_ids where key = 'client'))),
  1,
  'a retry does not record a second acknowledgement'
);
select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934001'),
      'Somebody Else', null, null, null, false)$$,
  '23514', null,
  'a linked conversation cannot be re-pointed to a different new client'
);
select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934001'),
      'Synthetic Adelino', 'someone.else@example.test', '+44 7700 934001', null, false)$$,
  '23514', null,
  'a retry with different identifiers is not treated as a replay'
);
select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934002'),
      'Duplicate By Email', 'ADELINO.synthetic@live.co.uk', null, null, false)$$,
  '23505', null,
  'a second card with the same normalised email is refused'
);
select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934002'),
      'Duplicate By Phone', null, '0044 7700-934-001', null, false)$$,
  '23505', null,
  'a second card with the same normalised phone is refused'
);

-- ---------------------------------------------------------------------------
-- 4. The card works through every standard CRM operation
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.clients
   where id = (select id from standalone_ids where key = 'client')),
  1,
  'the card is visible in the CRM client list'
);
select ok(
  public.can_manage_client((select id from standalone_ids where key = 'client')),
  'the artist manager can manage the card'
);
select is(
  public.update_client_details(
    (select id from standalone_ids where key = 'client'),
    jsonb_build_object('travelling_from', 'London', 'email', 'adelino.updated@live.co.uk')
  ) ->> 'client_id',
  (select id::text from standalone_ids where key = 'client'),
  'the card can be edited'
);
select is(
  (select email from public.clients where id = (select id from standalone_ids where key = 'client')),
  'adelino.updated@live.co.uk',
  'the edit is stored'
);
select ok(
  public.create_internal_note(
    'Synthetic note on a standalone card',
    (select id from standalone_ids where key = 'client')
  ) is not null,
  'an internal note can be added to the card itself'
);
select is(
  (select count(*)::int from public.internal_notes
   where client_id = (select id from standalone_ids where key = 'client')),
  1,
  'the note is readable on the card'
);

-- ---------------------------------------------------------------------------
-- 5. A card without an acknowledgement can record one later
-- ---------------------------------------------------------------------------

insert into standalone_ids (key, id)
select 'second', (public.create_client_from_communication(
  pg_temp.conversation_for('447700934002'), 'Synthetic Second Client'
) ->> 'client_id')::uuid;

select is(
  (select count(*)::int from public.client_privacy_acknowledgements
   where client_id = (select id from standalone_ids where key = 'second')),
  0,
  'the five-argument contract creates a card without an acknowledgement'
);
select is(
  public.record_client_privacy_acknowledgement((select id from standalone_ids where key = 'second'))
    ->> 'privacy_acknowledgement_replayed',
  'false',
  'staff can record the acknowledgement on an existing card'
);
select is(
  public.record_client_privacy_acknowledgement((select id from standalone_ids where key = 'second'))
    ->> 'privacy_acknowledgement_replayed',
  'true',
  'recording it again keeps the original'
);

reset role;

select throws_ok(
  format(
    $q$update public.client_privacy_acknowledgements
       set acknowledged_at = acknowledged_at - interval '30 days'
       where client_id = %L$q$,
    (select id from standalone_ids where key = 'second')),
  '55000', null,
  'an acknowledgement cannot be back-dated or rewritten'
);

-- ---------------------------------------------------------------------------
-- 6. Linking an existing card, and re-linking without duplicates
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"fa011111-1111-4111-8111-111111111111","role":"authenticated"}');

select is(
  public.link_communication_conversation_client(
    pg_temp.conversation_for('447700934003'),
    (select id from standalone_ids where key = 'client')
  ) ->> 'replayed',
  'false',
  'an existing standalone card can be linked to another conversation'
);
select is(
  public.link_communication_conversation_client(
    pg_temp.conversation_for('447700934003'),
    (select id from standalone_ids where key = 'client')
  ) ->> 'replayed',
  'true',
  'repeating the same link is a no-op'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.client_artist_links where client_id = %L$q$,
    (select id from standalone_ids where key = 'client'))),
  1,
  're-linking does not duplicate the client/artist link'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.activity_log
       where client_id = %L and event_type = 'communication.client_linked'$q$,
    (select id from standalone_ids where key = 'client'))),
  1,
  're-linking does not write a second audit row'
);
select throws_ok(
  $$select public.create_client_from_communication(
      pg_temp.conversation_for('447700934003'),
      'Synthetic Adelino', 'adelino.synthetic@live.co.uk', '+44 7700 934001', null, true)$$,
  '23514', null,
  'a stale create on a conversation linked to an existing card is refused, not replayed'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7. The GPT tools see the same card
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims(
  '{"sub":"fa011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-gpt-standalone-test"}'
);

select is(
  public.gpt_artist_context('a1111111-1111-4111-8111-111111111111') ->> 'active_artist_id',
  'a1111111-1111-4111-8111-111111111111',
  'the GPT works in Vladimir context'
);
select is(
  (select full_name from public.gpt_get_client((select id from standalone_ids where key = 'client'))),
  'Synthetic Adelino',
  'crm_get_client returns the standalone card'
);
select ok(
  exists (select 1 from public.gpt_list_clients(50)
          where client_id = (select id from standalone_ids where key = 'client')),
  'crm_list_clients includes the standalone card'
);
select is(
  (select count(*)::int from public.gpt_search_clients('Synthetic Adelino', 10)),
  1,
  'crm_search_appointment_clients finds a client with no sessions'
);
select is(
  public.gpt_update_client(
    (select id from standalone_ids where key = 'client'),
    jsonb_build_object('preferred_contact', 'WhatsApp')
  ) ->> 'client_id',
  (select id::text from standalone_ids where key = 'client'),
  'crm_update_client edits the standalone card'
);
select ok(
  (public.gpt_create_internal_note(
    'Synthetic GPT note',
    (select id from standalone_ids where key = 'client')
  ) ->> 'note_id') is not null,
  'crm_create_internal_note adds a note to the standalone card'
);

insert into standalone_ids (key, id)
select 'gpt', (public.gpt_create_client_from_communication(
  pg_temp.conversation_for('447700934004'), 'Synthetic GPT Client',
  'gpt.client@example.co.uk', null, null, true
) ->> 'client_id')::uuid;

select is(
  (select full_name from public.gpt_get_client((select id from standalone_ids where key = 'gpt'))),
  'Synthetic GPT Client',
  'crm_create_client_from_communication produces a card the GPT can read straight away'
);
select is(
  pg_temp.count_where(format(
    $q$select count(*) from public.client_privacy_acknowledgements where client_id = %L$q$,
    (select id from standalone_ids where key = 'gpt'))),
  1,
  'the GPT create path records the confirmed acknowledgement'
);

reset role;

-- ---------------------------------------------------------------------------
-- 8. Vladimir and Kristina stay isolated
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"fa022222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(
  (select count(*)::int from public.clients
   where id = (select id from standalone_ids where key = 'client')),
  0,
  'Kristina does not see Vladimir''s standalone card'
);
select is(
  (select count(*)::int from public.client_artist_links
   where client_id = (select id from standalone_ids where key = 'client')),
  0,
  'Kristina does not see Vladimir''s client/artist link'
);
select is(
  (select count(*)::int from public.client_privacy_acknowledgements
   where client_id = (select id from standalone_ids where key = 'client')),
  0,
  'Kristina does not see Vladimir''s privacy acknowledgement'
);
select throws_ok(
  format($q$select public.update_client_details(%L, '{"travelling_from":"Paris"}'::jsonb)$q$,
         (select id from standalone_ids where key = 'client')),
  '42501', null,
  'Kristina cannot edit Vladimir''s standalone card'
);
select throws_ok(
  format($q$select public.create_internal_note('cross-artist note', %L)$q$,
         (select id from standalone_ids where key = 'client')),
  '42501', null,
  'Kristina cannot add a note to Vladimir''s standalone card'
);
select throws_ok(
  format($q$select public.record_client_privacy_acknowledgement(%L)$q$,
         (select id from standalone_ids where key = 'second')),
  '42501', null,
  'Kristina cannot record consent on Vladimir''s card'
);
select is(
  public.create_client_from_communication(
    pg_temp.conversation_for('447700934009'),
    'Synthetic Kristina Client', null, null, null, true
  ) ->> 'privacy_notice_version',
  '2026-10-12',
  'a Kristina card records Kristina''s own privacy notice version'
);
select throws_ok(
  format($q$select public.link_communication_conversation_client(%L, %L)$q$,
         pg_temp.conversation_for('447700934009'),
         (select id from standalone_ids where key = 'client')),
  '42501', null,
  'Vladimir''s card cannot be attached to a Kristina conversation'
);

reset role;

set local role authenticated;
select pg_temp.claims(
  '{"sub":"fa022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-gpt-standalone-test"}'
);
select is(
  public.gpt_artist_context('a2222222-2222-4222-8222-222222222222') ->> 'active_artist_id',
  'a2222222-2222-4222-8222-222222222222',
  'the GPT works in Kristina context'
);
select is(
  (select count(*)::int from public.gpt_get_client((select id from standalone_ids where key = 'client'))),
  0,
  'the Kristina GPT cannot read Vladimir''s standalone card'
);
select is(
  (select count(*)::int from public.gpt_search_clients('Synthetic Adelino', 10)),
  0,
  'the Kristina GPT cannot find Vladimir''s standalone card'
);
select throws_ok(
  format($q$select public.gpt_update_client(%L, '{"travelling_from":"Paris"}'::jsonb)$q$,
         (select id from standalone_ids where key = 'client')),
  '42501', null,
  'the Kristina GPT cannot edit Vladimir''s standalone card'
);
reset role;

-- ---------------------------------------------------------------------------
-- 9. Shared clients inside one studio keep the existing GPT restriction
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fa200000-0000-4000-8000-000000000001', 'standalone-shared-studio',
   'Standalone Shared Studio', 'studio', true);
insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fa300000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001',
   'standalone-studio-one', 'Studio Artist One', true),
  ('fa300000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000001',
   'standalone-studio-two', 'Studio Artist Two', true);
insert into public.clients (id, workspace_id, full_name) values
  ('fa400000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001',
   'Synthetic Shared Studio Client');
insert into public.enquiries
  (id, client_id, idempotency_key, intake_fingerprint, intake_state,
   submitted_full_name, submitted_email, privacy_notice_version,
   privacy_acknowledged_at, artist_id)
values
  ('fa500000-0000-4000-8000-000000000001', 'fa400000-0000-4000-8000-000000000001',
   'fa600000-0000-4000-8000-000000000001', repeat('d', 64), 'complete',
   'Synthetic Shared Studio Client', 'shared.studio@example.test', '2026-07-29', now(),
   'fa300000-0000-4000-8000-000000000001');
insert into public.client_artist_links (client_id, artist_id, source) values
  ('fa400000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000002',
   'communication_linked');

select ok(
  crm_private.client_in_artist_scope('fa400000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000002'),
  'a direct link puts a studio client in the second artist scope'
);
select ok(
  crm_private.gpt_client_has_other_artist_scope('fa400000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000002'),
  'the same client is still shared with the first artist'
);
select throws_ok(
  $$select crm_private.require_gpt_client_exclusive(
      'fa400000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000002')$$,
  '42501', null,
  'an artist-scoped GPT still cannot change a shared client'
);
select ok(
  not crm_private.client_in_artist_scope('fa400000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111'),
  'a studio client is never in another workspace artist scope'
);
select throws_ok(
  $$insert into public.client_artist_links (client_id, artist_id, source)
    values ('fa400000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 'communication_linked')$$,
  '23514', null,
  'a client cannot be linked to an artist in another workspace'
);

insert into auth.users (id, email) values
  ('fa033333-3333-4333-8333-333333333333', 'standalone.studio@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa033333-3333-4333-8333-333333333333', 'standalone.studio@example.test',
   'Standalone Studio Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fa033333-3333-4333-8333-333333333333', 'fa300000-0000-4000-8000-000000000001',
   'manager', false, false, true, false, true, 'explicit'),
  ('fa033333-3333-4333-8333-333333333333', 'fa300000-0000-4000-8000-000000000002',
   'manager', false, false, true, false, true, 'explicit');

set local role authenticated;
select pg_temp.claims('{"sub":"fa033333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  $$select public.record_client_privacy_acknowledgement('fa400000-0000-4000-8000-000000000001')$$,
  '22023', null,
  'a shared card needs the artist whose notice is acknowledged'
);
select is(
  public.record_client_privacy_acknowledgement(
    'fa400000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000002'
  ) ->> 'privacy_acknowledgement_replayed',
  'false',
  'a manager of both artists records the acknowledgement for the named artist'
);
select throws_ok(
  $$select public.record_client_privacy_acknowledgement(
      'fa400000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'an artist the client is not linked to cannot be named'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- 10. The backfill covers cards that existed only through a conversation
-- ---------------------------------------------------------------------------

select ok(
  not exists (
    select 1
    from public.communication_conversations c
    join public.clients cl on cl.id = c.client_id
    where c.client_id is not null
      and cl.archived_at is null
      and not exists (
        select 1 from public.client_artist_links l
        where l.client_id = c.client_id and l.artist_id = c.artist_id
      )
      and not exists (select 1 from public.enquiries e where e.client_id = c.client_id)
      and not exists (select 1 from public.projects p where p.client_id = c.client_id)
  ),
  'no active conversation-only card is left without a direct artist link'
);

select * from finish();
rollback;
