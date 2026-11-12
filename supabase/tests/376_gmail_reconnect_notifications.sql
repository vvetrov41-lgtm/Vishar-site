-- Personal Gmail reconnect notification regression.
-- Uses local synthetic seeded artist/integration fixtures; all writes roll back.
begin;
select no_plan();

select ok(
  not has_function_privilege('authenticated',
    'crm_private.handle_gmail_authorization_transition()', 'EXECUTE'),
  'browser sessions cannot invoke the privileged Gmail status transition'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.service_set_gmail_integration(
    'a1111111-1111-4111-8111-111111111111',
    'google_gmail_vladimir',
    'vvetrov41@gmail.com',
    array['https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send']::text[]
  )$$,
  'trusted verified Gmail binding can start enabled'
);

select lives_ok(
  $$select public.service_disable_gmail_integration(
    'a1111111-1111-4111-8111-111111111111',
    'google_gmail_vladimir',
    'gmail_refresh_token_revoked'
  )$$,
  'invalid_grant is persisted as a disconnected Gmail integration'
);

select is(
  (select last_error_category::text from public.artist_integrations
   where artist_id='a1111111-1111-4111-8111-111111111111'
     and integration_key='google_gmail_vladimir'),
  'permission_revoked',
  'revoked token is exposed as a safe status category'
);

select is(
  (select count(*)::int from public.notifications
   where artist_id='a1111111-1111-4111-8111-111111111111'
     and notification_type='system.google_reconnect_required'
     and status='delivered'),
  (select count(*)::int from crm_private.artist_notification_recipients(
    'a1111111-1111-4111-8111-111111111111')),
  'one alert is delivered to each active artist-facing recipient'
);

select ok(
  not exists(
    select 1 from public.notifications n
    where n.artist_id='a1111111-1111-4111-8111-111111111111'
      and n.notification_type='system.google_reconnect_required'
      and (n.body ilike '%refresh_token%' or n.title ilike '%access_token%')
  ),
  'notification text never leaks credential identifiers'
);

select lives_ok(
  $$select public.service_disable_gmail_integration(
    'a1111111-1111-4111-8111-111111111111',
    'google_gmail_vladimir',
    'gmail_refresh_token_revoked'
  )$$,
  'repeated disabled-state write remains valid'
);

select is(
  (select count(*)::int from public.notifications
   where artist_id='a1111111-1111-4111-8111-111111111111'
     and notification_type='system.google_reconnect_required'),
  (select count(*)::int from crm_private.artist_notification_recipients(
    'a1111111-1111-4111-8111-111111111111')),
  'repeat disable does not duplicate notifications'
);

select lives_ok(
  $$select public.service_set_gmail_integration(
    'a1111111-1111-4111-8111-111111111111',
    'google_gmail_vladimir',
    'vvetrov41@gmail.com',
    array['https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send']::text[]
  )$$,
  'successful OAuth rebind restores the connection'
);

select ok(
  not exists(
    select 1 from public.notifications
    where artist_id='a1111111-1111-4111-8111-111111111111'
      and notification_type='system.google_reconnect_required'
      and status <> 'dismissed'
  ),
  'successful rebind clears prior visible alerts without deleting their history'
);

select is(
  (select last_error_category::text from public.artist_integrations
   where artist_id='a1111111-1111-4111-8111-111111111111'
     and integration_key='google_gmail_vladimir'),
  'none',
  'reconnect clears authorization error status'
);

-- Manual disconnection must never be misclassified as Google token revocation.
update public.artist_integrations
set is_enabled=false, configuration=configuration - 'disabled_reason'
where artist_id='a1111111-1111-4111-8111-111111111111'
  and integration_key='google_gmail_vladimir';

select ok(
  not exists(
    select 1 from public.notifications
    where artist_id='a1111111-1111-4111-8111-111111111111'
      and notification_type='system.google_reconnect_required'
      and status <> 'dismissed'
  ),
  'manual Gmail disable leaves no active revoked-token warning'
);

select * from finish();
rollback;
