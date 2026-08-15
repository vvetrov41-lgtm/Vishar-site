-- 203_whatsapp_integration_key_ownership.sql
-- Migration 0052: one artist can never select another artist's encrypted
-- WhatsApp binding namespace.

begin;
select no_plan();

select throws_ok(
  $$insert into public.artist_integrations
      (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values
      ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
       'kristina-production', '{}'::jsonb, false)$$,
  '23514', null,
  'Vladimir cannot select a Kristina-prefixed WhatsApp binding'
);

select throws_ok(
  $$insert into public.artist_integrations
      (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values
      ('a2222222-2222-4222-8222-222222222222', 'whatsapp', 'meta_cloud_api',
       'vladimir-production', '{}'::jsonb, false)$$,
  '23514', null,
  'Kristina cannot select a Vladimir-prefixed WhatsApp binding'
);

select throws_ok(
  $$insert into public.artist_integrations
      (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values
      ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
       'production', '{}'::jsonb, false)$$,
  '23514', null,
  'a WhatsApp key without the owning artist namespace fails closed'
);

select lives_ok(
  $$insert into public.artist_integrations
      (id, artist_id, integration_type, provider, integration_key,
       external_account_label, configuration, is_enabled)
    values
      ('dc111111-1111-4111-8111-111111111111',
       'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
       'vladimir-production', 'Synthetic production selector', '{}'::jsonb, false)$$,
  'Vladimir production key is valid in Vladimir namespace'
);

select lives_ok(
  $$insert into public.artist_integrations
      (id, artist_id, integration_type, provider, integration_key,
       external_account_label, configuration, is_enabled)
    values
      ('dc222222-2222-4222-8222-222222222222',
       'a2222222-2222-4222-8222-222222222222', 'whatsapp', 'meta_cloud_api',
       'kristina-staging', 'Synthetic staging selector', '{}'::jsonb, false)$$,
  'Kristina staging key is valid in Kristina namespace'
);

select throws_ok(
  $$update public.artist_integrations
      set integration_key = 'kristina-production'
    where id = 'dc111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'existing integration identity remains immutable'
);

-- The generic audited RPC cannot bypass the table-level owner guard.
insert into auth.users (id, email) values
  ('6c111111-1111-4111-8111-111111111111', 'wa.key.owner@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('6c111111-1111-4111-8111-111111111111', 'wa.key.owner@example.test', 'owner', true);

create function pg_temp.wa_key_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.wa_key_claims(text) to authenticated;

set local role authenticated;
select pg_temp.wa_key_claims(
  '{"sub":"6c111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select public.configure_artist_integration(
      'a1111111-1111-4111-8111-111111111111',
      'whatsapp'::public.artist_integration_type,
      'meta_cloud_api',
      'kristina-production',
      'Cross artist attempt',
      '{}'::jsonb,
      false
    )$$,
  '23514', null,
  'even the owner RPC cannot bind Vladimir metadata to Kristina namespace'
);
reset role;

select * from finish();
rollback;
