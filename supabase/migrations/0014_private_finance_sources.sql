-- 0014_private_finance_sources.sql
--
-- Replace migration 0013's private set-returning functions with private source
-- views. The public finance views remain SECURITY INVOKER, while the private
-- source views are outside the PostgREST-exposed schema and keep the original
-- owner-only row filter.
--
-- This preserves three properties at once:
--   * Supabase no longer reports the exposed public views as SECURITY DEFINER;
--   * authenticated keeps SELECT-only access and no direct finance-column grant;
--   * the public views remain automatically updatable in PostgreSQL, so an
--     unauthorised UPDATE is refused by ACL with SQLSTATE 42501 before any row
--     can change, matching the established security contract.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Private, owner-filtered sources
-- ---------------------------------------------------------------------------

create or replace view crm_private.projects_finance_source
with (security_barrier = true) as
  select p.id as project_id,
         p.client_id,
         p.currency,
         p.hourly_rate,
         p.estimate_total,
         p.deposit_amount,
         p.deposit_status
  from public.projects p
  where public.is_owner();

create or replace view crm_private.sessions_finance_source
with (security_barrier = true) as
  select s.id as session_id,
         s.project_id,
         s.currency,
         s.price,
         s.payment_status
  from public.sessions s
  where public.is_owner();

revoke all on crm_private.projects_finance_source
  from public, anon, authenticated, service_role;
revoke all on crm_private.sessions_finance_source
  from public, anon, authenticated, service_role;
grant select on crm_private.projects_finance_source to authenticated;
grant select on crm_private.sessions_finance_source to authenticated;

-- ---------------------------------------------------------------------------
-- Exposed SECURITY INVOKER projections
-- ---------------------------------------------------------------------------

create or replace view public.projects_finance
with (security_barrier = true, security_invoker = true) as
  select project_id,
         client_id,
         currency,
         hourly_rate,
         estimate_total,
         deposit_amount,
         deposit_status
  from crm_private.projects_finance_source;

create or replace view public.sessions_finance
with (security_barrier = true, security_invoker = true) as
  select session_id,
         project_id,
         currency,
         price,
         payment_status
  from crm_private.sessions_finance_source;

revoke all on public.projects_finance from public, anon, authenticated, service_role;
revoke all on public.sessions_finance from public, anon, authenticated, service_role;
grant select on public.projects_finance to authenticated;
grant select on public.sessions_finance to authenticated;

comment on view public.projects_finance is
  'Owner-only SECURITY INVOKER projection over a private owner-filtered source view.';
comment on view public.sessions_finance is
  'Owner-only SECURITY INVOKER projection over a private owner-filtered source view.';
comment on view crm_private.projects_finance_source is
  'Private source for the public owner-only project finance projection; not exposed by PostgREST.';
comment on view crm_private.sessions_finance_source is
  'Private source for the public owner-only session finance projection; not exposed by PostgREST.';

-- The function-backed bridge from migration 0013 is no longer needed. Remove
-- its API-role grants and objects so the explicit function ACL allow-list stays
-- closed.
revoke all on function crm_private.owner_project_finance_rows()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.owner_session_finance_rows()
  from public, anon, authenticated, service_role;
drop function crm_private.owner_project_finance_rows();
drop function crm_private.owner_session_finance_rows();
