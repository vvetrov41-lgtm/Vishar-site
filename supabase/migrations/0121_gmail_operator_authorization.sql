-- 0121_gmail_operator_authorization.sql
--
-- Allow the trusted Gmail Worker to verify that a currently authenticated CRM
-- profile may read Gmail history for one exact enquiry. The browser supplies a
-- Supabase access token to the Worker; the Worker resolves that token to a
-- profile id via Supabase Auth and only then calls this backend-only RPC.
--
-- This RPC returns CRM scope identifiers only. Provider thread ids, OAuth
-- credentials, mailbox tokens and message contents remain Worker/private-schema
-- data and are never exposed by this function.

create or replace function public.service_authorize_gmail_operator(
  p_profile_id uuid,
  p_enquiry_id uuid
)
returns table (
  artist_id uuid,
  enquiry_id uuid,
  client_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_role public.crm_role;
  v_access_level public.artist_access_level;
  v_can_view_finance boolean;
  v_can_manage_finance boolean;
  v_can_manage_sessions boolean;
  v_can_manage_integrations boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'service backend role required' using errcode = '42501';
  end if;

  if p_profile_id is null or p_enquiry_id is null then
    raise exception 'profile and enquiry scope are required' using errcode = '22023';
  end if;

  select e.artist_id, e.client_id
    into v_artist_id, v_client_id
  from public.enquiries e
  where e.id = p_enquiry_id;

  if v_artist_id is null or v_client_id is null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(v_artist_id);

  select
    p.role,
    a.access_level,
    a.can_view_finance,
    a.can_manage_finance,
    a.can_manage_sessions,
    a.can_manage_integrations
  into
    v_role,
    v_access_level,
    v_can_view_finance,
    v_can_manage_finance,
    v_can_manage_sessions,
    v_can_manage_integrations
  from crm_private.profile_access p
  join crm_private.artist_access a
    on a.profile_id = p.profile_id
   and a.artist_id = v_artist_id
  where p.profile_id = p_profile_id
    and p.is_active
    and a.is_active;

  -- Match the existing email_messages browser boundary: live Gmail history is
  -- available only to a profile that can manage the enquiry's artist. This
  -- deliberately does not widen email visibility to read-only memberships.
  if v_role is null
     or not crm_private.capability_from_grant(
       v_role,
       v_access_level,
       v_can_view_finance,
       v_can_manage_finance,
       v_can_manage_sessions,
       v_can_manage_integrations,
       'manage'
     ) then
    raise exception 'profile cannot read Gmail for this artist' using errcode = '42501';
  end if;

  return query
  select v_artist_id, p_enquiry_id, v_client_id;
end;
$$;

revoke all on function public.service_authorize_gmail_operator(uuid, uuid) from public;
revoke all on function public.service_authorize_gmail_operator(uuid, uuid) from anon;
revoke all on function public.service_authorize_gmail_operator(uuid, uuid) from authenticated;
grant execute on function public.service_authorize_gmail_operator(uuid, uuid) to service_role;
