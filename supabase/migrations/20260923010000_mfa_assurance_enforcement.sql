-- 20260923010000_mfa_assurance_enforcement.sql
--
-- Audit H-3 (2026-09-22). Owner and staff accounts can now enrol a TOTP
-- second factor from the CRM Account screen. Enrolment only helps if the
-- database refuses a password-only session for an account that has a factor,
-- so every central caller-authorization helper now also requires
--   crm_private.caller_mfa_satisfied():
--     * no JWT subject (trusted backend, anonymous intake) -> not affected;
--     * aal2 session                                   -> satisfied;
--     * delegated OAuth access token (client_id claim, GPT Actions): these are
--       minted only through the CRM consent screen and are bound to a
--       registered client and profile, so they keep working;
--     * no verified factor                             -> satisfied (opt-in);
--     * verified factor with an aal1 session           -> refused.
-- Accounts without a factor see no change. Nothing is enrolled in production
-- when this ships, so it has no effect until somebody enrols.

create function crm_private.caller_mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or nullif(btrim(auth.jwt() ->> 'client_id'), '') is not null
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid()
        and f.status = 'verified'
    );
$$;

revoke all on function crm_private.caller_mfa_satisfied()
  from public, anon, authenticated, service_role;

comment on function crm_private.caller_mfa_satisfied() is
  'False only for an interactive session below aal2 whose account has a verified second factor.';

CREATE OR REPLACE FUNCTION public.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active and crm_private.caller_mfa_satisfied()
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_crm_role()
 RETURNS crm_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select a.role from crm_private.profile_access a
  where a.profile_id = auth.uid() and a.is_active
    and crm_private.caller_mfa_satisfied();
$function$;

CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active and a.role = 'owner' and crm_private.caller_mfa_satisfied()
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_manage_crm()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active and crm_private.caller_mfa_satisfied()
      and a.role in ('owner', 'booking_manager')
  );
$function$;

CREATE OR REPLACE FUNCTION crm_private.require_role(VARIADIC p_roles crm_role[])
 RETURNS crm_role
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_role public.crm_role;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not crm_private.caller_mfa_satisfied() then
    raise exception 'second factor required'
      using errcode = '42501', hint = 'MFA_REQUIRED';
  end if;

  select a.role into v_role
  from crm_private.profile_access a
  where a.profile_id = auth.uid() and a.is_active;

  if v_role is null then
    raise exception 'no active CRM profile for this account' using errcode = '42501';
  end if;

  if not (v_role = any (p_roles)) then
    raise exception 'role % is not permitted to perform this operation', v_role
      using errcode = '42501';
  end if;

  return v_role;
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.has_artist_capability(p_artist_id uuid, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select exists (
    select 1
    from crm_private.profile_access p
    join crm_private.artist_access a on a.profile_id = p.profile_id
    join crm_private.artist_state s on s.artist_id = a.artist_id
    where p.profile_id = auth.uid()
      and p.is_active
      and crm_private.caller_mfa_satisfied()
      and a.artist_id = p_artist_id
      and a.is_active
      and s.is_active
      and case
        when p_capability = 'manage_workspace' then
          crm_private.has_workspace_capability(
            (select ar.workspace_id from public.artists ar where ar.id = p_artist_id),
            'manage_workspace'
          )
        else crm_private.capability_from_grant(
          p.role, a.access_level,
          a.can_view_finance, a.can_manage_finance,
          a.can_manage_sessions, a.can_manage_integrations,
          p_capability
        )
      end
  );
$function$;

CREATE OR REPLACE FUNCTION crm_private.has_workspace_capability(p_workspace_id uuid, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select exists (
    select 1
    from crm_private.profile_access p
    join crm_private.workspace_access w on w.profile_id = p.profile_id
    join crm_private.workspace_state s on s.workspace_id = w.workspace_id
    where p.profile_id = auth.uid()
      and p.is_active
      and crm_private.caller_mfa_satisfied()
      and w.workspace_id = p_workspace_id
      and w.is_active
      and s.is_active
      and case p_capability
        when 'view' then true
        when 'manage_workspace' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_workspace
        when 'manage_team' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_team
        when 'manage_integrations' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_integrations
        else false
      end
  );
$function$;

