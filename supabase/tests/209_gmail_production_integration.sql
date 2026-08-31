-- 209_gmail_production_integration.sql
--
-- Production Gmail data-contract regression. No Google API is called.
-- Verifies backend-only credential/thread custody, artist isolation, minimal
-- scope metadata and lease/result RPC ACLs on synthetic local CI data.

begin;
select no_plan();

select has_table('crm_private', 'gmail_thread_contexts',
  'provider Gmail thread identifiers live in the private schema');
select has_column('public', 'email_messages', 'gmail_thread_context_id',
  'CRM email state stores only an opaque Gmail context UUID');

select has_function('public', 'gpt_authorize_gmail_enquiry', array['uuid'],
  'GPT has a bounded enquiry authorization RPC');
select has_function('public', 'gpt_create_gmail_reply_draft', array['uuid','uuid','text'],
  'GPT has a bounded Gmail reply-draft RPC');
select has_function('public', 'service_resolve_gmail_mailbox', array['uuid'],
  'artist mailbox resolution exists for discovery');
select has_function('public', 'service_match_gmail_clients', array['uuid','text[]'],
  'Gmail address-to-client matching exists');
select ok(
  not has_function_privilege('authenticated', 'public.service_match_gmail_clients(uuid,text[])', 'EXECUTE'),
  'Gmail client matching is not reachable from a browser session'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_resolve_gmail_mailbox(uuid)', 'EXECUTE'),
  'artist mailbox resolution is not reachable from a browser session'
);

select has_function('public', 'service_resolve_gmail_client_target', array['uuid','uuid'],
  'client-scoped Gmail target resolution exists');
select ok(
  not has_function_privilege('authenticated', 'public.service_resolve_gmail_client_target(uuid,uuid)', 'EXECUTE'),
  'client-scoped Gmail target resolution is not reachable from a browser session'
);

select has_function('public', 'service_resolve_gmail_target', array['uuid','uuid','uuid'],
  'backend can resolve the authoritative Gmail CRM target');
select has_function('public', 'service_set_gmail_integration', array['uuid','text','text','text[]'],
  'backend can bind a verified artist Gmail account');
select has_function('public', 'service_get_gmail_thread_context', array['uuid','uuid','uuid','uuid'],
  'backend can resolve an opaque thread context');
select has_function('public', 'claim_email_outbox', array['text','integer','integer'],
  'Gmail drain has a backend-only lease RPC');
select has_function('public', 'record_email_outbox_result', array['uuid','text','boolean','text','text'],
  'Gmail drain has a backend-only result RPC');

select ok(
  has_function_privilege('authenticated', 'public.gpt_authorize_gmail_enquiry(uuid)', 'EXECUTE'),
  'authenticated GPT sessions can call the bounded enquiry authorization RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_create_gmail_reply_draft(uuid,uuid,text)', 'EXECUTE'),
  'authenticated GPT sessions can create bounded Gmail reply drafts'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_resolve_gmail_target(uuid,uuid,uuid)', 'EXECUTE'),
  'browser/GPT sessions cannot resolve Gmail provider routing metadata'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_set_gmail_integration(uuid,text,text,text[])', 'EXECUTE'),
  'browser/GPT sessions cannot bind Gmail accounts'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_get_gmail_thread_context(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'browser/GPT sessions cannot resolve raw provider thread identifiers'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_email_outbox(text,integer,integer)', 'EXECUTE'),
  'browser/GPT sessions cannot lease approved email jobs'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_email_outbox_result(uuid,text,boolean,text,text)', 'EXECUTE'),
  'browser/GPT sessions cannot acknowledge Gmail sends'
);
select ok(
  has_function_privilege('service_role', 'public.service_resolve_gmail_target(uuid,uuid,uuid)', 'EXECUTE'),
  'trusted backend can resolve Gmail routing metadata'
);
select ok(
  has_function_privilege('service_role', 'public.claim_email_outbox(text,integer,integer)', 'EXECUTE'),
  'trusted backend can lease approved email jobs'
);
select ok(
  has_function_privilege('service_role', 'public.record_email_outbox_result(uuid,text,boolean,text,text)', 'EXECUTE'),
  'trusted backend can acknowledge Gmail sends'
);
select ok(
  not has_table_privilege('authenticated', 'crm_private.gmail_thread_contexts', 'SELECT'),
  'raw Gmail thread identifiers are not readable by browser/GPT sessions'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.service_set_gmail_integration(
      'a1111111-1111-4111-8111-111111111111',
      'google_gmail_vladimir',
      'vvetrov41@gmail.com',
      array['https://www.googleapis.com/auth/gmail.readonly']::text[]
    )$$,
  '22023',
  'required Gmail scopes were not granted',
  'Gmail binding fails closed when gmail.send is missing'
);

