-- 0089_control_plane_governance.sql
--
-- Six corrections to the control plane shipped in 0087/0088, each closing a gap
-- an independent review found. They are one migration because they are one
-- argument: the control plane has to be usable by somebody who is not the
-- legacy installation owner, and it has to be impossible to drive into a
-- broken state.
--
--   1. A scoped people directory, so a workspace administrator can actually
--      find somebody to add. public.list_profiles() requires the legacy global
--      owner role, so the new screens rendered an empty dropdown for exactly
--      the person the design was written for.
--   2. Workspace owner invariants. The generic membership upsert would happily
--      demote or deactivate a sitting owner, including the last one.
--   3. A deliberate, audited ownership transfer, so "owners are immutable here"
--      does not mean "ownership can never move".
--   4. Eligibility for the one-shot artist seat, so the bootstrap cannot be
--      consumed on a profile that the capability derivation will then refuse
--      every write to.
--   5. One read that resolves an artist's control-plane context, so the artist
--      themselves can open their own onboarding page.
--   6. A server-authoritative answer to "may this person see the control
--      plane at all", so the browser stops deriving it from the legacy role.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. Who may browse the people directory
--
-- The question this answers is narrower than it looks. `public.profiles` has
-- no workspace column and never will: a CRM user is an installation-level
-- identity who may work across several organizations. So there is no such
-- thing as "the profiles belonging to this workspace", and a directory read
-- cannot be partitioned by workspace.
--
-- What can be scoped is *who may read it*. The rule below is: you may browse
-- the directory if you are trusted to staff something - a workspace team, or
-- an artist's team. That is strictly tighter than the surface that already
-- ships: public.list_assignable_profiles() exposes id, display_name and role
-- of every active owner and booking_manager to *any* booking_manager, with no
-- team-management requirement at all.
-- ---------------------------------------------------------------------------

create or replace function crm_private.can_browse_directory()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.is_active_user()
     and (
       public.is_owner()
       or exists (
         select 1 from crm_private.workspace_access wa
         join crm_private.workspace_state ws on ws.workspace_id = wa.workspace_id
         where wa.profile_id = auth.uid()
           and wa.is_active
           and ws.is_active
           and wa.can_manage_team
           and wa.workspace_role in ('owner', 'admin')
       )
       or exists (
         select 1 from crm_private.artist_access aa
         join crm_private.artist_state ast on ast.artist_id = aa.artist_id
         where aa.profile_id = auth.uid()
           and aa.is_active
           and ast.is_active
           and aa.access_level in ('owner', 'artist')
       )
     );
$$;

revoke all on function crm_private.can_browse_directory()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The directory itself
--
-- Deliberately minimal. Enough to recognise a colleague and pick them out of a
-- list, and nothing else: no created_at, no activity, no membership map of
-- other organizations, and only active profiles. A caller learns that a person
-- exists and can be staffed. They learn nothing about where else that person
-- works, which is the cross-organization disclosure worth actually preventing.
--
-- `can_hold_artist_writes` is here so the interface can warn before it burns
-- the one-shot artist seat on somebody the capability derivation will refuse
-- every write to. It is computed from the same authoritative derivation the
-- real check uses, not from a copy of the rule.
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
begin
  if not crm_private.can_browse_directory() then
    raise exception 'browsing the people directory is not permitted' using errcode = '42501';
  end if;

  return query
  select pr.id, pr.display_name, pr.email::text, pr.role,
         crm_private.capability_from_grant(
           pr.role, 'artist', true, true, true, true, 'manage_enquiries')
  from public.profiles pr
  where pr.is_active
  order by pr.display_name nulls last, pr.email;
end;
$$;

comment on function public.list_directory_profiles() is
  'Active CRM people a caller may staff onto a workspace or an artist. Readable by a workspace team manager, an artist-level member, or the installation owner - deliberately not by the legacy global owner alone, which is what made the control plane unusable for a studio admin. Minimal fields only: it never discloses which other organizations a person belongs to.';

revoke all on function public.list_directory_profiles()
  from public, anon, authenticated, service_role;
