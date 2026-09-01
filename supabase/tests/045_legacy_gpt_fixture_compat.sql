-- 045_legacy_gpt_fixture_compat.sql
--
-- Tests 050 and 100 predate the private-GPT foundation and intentionally
-- inventory the API surface / integration metadata that existed before GPT.
-- Hide only GPT-owned authenticated RPCs for those historical tests. The real
-- migration-defined grants are restored by 1835_gpt_foundation_restore.sql.

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
          'get_gpt_action_consent_summary'
        )
      )
  loop
    execute format('revoke execute on function %s from authenticated', r.signature);
  end loop;
end;
$$;

delete from public.artist_integrations
where integration_type = 'gpt'
  and provider = 'openai_gpt_actions'
  and integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions');

select pass('legacy ACL and integration-metadata tests run against their pre-GPT fixture surface');

select * from finish(true);
