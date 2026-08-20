-- 0073_instagram_operator_authorization.sql
--
-- Verify an already-authenticated CRM profile for Instagram onboarding from a
-- trusted backend Worker. The browser never supplies p_profile_id; the Worker
-- obtains it from Supabase Auth /auth/v1/user after validating the bearer.

create or replace function public.service_authorize_instagram_connection(
  p_profile_id uuid,
  p_artist_id uuid
)
returns table (
  artist_id uuid,
  artist_slug text,
  integration_key text,
  instagram_user_id text,
  is_enabled boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
  v_slug text;
  v_integration_key text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'service backend role required' using errcode = '42501';
  end if;

  if p_profile_id is null then
    raise exception 'profile scope is required' using errcode = '22023';
  end if;
  perform crm_private.require_active_artist(p_artist_id);

  select p.role
    into v_role
  from crm_private.profile_access p
  where p.profile_id = p_profile_id
    and p.is_active;

  if v_role is null or v_role not in ('owner', 'booking_manager') then
    raise exception 'profile is not permitted to manage integrations' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from crm_private.artist_access a
    where a.profile_id = p_profile_id
      and a.artist_id = p_artist_id
      and a.is_active
      and (
        v_role = 'owner'
        or (v_role = 'booking_manager' and a.can_manage_integrations)
      )
  ) then
    raise exception 'profile cannot manage integrations for this artist' using errcode = '42501';
  end if;

  select a.slug
    into v_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_slug is null then
    raise exception 'artist does not exist or is inactive' using errcode = '23503';
  end if;

  v_integration_key := v_slug || '-instagram';

  return query
  select
    p_artist_id,
    v_slug,
    v_integration_key,
    i.configuration ->> 'instagram_user_id',
    coalesce(i.is_enabled, false)
  from (values (1)) as seed(n)
  left join public.artist_integrations i
    on i.artist_id = p_artist_id
   and i.integration_type = 'instagram'
   and i.integration_key = v_integration_key;
end;
$$;

revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from public;
revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from anon;
revoke all on function public.service_authorize_instagram_connection(uuid, uuid) from authenticated;
grant execute on function public.service_authorize_instagram_connection(uuid, uuid) to service_role;
