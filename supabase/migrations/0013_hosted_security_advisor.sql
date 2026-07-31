-- 0013_hosted_security_advisor.sql
--
-- Resolve hosted Supabase Security Advisor findings without widening finance
-- access or changing the CRM's existing query contract.
--
-- The original finance views were intentionally owner-filtered, but ordinary
-- PostgreSQL views run with the view owner's privileges. Supabase therefore
-- reports them as SECURITY DEFINER views. Rebuild them as SECURITY INVOKER
-- views over private, role-checking functions. The public view names and column
-- shapes stay unchanged, so the CRM and existing pgTAP coverage keep the same
-- interface.
--
-- Also pin the search_path on the two JWT helpers flagged by the hosted linter.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Fixed search paths for private JWT helpers
-- ---------------------------------------------------------------------------

alter function crm_private.jwt_role()
  set search_path = pg_catalog, crm_private;

alter function crm_private.is_service_backend()
  set search_path = pg_catalog, crm_private;

-- ---------------------------------------------------------------------------
-- Owner-only finance readers behind SECURITY INVOKER views
-- ---------------------------------------------------------------------------

create or replace function crm_private.owner_project_finance_rows()
returns table (
  project_id     uuid,
  client_id      uuid,
  currency       text,
  hourly_rate    numeric,
  estimate_total numeric,
  deposit_amount numeric,
  deposit_status public.deposit_status
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select p.id,
         p.client_id,
         p.currency,
         p.hourly_rate,
         p.estimate_total,
         p.deposit_amount,
         p.deposit_status
  from public.projects p
  where public.is_owner();
$$;

create or replace function crm_private.owner_session_finance_rows()
returns table (
  session_id     uuid,
  project_id     uuid,
  currency       text,
  price          numeric,
  payment_status public.payment_status
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select s.id,
         s.project_id,
         s.currency,
         s.price,
         s.payment_status
  from public.sessions s
  where public.is_owner();
$$;

-- Migration 0012 closes the default function ACL, but keep the intended access
-- explicit here as defence in depth. The private schema is not exposed through
-- PostgREST; authenticated users reach these readers only through the views.
revoke all on function crm_private.owner_project_finance_rows()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.owner_session_finance_rows()
  from public, anon, authenticated, service_role;
grant execute on function crm_private.owner_project_finance_rows() to authenticated;
grant execute on function crm_private.owner_session_finance_rows() to authenticated;

create or replace view public.projects_finance
with (security_barrier = true, security_invoker = true) as
  select * from crm_private.owner_project_finance_rows();

create or replace view public.sessions_finance
with (security_barrier = true, security_invoker = true) as
  select * from crm_private.owner_session_finance_rows();

revoke all on public.projects_finance from public, anon, authenticated, service_role;
revoke all on public.sessions_finance from public, anon, authenticated, service_role;
grant select on public.projects_finance to authenticated;
grant select on public.sessions_finance to authenticated;

comment on view public.projects_finance is
  'Owner-only finance projection implemented as a SECURITY INVOKER view over a private role-checking function.';
comment on view public.sessions_finance is
  'Owner-only session-finance projection implemented as a SECURITY INVOKER view over a private role-checking function.';