select throws_ok(
  $$select public.service_set_gmail_integration(
      'a1111111-1111-4111-8111-111111111111',
      'google_gmail_vladimir',
      'vvetrov41@gmail.com',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://mail.google.com/'
      ]::text[]
    )$$,
  '22023',
  'full Gmail mailbox scope is forbidden',
  'full Gmail mailbox scope is rejected even when narrower scopes are present'
);

select lives_ok(
  $$select public.service_set_gmail_integration(
      'a1111111-1111-4111-8111-111111111111',
      'google_gmail_vladimir',
      'vvetrov41@gmail.com',
      array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send'
      ]::text[]
    )$$,
  'verified Vladimir Gmail routing metadata can be enabled with minimal scopes'
);

select is(
  (select provider from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'email' and is_enabled),
  'google',
  'enabled Gmail route is the Google provider'
);
select is(
  (select integration_key from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'email' and is_enabled),
  'google_gmail_vladimir',
  'enabled Gmail route uses the artist-specific integration key'
);
select is(
  (select external_account_label from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'email' and is_enabled),
  'vvetrov41@gmail.com',
  'only verified mailbox identity is stored as safe routing metadata'
);
select ok(
  (select configuration ? 'scopes'
      and configuration ->> 'credential_custody' = 'backend_only'
      and not configuration ? 'access_token'
      and not configuration ? 'refresh_token'
      and not configuration ? 'client_secret'
   from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'email' and is_enabled),
  'artist_integrations contains safe scope/custody metadata but no provider credentials'
);

-- Clients are shared canonical people. Artist isolation is carried by the
-- enquiry/project rows, not by a clients.artist_id column.
insert into public.clients (id, full_name, email) values
  ('e0911111-1111-4111-8111-111111111111',
   'Synthetic Gmail Client', 'gmail-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e0921111-1111-4111-8111-111111111111',
  'e0911111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e0931111-1111-4111-8111-111111111111', repeat('e', 64),
  'accepted', 'complete', 'Synthetic Gmail Client',
  'gmail-client@example.test', '2026-08-05', now()
);

create temporary table gmail_context as
select public.service_upsert_gmail_thread_context(
  'a1111111-1111-4111-8111-111111111111',
  'e0921111-1111-4111-8111-111111111111',
  'e0911111-1111-4111-8111-111111111111',
  'thread_synthetic_1234',
  'Synthetic Gmail subject',
  'message_synthetic_1234',
  '<synthetic-message@example.test>'
) as id;

select ok((select id is not null from gmail_context),
  'trusted backend can persist one opaque CRM thread context');

select is(
  (select subject from public.service_get_gmail_thread_context(
    (select id from gmail_context),
    'a1111111-1111-4111-8111-111111111111',
    'e0921111-1111-4111-8111-111111111111',
    'e0911111-1111-4111-8111-111111111111'
  )),
  'Synthetic Gmail subject',
  'thread context resolves only through exact artist/client/enquiry binding'
);

select throws_ok(
  format(
    'select * from public.service_get_gmail_thread_context(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
    (select id from gmail_context),
    'a2222222-2222-4222-8222-222222222222',
    'e0921111-1111-4111-8111-111111111111',
    'e0911111-1111-4111-8111-111111111111'
  ),
  '22023',
  'Gmail CRM target is unavailable',
  'Kristina artist scope cannot resolve Vladimir CRM/Gmail thread context'
);

-- ---------------------------------------------------------------------------
-- Client-scoped discovery (0122)
--
-- Reading a client's correspondence must not require naming an enquiry, because
-- Gmail matches on the client's address and asking once per enquiry would bind
-- one conversation to several. It must still prove the artist actually knows
-- the client.
-- ---------------------------------------------------------------------------

select is(
  (select client_email from public.service_resolve_gmail_client_target(
    'a1111111-1111-4111-8111-111111111111',
    'e0911111-1111-4111-8111-111111111111'
  )),
  'gmail-client@example.test',
  'a client with an enquiry for this artist resolves without naming the enquiry'
);

select throws_ok(
  $$select * from public.service_resolve_gmail_client_target(
      'a2222222-2222-4222-8222-222222222222',
      'e0911111-1111-4111-8111-111111111111'
    )$$,
  '22023',
  'Gmail CRM target is unavailable',
  'an artist with no enquiry for this client cannot read their mailbox'
);

