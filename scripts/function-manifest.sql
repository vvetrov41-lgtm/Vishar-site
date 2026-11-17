-- One line per CRM database function: "<schema>.<name>(<identity args>)<TAB><sha256>".
--
-- The hash covers the full definition (pg_get_functiondef: language, return
-- type, volatility, SECURITY DEFINER, search_path and the body) plus the owner
-- and the ACL, so a body, a setting or a grant that changes outside the
-- migrations shows up as a different hash.
--
-- Read-only. Used by scripts/check-function-manifest.mjs against a database
-- built from the migrations (CI) and against production after a release.
select signature || E'\t' || definition_sha256
from (
select
  n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
  encode(sha256(convert_to(
       pg_get_functiondef(p.oid)
       || E'\n-- owner: ' || pg_get_userbyid(p.proowner)
       || E'\n-- acl: ' || coalesce(p.proacl::text, ''),
       'UTF8')), 'hex') as definition_sha256
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'crm_private')
  and p.prokind in ('f', 'p')
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  )
) f
order by signature collate "C";
