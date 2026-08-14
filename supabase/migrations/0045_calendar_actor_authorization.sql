-- 0045_calendar_actor_authorization.sql
--
-- Keep Calendar OAuth self-service subordinate to the CRM access graph. A
-- signed Cloudflare Access identity is necessary but not sufficient: the
-- Calendar Worker asks this backend-only RPC whether that active CRM profile
-- currently has manage-integrations capability for the exact artist.

create or replace function public.authorize_calendar_actor(
  p_actor_email text,
  p_artist_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.profiles p
    join crm_private.profile_access pa
      on pa.profile_id = p.id
    join crm_private.artist_access aa
      on aa.profile_id = p.id
     and aa.artist_id = p_artist_id
    join crm_private.artist_state ast
      on ast.artist_id = aa.artist_id
    where p_actor_email is not null
      and btrim(p_actor_email) <> ''
      and lower(btrim(p.email)) = lower(btrim(p_actor_email))
      and pa.is_active
      and aa.is_active
      and ast.is_active
      and (
        pa.role = 'owner'
        or (
          pa.role = 'booking_manager'
          and aa.can_manage_integrations
        )
      )
  );
$$;

revoke all on function public.authorize_calendar_actor(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_calendar_actor(text,uuid)
  to service_role;

comment on function public.authorize_calendar_actor(text,uuid) is
  'Backend-only boolean guard for Calendar OAuth/disconnect. Requires an active CRM profile, active artist membership and current manage-integrations capability for the exact artist; returns no profile or membership data.';
