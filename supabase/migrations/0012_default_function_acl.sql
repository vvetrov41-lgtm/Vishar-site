-- 0012_default_function_acl.sql
--
-- Supabase migrations are created by the `postgres` role. PostgreSQL grants
-- EXECUTE on every new function to PUBLIC unless that owner's default ACL says
-- otherwise. Direct grants to `anon`, `authenticated` and `service_role` are
-- separate ACL entries, so both layers are closed explicitly.
--
-- Existing direct grants made deliberately by migrations 0006-0010 survive
-- the schema-wide PUBLIC revokes below. No function is granted back here.
--
-- Forward-only.

-- Close the implicit EXECUTE inherited by every role on functions that already
-- exist. This does not remove an explicit role-specific grant.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema crm_private from public;

-- Pin the owner context explicitly. The Supabase CLI and hosted migration
-- runner apply project migrations as `postgres`; session-relative default ACLs
-- can target the wrong owner in other execution contexts.
--
-- PostgreSQL's built-in function EXECUTE for PUBLIC is a GLOBAL default.
-- A schema-specific REVOKE cannot subtract a global default privilege, so the
-- PUBLIC revoke deliberately has no IN SCHEMA clause. It closes every future
-- postgres-owned function unless a later migration grants it deliberately.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;

-- Schema-specific defaults can contain additional direct API-role grants.
-- Remove those independently; they would otherwise be added to the closed
-- global default.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema crm_private
  revoke execute on functions from anon, authenticated, service_role;
