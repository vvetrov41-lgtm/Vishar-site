-- 0136_enquiry_assignee_tenant_scope.sql
--
-- Public self-service made the old enquiry assignee directory unsafe. The
-- picker was installation-wide, so a newly bootstrapped solo artist could see
-- unrelated operators simply because they were active owners/managers.
--
-- Assignment itself was closer to the intended boundary, but the installation
-- owner receives a structural membership on every artist (0015). For a public
-- self-service artist that made the owner technically assignable even though
-- no working relationship exists.
--
-- Keep the existing zero-argument API so no browser rollout is needed. Internal
-- owner/invite-only behaviour stays compatible. A non-owner who participates in
-- a self-service artist sees only active non-read-only managers who genuinely
-- share one of those self-service artist scopes. The installation owner is
-- explicitly excluded from that tenant view.
--
-- Forward-only. This migration only narrows reads and assignment authority.

-- ---------------------------------------------------------------------------
-- Tenant-scoped assignee picker
-- ---------------------------------------------------------------------------

create or replace function public.list_assignable_profiles()
returns table (
  id uuid,
  display_name text,
  role public.crm_role
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_self_service_scoped boolean;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  -- The installation owner is deliberately not treated as self-service scoped.
  -- 0015 gives that account a structural membership on every artist, including
  -- every public tenant. Without this exclusion merely creating a tenant would
  -- change the owner's legacy operator picker.
  v_self_service_scoped := not public.is_owner() and exists (
    select 1
    from crm_private.artist_access mine
    join crm_private.self_service_accounts s
      on s.artist_id = mine.artist_id
    where mine.profile_id = auth.uid()
      and mine.is_active
      and mine.access_level <> 'read_only'
  );

  return query
  select pr.id, pr.display_name, pa.role
  from crm_private.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
  where pa.is_active
    and pr.is_active
    and pa.role in ('owner', 'booking_manager')
    and (
      not v_self_service_scoped
      or (
        -- An installation owner is a platform relationship, not a tenant team
        -- relationship. Public tenants must not see or assign that account.
        pa.role <> 'owner'
        and exists (
          select 1
          from crm_private.artist_access mine
          join crm_private.artist_access theirs
            on theirs.artist_id = mine.artist_id
          join crm_private.self_service_accounts s
            on s.artist_id = mine.artist_id
          where mine.profile_id = auth.uid()
            and mine.is_active
            and mine.access_level <> 'read_only'
            and theirs.profile_id = pa.profile_id
            and theirs.is_active
            and theirs.access_level <> 'read_only'
        )
      )
    )
  order by pr.display_name nulls last, pr.email;
end;
$$;

comment on function public.list_assignable_profiles() is
  'Active enquiry assignees. Public self-service tenants see only non-owner managers who genuinely share their self-service artist scope; installation owner/invite-only behaviour remains compatible.';

revoke all on function public.list_assignable_profiles()
  from public, anon, authenticated, service_role;
grant execute on function public.list_assignable_profiles()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Match the write boundary to the picker
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_assignee_for_artist(
  p_profile_id uuid,
  p_artist_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_profile_id is null then
    return;
  end if;

  if not exists (
    select 1
    from crm_private.profile_access p
    join crm_private.artist_access a on a.profile_id = p.profile_id
    where p.profile_id = p_profile_id
      and p.is_active
      and p.role in ('owner', 'booking_manager')
      and a.artist_id = p_artist_id
      and a.is_active
      and a.access_level <> 'read_only'
      and (
        -- The installation owner has a structural membership on every artist.
        -- That must not turn into an operational assignment relationship for a
        -- stranger's self-service tenant.
        p.role <> 'owner'
        or not exists (
          select 1
          from crm_private.self_service_accounts s
          where s.artist_id = p_artist_id
        )
      )
  ) then
    raise exception 'assignee must be an active owner/manager for the same artist'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function crm_private.require_assignee_for_artist(uuid,uuid)
  from public, anon, authenticated, service_role;