select throws_ok(
  $$select * from public.service_resolve_gmail_client_target(
      'a1111111-1111-4111-8111-111111111111',
      null
    )$$,
  '22023',
  'Gmail CRM target is unavailable',
  'a missing client is refused rather than resolving the whole mailbox'
);

-- ---------------------------------------------------------------------------
-- Known-client discovery (0123)
--
-- Discovery reads the mailbox before it knows who anyone is, so the database
-- decides which addresses belong to clients this artist already knows. An
-- address it cannot name must simply not come back.
-- ---------------------------------------------------------------------------

select is(
  (select mailbox_email from public.service_resolve_gmail_mailbox(
    'a1111111-1111-4111-8111-111111111111'
  )),
  'vvetrov41@gmail.com',
  'the artist mailbox resolves without naming a client or an enquiry'
);

select is(
  (select client_id from public.service_match_gmail_clients(
    'a1111111-1111-4111-8111-111111111111',
    array['gmail-client@example.test']
  )),
  'e0911111-1111-4111-8111-111111111111'::uuid,
  'an address belonging to a client this artist knows resolves to that client'
);

select is(
  (select count(*)::int from public.service_match_gmail_clients(
    'a1111111-1111-4111-8111-111111111111',
    array['  GMAIL-CLIENT@Example.Test  ']
  )),
  1,
  'matching is case and whitespace insensitive, as stored client email is'
);

select is(
  (select count(*)::int from public.service_match_gmail_clients(
    'a1111111-1111-4111-8111-111111111111',
    array['stranger@example.test', 'nobody@example.test']
  )),
  0,
  'an unknown sender is not returned at all, so nothing downstream has to exclude it'
);

select is(
  (select count(*)::int from public.service_match_gmail_clients(
    'a2222222-2222-4222-8222-222222222222',
    array['gmail-client@example.test']
  )),
  0,
  'an artist who does not know this client cannot resolve their address'
);

-- One person with several enquiries is still one person. This is the shape that
-- would otherwise put the same Gmail conversation in the queue three times.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('e0941111-1111-4111-8111-111111111111',
   'e0911111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'e0951111-1111-4111-8111-111111111111', repeat('f', 64),
   'accepted', 'complete', 'Synthetic Gmail Client',
   'gmail-client@example.test', '2026-08-05', now()),
  ('e0961111-1111-4111-8111-111111111111',
   'e0911111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'PENDING', 'e0971111-1111-4111-8111-111111111111', repeat('a', 64),
   'accepted', 'complete', 'Synthetic Gmail Client',
   'gmail-client@example.test', '2026-08-05', now());

select is(
  (select count(*)::int from public.service_match_gmail_clients(
    'a1111111-1111-4111-8111-111111111111',
    array['gmail-client@example.test']
  )),
  1,
  'a client with three enquiries resolves to exactly one row, not one per enquiry'
);

-- Discovery is a read. If it ever became anything else, this would catch it.
select is(
  (select count(*)::int from crm_private.gmail_thread_contexts
   where client_id = 'e0911111-1111-4111-8111-111111111111'
     and enquiry_id in (
       'e0941111-1111-4111-8111-111111111111',
       'e0961111-1111-4111-8111-111111111111'
     )),
  0,
  'matching creates no thread context, so discovery cannot bind a conversation to an enquiry'
);

select lives_ok(
  $$select public.service_disable_gmail_integration(
      'a1111111-1111-4111-8111-111111111111',
      'google_gmail_vladimir',
      'gmail_refresh_token_revoked'
    )$$,
  'backend can disable a revoked Gmail integration without deleting CRM communication state'
);

select throws_ok(
  $$select * from public.service_resolve_gmail_target(
      'a1111111-1111-4111-8111-111111111111',
      'e0921111-1111-4111-8111-111111111111',
      'e0911111-1111-4111-8111-111111111111'
    )$$,
  '22023',
  'artist Gmail integration is unavailable',
  'disabled Gmail integration fails closed'
);

select throws_ok(
  $$select * from public.service_resolve_gmail_client_target(
      'a1111111-1111-4111-8111-111111111111',
      'e0911111-1111-4111-8111-111111111111'
    )$$,
  '22023',
  'artist Gmail integration is unavailable',
  'the client-scoped read fails closed on a disabled integration too'
);

select * from finish();
rollback;