grant execute on function public.list_directory_profiles() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Workspace owner invariants
--
-- The hole: public.upsert_workspace_membership guards *granting* the owner
-- role, so a non-owner cannot mint one. It does not guard the row it is
-- writing over. Its ON CONFLICT DO UPDATE rewrites workspace_role and
-- is_active for whatever row already exists, so anybody holding manage_team
-- could demote the sitting owner to read_only, or set them inactive, and the
-- workspace would be left with nobody able to administer it.
--
-- The rule is now blunt on purpose: **the ordinary membership upsert never
-- writes over an owner row.** Not to demote, not to deactivate, not to adjust
-- their flags, and not even for the installation owner. A rule with an
-- exception is a rule somebody has to reason about at 2am; this one has none.
-- Ownership moves through public.transfer_workspace_ownership below, which is
-- a separate, deliberate, audited act.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_workspace_membership(
  p_profile_id uuid,
  p_workspace_id uuid,
  p_workspace_role public.workspace_role,
  p_can_manage_workspace boolean default false,
  p_can_manage_team boolean default false,
  p_can_manage_integrations boolean default false,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_existing_role public.workspace_role;
begin
  if p_profile_id is null or p_workspace_id is null then
    raise exception 'a profile and a workspace are required' using errcode = '22023';
  end if;

  -- A global owner keeps administering the installation. Otherwise the caller
  -- must administer this exact workspace.
  if not public.is_owner() then
    perform crm_private.require_workspace_access(p_workspace_id, 'manage_team');
  end if;

  if not exists (
    select 1 from public.profiles pr where pr.id = p_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- The owner row is off limits to this function, whoever is calling.
  select wm.workspace_role into v_existing_role
  from public.workspace_memberships wm
  where wm.profile_id = p_profile_id and wm.workspace_id = p_workspace_id;

  if v_existing_role = 'owner' then
    raise exception 'a workspace owner is changed through ownership transfer, not through team management'
      using errcode = '42501';
  end if;

  -- No self-elevation: a non-owner cannot mint a right it lacks.
  if not public.is_owner() then
    if p_can_manage_workspace
       and not crm_private.has_workspace_capability(p_workspace_id, 'manage_workspace') then
      raise exception 'cannot grant workspace administration you do not hold'
        using errcode = '42501';
    end if;
    if p_can_manage_integrations
       and not crm_private.has_workspace_capability(p_workspace_id, 'manage_integrations') then
      raise exception 'cannot grant workspace integration management you do not hold'
        using errcode = '42501';
    end if;
  end if;

  -- Promotion to owner never happens here, for anybody. Previously this was
  -- refused only for non-global-owners; making it absolute keeps "who owns
  -- this workspace" answerable by reading one function.
  if p_workspace_role = 'owner' then
    raise exception 'workspace ownership is granted through ownership transfer, not here'
      using errcode = '42501';
  end if;

  insert into public.workspace_memberships (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  ) values (
    p_profile_id, p_workspace_id, p_workspace_role,
    coalesce(p_can_manage_workspace, false),
    coalesce(p_can_manage_team, false),
    coalesce(p_can_manage_integrations, false),
    coalesce(p_is_active, true)
  )
  on conflict (profile_id, workspace_id) do update
    set workspace_role = excluded.workspace_role,
        can_manage_workspace = excluded.can_manage_workspace,
        can_manage_team = excluded.can_manage_team,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active
  returning id into v_id;

  perform crm_private.log_lifecycle_event(
    'workspace.membership_changed', null,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'subject_profile_id', p_profile_id,
      'workspace_role', p_workspace_role::text,
      'is_active', coalesce(p_is_active, true)
    )
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Last-owner protection, enforced under every path
--
-- The check above lives in one RPC. This trigger is the invariant itself, and
-- it holds for any writer that reaches the table - a future RPC, a repair
-- script, a definer function nobody has written yet. A workspace that has ever
-- had an active owner keeps one.
--
-- It fires on UPDATE and DELETE only. An INSERT can never remove an owner, and
-- guarding it would make founding a workspace impossible: create_workspace
-- writes the founder's owner row into an organization that has none yet.
--
-- public.transfer_workspace_ownership below is careful to promote before it
-- demotes, so it never passes through a zero-owner state even for an instant.
-- ---------------------------------------------------------------------------

create or replace function crm_private.protect_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid := coalesce(new.workspace_id, old.workspace_id);
  v_was_active_owner boolean := old.workspace_role = 'owner' and old.is_active;
  v_still_active_owner boolean := tg_op = 'UPDATE'
    and new.workspace_role = 'owner' and new.is_active;
begin
  if not v_was_active_owner or v_still_active_owner then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = v_workspace_id
      and wm.workspace_role = 'owner'
      and wm.is_active
  ) then
    raise exception 'a workspace must keep an active owner'
      using errcode = '23514',
            detail = 'Transfer ownership to somebody else before removing the last owner.';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function crm_private.protect_last_workspace_owner()
  from public, anon, authenticated, service_role;

drop trigger if exists workspace_memberships_protect_last_owner on public.workspace_memberships;
create trigger workspace_memberships_protect_last_owner
  after update or delete on public.workspace_memberships
  for each row execute function crm_private.protect_last_workspace_owner();

-- ---------------------------------------------------------------------------
-- 5. Ownership transfer
--
-- Section 3 made owners immutable through team management. Without this, that
-- would mean ownership could never move at all, and an organization whose
-- owner leaves would be stuck - which is a worse failure than the one being
-- fixed.
--
-- Deliberately narrow:
--   * only a sitting active owner of that workspace, or the installation
--     owner, may call it;
--   * the recipient must already be an active member of that workspace, so
--     ownership cannot be pushed onto a stranger;
--   * it promotes before it demotes, so the last-owner trigger above is never
--     tripped by the transfer itself;
--   * the outgoing owner is left as an admin rather than removed, because
--     silently stripping somebody's access is not what "hand over" means;
--   * it is logged.
-- ---------------------------------------------------------------------------

create or replace function public.transfer_workspace_ownership(
  p_workspace_id  uuid,
  p_to_profile_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_is_owner boolean;
begin
  if p_workspace_id is null or p_to_profile_id is null then
    raise exception 'a workspace and a recipient are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from crm_private.workspace_state ws
    where ws.workspace_id = p_workspace_id and ws.is_active
  ) then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = p_workspace_id
      and wm.profile_id = v_caller
      and wm.workspace_role = 'owner'
      and wm.is_active
  ) into v_caller_is_owner;

  if not (v_caller_is_owner or public.is_owner()) then
    raise exception 'only a workspace owner transfers ownership' using errcode = '42501';
  end if;

  if p_to_profile_id = v_caller then
    raise exception 'that profile already owns this workspace' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = p_to_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- The recipient must already be in the organization. Ownership is handed to
  -- a colleague, not used as a way to add one.
  if not exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = p_workspace_id
      and wm.profile_id = p_to_profile_id
      and wm.is_active
  ) then
    raise exception 'add this person to the organization before handing them ownership'
      using errcode = '22023';
  end if;

  -- Promote first. Between these two statements the workspace has two active
  -- owners, which is safe; the reverse order would momentarily have none.
  update public.workspace_memberships
  set workspace_role = 'owner',
      can_manage_workspace = true,
      can_manage_team = true,
      can_manage_integrations = true,
      is_active = true
  where workspace_id = p_workspace_id and profile_id = p_to_profile_id;

  if v_caller_is_owner then
    update public.workspace_memberships
    set workspace_role = 'admin'
    where workspace_id = p_workspace_id and profile_id = v_caller;
  end if;

  perform crm_private.log_lifecycle_event(
    'workspace.ownership_transferred', null,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'to_profile_id', p_to_profile_id,
      'from_profile_id', v_caller
    )
  );

  return true;
