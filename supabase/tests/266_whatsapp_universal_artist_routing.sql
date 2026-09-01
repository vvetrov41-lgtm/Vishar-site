-- 266_whatsapp_universal_artist_routing.sql
-- Migration 0129: exact artist route keys and bounded connection completion.

begin;
select no_plan();

select ok(
  not has_function_privilege(
    'anon',
    'public.complete_artist_whatsapp_connection(uuid,text)',
    'EXECUTE'
  ),
  'anon cannot complete artist WhatsApp provisioning'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.complete_artist_whatsapp_connection(uuid,text)',
    'EXECUTE'
  ),
  'authenticated CRM operators may reach the bounded completion RPC'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.complete_artist_whatsapp_connection(uuid,text)',
    'EXECUTE'
  ),
  'service_role is not an alternate caller for the operator completion RPC'
);
select has_index(
  'public',
  'artist_integrations',
  'artist_integrations_whatsapp_route_key_unique',
  'WhatsApp route selectors have a dedicated uniqueness boundary'
);
select ok(
  (select idx.indisunique
   from pg_catalog.pg_index idx
   join pg_catalog.pg_class relation on relation.oid = idx.indexrelid
   join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname = 'public'
     and relation.relname = 'artist_integrations_whatsapp_route_key_unique'),
  'the WhatsApp route-key index is unique'
);

insert into public.artists (id, slug, display_name, is_active) values
  ('a3333333-3333-4333-8333-333333333333', 'future-artist', 'Future Artist', true),
  ('a4444444-4444-4444-8444-444444444444', 'other-artist', 'Other Artist', true);

select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key,
      external_account_label, configuration, is_enabled
    ) values (
      'a3333333-3333-4333-8333-333333333333',
      'whatsapp', 'meta_cloud_api', 'future-artist-secondary-production',
      'Invalid WhatsApp', '{}'::jsonb, true
    )$$,
  '23514', null,
  'a namespaced but non-exact WhatsApp selector is rejected'
);

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled, connected_at
) values (
  'a3333333-3333-4333-8333-333333333333',
  'whatsapp', 'meta_cloud_api', 'future-artist-production',
  'Future Artist WhatsApp', '{}'::jsonb, true, null
);

insert into auth.users (id, email) values
  ('6d333333-3333-4333-8333-333333333333', 'future.artist.manager@example.test'),
  ('6d444444-4444-4444-8444-444444444444', 'other.artist.manager@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('6d333333-3333-4333-8333-333333333333', 'future.artist.manager@example.test', 'booking_manager', true),
  ('6d444444-4444-4444-8444-444444444444', 'other.artist.manager@example.test', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '6d333333-3333-4333-8333-333333333333',
    'a3333333-3333-4333-8333-333333333333',
    'manager', false, false, true, true, true
  ),
  (
    '6d444444-4444-4444-8444-444444444444',
    'a4444444-4444-4444-8444-444444444444',
    'manager', false, false, true, true, true
  );

create function pg_temp.wa_universal_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.wa_universal_claims(text) to authenticated;

set local role authenticated;
select pg_temp.wa_universal_claims(
  '{"sub":"6d444444-4444-4444-8444-444444444444","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_artist_whatsapp_connection(
      'a3333333-3333-4333-8333-333333333333',
      'future-artist-production'
    )$$,
  '42501', null,
  'an operator for another artist cannot complete the route'
);
reset role;

update public.artist_integrations
set configuration = '{"safe_metadata":"still_not_credentials"}'::jsonb
where artist_id = 'a3333333-3333-4333-8333-333333333333'
  and integration_key = 'future-artist-production';

set local role authenticated;
select pg_temp.wa_universal_claims(
  '{"sub":"6d333333-3333-4333-8333-333333333333","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_artist_whatsapp_connection(
      'a3333333-3333-4333-8333-333333333333',
      'future-artist-production'
    )$$,
  '55000', null,
  'a non-empty route cannot be marked connected'
);
reset role;

update public.artist_integrations
set configuration = '{}'::jsonb,
    is_enabled = false
where artist_id = 'a3333333-3333-4333-8333-333333333333'
  and integration_key = 'future-artist-production';

set local role authenticated;
select pg_temp.wa_universal_claims(
  '{"sub":"6d333333-3333-4333-8333-333333333333","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_artist_whatsapp_connection(
      'a3333333-3333-4333-8333-333333333333',
      'future-artist-production'
    )$$,
  '55000', null,
  'a disabled route cannot be marked connected'
);
reset role;

update public.artist_integrations
set is_enabled = true
where artist_id = 'a3333333-3333-4333-8333-333333333333'
  and integration_key = 'future-artist-production';

set local role authenticated;
select pg_temp.wa_universal_claims(
  '{"sub":"6d333333-3333-4333-8333-333333333333","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_artist_whatsapp_connection(
      'a3333333-3333-4333-8333-333333333333',
      'other-artist-production'
    )$$,
  '22023', null,
  'the caller cannot substitute another route key'
);

create temporary table wa_universal_result as
select public.complete_artist_whatsapp_connection(
  'a3333333-3333-4333-8333-333333333333',
  'future-artist-production'
) as value;
grant select on wa_universal_result to authenticated;

select is(
  (select value ->> 'artist_id' from wa_universal_result),
  'a3333333-3333-4333-8333-333333333333',
  'the completion result carries the authoritative artist identity'
);
select is(
  (select value ->> 'integration_key' from wa_universal_result),
  'future-artist-production',
  'the completion result carries the authoritative route key'
);
select ok(
  (select nullif(value ->> 'connected_at', '') is not null from wa_universal_result),
  'the completion RPC returns its server-generated connection timestamp'
);
select throws_ok(
  $$update public.artist_integrations
      set connected_at = clock_timestamp()
    where artist_id = 'a3333333-3333-4333-8333-333333333333'$$,
  '42501', null,
  'authenticated operators retain no direct artist_integrations UPDATE privilege'
);
reset role;

select ok(
  (select connected_at is not null
   from public.artist_integrations
   where artist_id = 'a3333333-3333-4333-8333-333333333333'
     and integration_key = 'future-artist-production'),
  'the future artist route is marked connected'
);
select is(
  (select configuration
   from public.artist_integrations
   where artist_id = 'a3333333-3333-4333-8333-333333333333'
     and integration_key = 'future-artist-production'),
  '{}'::jsonb,
  'connection completion persists no provider credentials'
);

select * from finish();
rollback;
