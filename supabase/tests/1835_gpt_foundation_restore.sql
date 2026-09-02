-- 1835_gpt_foundation_restore.sql
--
-- Restore the migration-defined GPT surface after the legacy pre-GPT
-- compatibility tests. Dedicated GPT tests below this point must exercise the
-- actual authenticated grants rather than the temporary legacy fixture.

select no_plan();

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like 'gpt\_%' escape '\'
        or p.proname in (
          'configure_gpt_action_client',
          'configure_gpt_enquiry_read_access',
          'configure_gpt_full_management',
          'configure_gpt_web_research_access',
          'configure_gpt_cloudflare_control_access',
          'get_gpt_action_consent_summary'
        )
      )
  loop
    execute format('grant execute on function %s to authenticated', r.signature);
  end loop;
end;
$$;

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
  (
    'a1111111-1111-4111-8111-111111111111',
    'gpt', 'openai_gpt_actions', 'vladimir-gpt-actions',
    'Vladimir private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'gpt', 'openai_gpt_actions', 'kristina-gpt-actions',
    'Kristina private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  )
on conflict (artist_id, integration_type, integration_key) do update
set provider = excluded.provider,
    external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled;

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like 'gpt\_%' escape '\'
        or p.proname in (
          'configure_gpt_action_client',
          'configure_gpt_enquiry_read_access',
          'configure_gpt_full_management',
          'configure_gpt_web_research_access',
          'configure_gpt_cloudflare_control_access',
          'get_gpt_action_consent_summary'
        )
      )
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ),
  'all migration-defined authenticated GPT/consent/configuration grants are restored'
);

select is(
  (select count(*)::int
   from public.artist_integrations
   where integration_type = 'gpt'
     and provider = 'openai_gpt_actions'
     and integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions')
     and is_enabled = false),
  2,
  'both disabled private-GPT integration metadata rows are restored'
);

select * from finish(true);
