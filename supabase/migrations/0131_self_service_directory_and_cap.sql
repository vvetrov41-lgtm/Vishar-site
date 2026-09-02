-- 0131_self_service_directory_and_cap.sql
--
-- Two things migration 0130 got wrong, both found in review and both
-- reproduced against production before this was written.
--
-- 1. The people directory
-- -----------------------
-- `crm_private.can_browse_directory()` (migration 0089) admits anybody holding
-- an active `owner` or `artist` membership on an active artist, and
-- `public.list_directory_profiles()` then returns **every** active profile in
-- the installation: id, display name, email address and role.
--
-- That was correct while it was true that everybody holding such a membership
-- had arrived by invitation. They were colleagues in one installation, and the
-- disclosure 0089 set out to prevent - *which other organizations* a person
-- belongs to - is still prevented.
--
-- Public signup broke the premise, and nothing downstream noticed. A stranger
-- who completed the bootstrap held exactly that membership shape and could read
-- the whole address book. Reproduced on production before this fix: a synthetic
-- self-service account saw three rows, Vladimir and Kristina among them, with
-- their roles.
--
-- The fix scopes the directory rather than closing it. A self-service account
-- sees the people it already shares an artist or an organization with - which,
-- for a solo tenant on its first day, is itself and nobody else. Everybody
-- else's view is untouched, because for them the original premise still holds:
-- somebody inside the installation vouched for them.
--
-- The installation owner is excluded from that shared-with test, and the reason
-- is easy to miss: 0015 gives an active owner a membership on every artist and
-- 0075 turns that into ownership of every solo workspace, so the owner shares
-- both with every tenant automatically. A first attempt at this fix that did
-- not exclude them still disclosed exactly the person it was written to
-- protect.
--
-- Bringing a *new* person into a self-service tenant is the invitation flow's
-- job. It mints an identity; the directory picks an existing one. Handing the
-- installation's address book to a stranger so they can staff their own studio
-- was never the right trade.
--
-- 2. The founder cap
-- ------------------
-- `crm_private.within_self_service_workspace_cap()` counted only organizations
-- whose `workspace_state.is_active` was true. A self-service founder can
-- deactivate their own artist and then their own organization through the
-- ordinary lifecycle RPCs - both of which they legitimately administer - and
-- the count drops back to zero. Their `workspace_memberships` owner row
-- survives, because 0089 refuses to write over an owner row under any path, so
-- they still administer the deactivated organization and can found another.
-- Repeat, and the cap bounds nothing. Reproduced on production with the cap set
-- to 1: deactivate, then found again, succeeded.
--
-- The cap is about how many organizations one account may bring into being, so
-- it now counts them whether or not they are currently switched on.
--
-- Forward-only. Both changes narrow; neither grants anything.

-- ---------------------------------------------------------------------------
-- 1. A directory that stops at the tenant boundary for self-service accounts
-- ---------------------------------------------------------------------------

create or replace function public.list_directory_profiles()
returns table (
  id                     uuid,
  display_name           text,
  email                  text,
  profile_role           public.crm_role,
  can_hold_artist_writes boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  -- Ledger membership is the whole test, and it is the honest one: it asks
  -- "did this account arrive without anybody vouching for it", which is
  -- precisely the premise 0089's directory rested on. The installation owner
  -- is never in the ledger, and neither is anybody invited.
  v_scoped boolean;
begin
  if not crm_private.can_browse_directory() then
    raise exception 'browsing the people directory is not permitted' using errcode = '42501';
  end if;

  v_scoped := exists (
    select 1 from crm_private.self_service_accounts s where s.profile_id = auth.uid()
  );

  return query
  select pr.id, pr.display_name, pr.email::text, pr.role,
         crm_private.capability_from_grant(
           pr.role, 'artist', true, true, true, true, 'manage_enquiries')
  from public.profiles pr
  where pr.is_active
    and (
      not v_scoped
      or pr.id = auth.uid()
      or (
        -- The installation owner is excluded from the scoped view, and the
        -- reason is structural rather than squeamish. Migration 0015's
        -- `ensure_owner_artist_memberships` gives an active owner an `owner`
        -- membership on *every* artist, and 0075's solo-workspace trigger then
        -- turns that into ownership of every solo workspace - including one
        -- founded thirty seconds ago by a stranger. So "we share an artist" and
        -- "we share an organization" are both automatically true of the owner
        -- for every tenant that has ever existed, and neither says anything
        -- about a working relationship. Without this the scoping leaks exactly
        -- the person it should not: verified on production, where a scoped
        -- stranger still saw Vladimir until this clause was added.
        pr.role <> 'owner'
        and (
          -- Somebody already on one of my artists.
          exists (
            select 1
            from crm_private.artist_access mine
            join crm_private.artist_access theirs on theirs.artist_id = mine.artist_id
            where mine.profile_id = auth.uid() and mine.is_active
              and theirs.profile_id = pr.id and theirs.is_active
          )
          -- Or already in one of my organizations.
          or exists (
            select 1
            from crm_private.workspace_access mine
            join crm_private.workspace_access theirs on theirs.workspace_id = mine.workspace_id
            where mine.profile_id = auth.uid() and mine.is_active
              and theirs.profile_id = pr.id and theirs.is_active
          )
        )
      )
    )
  order by pr.display_name nulls last, pr.email;
end;
$$;

comment on function public.list_directory_profiles() is
  'Active CRM people a caller may staff onto a workspace or an artist. Readable by a workspace team manager, an artist-level member, or the installation owner. Minimal fields only, and it never discloses which other organizations a person belongs to. A self-service account sees only the people it already shares an artist or an organization with: the installation address book is for people somebody inside it vouched for.';

-- The ACL is unchanged and re-stated so this file is a complete record of who
-- may call the function it re-creates.
revoke all on function public.list_directory_profiles()
  from public, anon, authenticated, service_role;
grant execute on function public.list_directory_profiles() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A founder cap that deactivation does not reset
--
-- One join removed. The count now asks how many organizations this account
-- administers, not how many of them are switched on, so switching one off
-- reclaims nothing.
-- ---------------------------------------------------------------------------

create or replace function crm_private.within_self_service_workspace_cap()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select not exists (
    select 1
    from crm_private.self_service_accounts s
    cross join crm_private.self_service_settings c
    where s.profile_id = auth.uid()
      and (
        select count(*)
        from crm_private.workspace_access wa
        where wa.profile_id = auth.uid()
          and wa.is_active
          and wa.can_manage_workspace
      ) >= c.max_workspaces_per_founder
  );
$$;

comment on function crm_private.within_self_service_workspace_cap() is
  'True unless the caller is a self-service account that already administers its allowance of organizations. Counts them whether or not they are currently active: an account cannot deactivate its own organization to reclaim the allowance, because 0089 keeps its owner membership row alive either way. Invited accounts and the installation owner are never in the ledger, so this is true for them by construction.';

revoke all on function crm_private.within_self_service_workspace_cap()
  from public, anon, authenticated, service_role;