end;
$$;

comment on function public.transfer_workspace_ownership(uuid, uuid) is
  'Hand workspace ownership to an existing active member. The only path that changes an owner row: team management refuses to touch one. Promotes before demoting so the last-owner invariant is never momentarily violated, and leaves the outgoing owner as an admin rather than removing their access.';

revoke all on function public.transfer_workspace_ownership(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_workspace_ownership(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The one-shot artist seat must not be spent on somebody it cannot serve
--
-- public.seat_artist_owner is deliberately consumable exactly once: it refuses
-- the moment the artist has any membership row at all. That is what makes it
-- safe. It also makes it unforgiving, and 0087 shipped it without checking
-- whether the person being seated can actually use the seat.
--
-- crm_private.capability_from_grant still consults the legacy `profiles.role`.
-- Seat a `read_only` profile as the artist owner and the row is created, the
-- one-shot is spent forever, and the derivation then refuses that person every
-- single write: no enquiry edit, no appointment, no booking form, no money.
-- The artist ends up with an owner who cannot run their book, and the only fix
-- is a hand-written statement - the exact operator dependency this workstream
-- exists to remove.
--
-- So eligibility is checked before the row is written. The check asks the
-- authoritative derivation, not a copy of it, and it names the four writes an
-- artist running their own book actually needs. Choosing this over stripping
-- the legacy role out of the derivation is deliberate: that change would alter
-- every capability answer in the system, and it belongs in the workstream that
-- retires the global role, not in this one.
-- ---------------------------------------------------------------------------

create or replace function crm_private.can_be_seated_as_artist_owner(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(bool_and(
    crm_private.capability_from_grant(
      pr.role, 'artist', true, true, true, true, needed.capability)), false)
  from public.profiles pr
  cross join unnest(array[
    'manage_enquiries', 'manage_sessions', 'manage_finance', 'manage_booking_sources'
  ]) as needed(capability)
  where pr.id = p_profile_id and pr.is_active;
$$;

comment on function crm_private.can_be_seated_as_artist_owner(uuid) is
  'Whether a profile could actually exercise an artist-owner seat, asked of the same derivation the real capability check uses. Guards the one-shot bootstrap against being consumed on a profile whose legacy role forbids every write.';

revoke all on function crm_private.can_be_seated_as_artist_owner(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.seat_artist_owner(
  p_profile_id uuid,
  p_artist_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
  v_id uuid;
begin
  if p_artist_id is null or p_profile_id is null then
    raise exception 'an artist and a profile are required' using errcode = '22023';
  end if;

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if v_workspace_id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  if not crm_private.can_administer_workspace(v_workspace_id) then
    raise exception 'seating this artist is not permitted' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles pr where pr.id = p_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- Checked before the one-shot condition, so an ineligible target leaves the
  -- bootstrap unspent and the mistake is recoverable by picking somebody else.
  if not crm_private.can_be_seated_as_artist_owner(p_profile_id) then
    raise exception 'this person''s CRM role cannot run an artist''s book'
      using errcode = '42501',
            detail = 'A read-only CRM user holds no write capability whatever their artist membership says. Raise their CRM role first, or seat somebody else.';
  end if;

  -- The one-shot condition. Any row at all, in any state, closes this.
  if exists (
    select 1 from public.artist_memberships m where m.artist_id = p_artist_id
  ) then
    raise exception 'this artist already has a team; grant access from Team instead'
      using errcode = '23505';
  end if;

  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  ) values (
    p_profile_id, p_artist_id, 'artist',
    true, true, true, true, true, 'explicit'
  )
  returning id into v_id;

  perform crm_private.log_lifecycle_event(
    'membership.seated', p_artist_id,
    jsonb_build_object(
      'workspace_id', v_workspace_id,
      'seated_profile_id', p_profile_id,
      'access_level', 'artist'
    )
  );

  return v_id;
end;
$$;

comment on function public.seat_artist_owner(uuid, uuid) is
  'Give an artist full access to their own book, once. Requires manage_workspace, refuses a profile whose CRM role could not exercise the seat, and refuses entirely the moment the artist has any membership row at all - so it can only ever run on an artist that has never been reachable, and therefore holds no records to disclose.';

-- ---------------------------------------------------------------------------
-- 7. One read that resolves an artist's control-plane context
--
-- The bug this fixes is a semantic mismatch, not a permission one.
--
-- public.artist_onboarding_state already admits the artist themselves: it asks
-- for can_administer_workspace OR has_artist_capability(..., 'view'). But the
-- screen could not use that, because it first had to work out which workspace
-- the artist belonged to, and the only way to do that was to walk every
-- workspace the *viewer* belongs to and look for the artist on its roster.
--
-- A freshly seated artist has an artist membership and, in a studio, no
-- workspace membership at all - seat_artist_owner grants one and not the
-- other, on purpose, because workspace authority is not artist authority. So
-- list_workspaces() returned nothing for them, the walk found nothing, and the
-- artist was told they had no access to their own onboarding page.
--
-- Resolving the context server-side fixes it without bending the rule: this
-- function tells an artist the *name* of the organization they belong to,
-- which is not access to it. Every flag it returns is about the viewer, so the
-- interface can offer exactly the controls the database would accept.
-- ---------------------------------------------------------------------------

create or replace function public.artist_control_plane_context(p_artist_id uuid)
returns table (
  artist_id                    uuid,
  artist_slug                  text,
  artist_display_name          text,
  artist_timezone              text,
  artist_default_currency      text,
  artist_is_active             boolean,
  member_count                 integer,
  active_booking_sources       integer,
  enabled_integrations         integer,
  workspace_id                 uuid,
  workspace_display_name       text,
  workspace_type               public.workspace_type,
  viewer_can_administer        boolean,
  viewer_has_artist_membership boolean,
  viewer_can_manage_team       boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist public.artists%rowtype;
  v_can_administer boolean;
  v_has_membership boolean;
begin
  if p_artist_id is null then
    raise exception 'an artist is required' using errcode = '22023';
  end if;

  select * into v_artist from public.artists a where a.id = p_artist_id;
  if v_artist.id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  v_can_administer := crm_private.can_administer_workspace(v_artist.workspace_id);
  v_has_membership := crm_private.has_artist_capability(p_artist_id, 'view');

  -- Same audience as public.artist_onboarding_state, deliberately: the two are
  -- read together and it would be incoherent for one to admit somebody the
  -- other refuses.
  if not (v_can_administer or v_has_membership) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  return query
  select
    v_artist.id, v_artist.slug, v_artist.display_name, v_artist.timezone,
    v_artist.default_currency, v_artist.is_active,
    (select count(*)::int from public.artist_memberships m
      where m.artist_id = v_artist.id and m.is_active),
    (select count(*)::int from public.booking_sources b
      where b.artist_id = v_artist.id and b.is_active),
    (select count(*)::int from public.artist_integrations i
      where i.artist_id = v_artist.id and i.is_enabled),
    w.id, w.display_name, w.workspace_type,
    v_can_administer,
    v_has_membership,
    (v_can_administer
      or crm_private.has_artist_capability(p_artist_id, 'manage_team')
      or crm_private.has_workspace_capability(v_artist.workspace_id, 'manage_team'))
  from public.workspaces w
  where w.id = v_artist.workspace_id;
end;
$$;

comment on function public.artist_control_plane_context(uuid) is
  'Everything the artist administration screen needs to render, in one read, for either audience: somebody administering the organization, or the artist themselves through their own membership. Naming the organization an artist belongs to is not access to that organization - no workspace right follows from this read.';

revoke all on function public.artist_control_plane_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.artist_control_plane_context(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. May this person see the control plane at all
--
-- The browser was answering this from `profiles.role`, which is the legacy
-- installation-wide role, and it got both directions wrong. A read_only
-- profile holding genuine workspace administration was refused the screen
-- outright - a real lockout, not a cosmetic one. A booking_manager belonging
-- to no organization was offered a nav entry leading to an empty page.
--
-- Neither is a security failure: RLS decides the data either way. Both are
-- product failures, and the second kind teaches people that the interface's
-- affordances are noise.
--
-- One row, cheap, from the same mirrors authorization reads.
-- ---------------------------------------------------------------------------

create or replace function public.control_plane_access()
returns table (
  workspace_count      integer,
  administers_any      boolean,
  can_manage_any_team  boolean,
  can_found_workspace  boolean,
  can_browse_directory boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    (select count(*)::int
       from crm_private.workspace_access wa
       join crm_private.workspace_state ws on ws.workspace_id = wa.workspace_id
      where wa.profile_id = auth.uid() and wa.is_active and ws.is_active),
    exists (
      select 1 from crm_private.workspace_access wa
      join crm_private.workspace_state ws on ws.workspace_id = wa.workspace_id
      where wa.profile_id = auth.uid() and wa.is_active and ws.is_active
        and wa.can_manage_workspace and wa.workspace_role in ('owner', 'admin')),
    exists (
      select 1 from crm_private.workspace_access wa
      join crm_private.workspace_state ws on ws.workspace_id = wa.workspace_id
      where wa.profile_id = auth.uid() and wa.is_active and ws.is_active
        and wa.can_manage_team and wa.workspace_role in ('owner', 'admin')),
    crm_private.can_found_workspace(),
    crm_private.can_browse_directory()
  where public.is_active_user();
$$;

comment on function public.control_plane_access() is
  'What the signed-in profile may do in the control plane, so the interface stops deriving it from the legacy global role. Returns no row for a profile with no active CRM identity. Hiding a control is a courtesy; row level security and the named RPCs remain the authority.';

revoke all on function public.control_plane_access()
  from public, anon, authenticated, service_role;
grant execute on function public.control_plane_access() to authenticated;
