-- 0088_control_plane_reads.sql
--
-- The reading half of the control plane: the roster, the team, the capability
-- preview, and the onboarding state that tells somebody what is left to do.
--
-- The question every function here answers
-- ----------------------------------------
-- Migration 0087 made adding an artist possible. This one makes it
-- *followable*: after "Add artist" succeeds, a person on a phone has to be
-- able to see what that artist still needs, who can reach them, and what each
-- of those people can actually do — without knowing any of the vocabulary the
-- database uses.
--
-- The rule these reads obey
-- -------------------------
-- Two audiences, and they see different things.
--
--   * A workspace administrator sees the *shape* of the organization: which
--     artists exist, whether each is ready, who holds which membership. This
--     is organizational metadata, and administering an organization is exactly
--     the right to see it.
--
--   * Operational data - clients, enquiries, money, provider identifiers -
--     still requires an artist membership, from every one of these functions,
--     with no exception carved for administrators.
--
-- So `list_workspace_artists` will tell a studio owner that Artist Z has no
-- booking source, and will not tell them a single thing about Artist Z's
-- clients. That distinction is the whole design, and test 235 pins it.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. What a membership shape would mean
--
-- The capability editor's problem: it has to show what "booking manager, may
-- manage sessions, no finance" actually produces, and it must not be able to
-- disagree with the database. Migration 0087 factored the derivation into
-- crm_private.capability_from_grant precisely so this function could ask the
-- authoritative rule a hypothetical question instead of the browser guessing.
--
-- Note it takes the *target* profile, because the answer depends on their
-- global role: the legacy crm_role still narrows what any membership can mean,
-- and an editor that ignored that would offer a manager finance access the
-- database would then refuse.
-- ---------------------------------------------------------------------------

create or replace function public.preview_membership_capabilities(
  p_artist_id               uuid,
  p_profile_id              uuid,
  p_access_level            public.artist_access_level,
  p_can_view_finance        boolean default false,
  p_can_manage_finance      boolean default false,
  p_can_manage_sessions     boolean default false,
  p_can_manage_integrations boolean default false
)
returns table (
  capability  text,
  domain      text,
  is_write    boolean,
  description text,
  granted     boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
  v_role public.crm_role;
begin
  if p_artist_id is null or p_profile_id is null then
    raise exception 'an artist and a profile are required' using errcode = '22023';
  end if;

  select a.workspace_id into v_workspace_id
  from public.artists a where a.id = p_artist_id;
  if v_workspace_id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  -- Same two doors as public.grant_workspace_artist_membership: you may look
  -- at what a grant would mean exactly when you could make that grant.
  if not (
    public.is_owner()
    or crm_private.has_artist_capability(p_artist_id, 'manage_team')
    or crm_private.has_workspace_capability(v_workspace_id, 'manage_team')
  ) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  select pa.role into v_role
  from crm_private.profile_access pa
  where pa.profile_id = p_profile_id and pa.is_active;
  if v_role is null then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- Every non-legacy capability, each marked with whether this shape produces
  -- it. Returning the ungranted ones too is the point: an editor that only
  -- listed what was granted could not show a person what they are turning on.
  return query
  select r.capability, r.domain, r.is_write, r.description,
         crm_private.capability_from_grant(
           v_role,
           p_access_level,
           coalesce(p_can_view_finance, false),
           coalesce(p_can_manage_finance, false),
           coalesce(p_can_manage_sessions, false),
           coalesce(p_can_manage_integrations, false),
           r.capability
         )
  from public.capability_registry r
  where r.domain not in ('legacy', 'workspace')
  order by r.domain, r.is_write, r.capability;
end;
$$;

comment on function public.preview_membership_capabilities(
  uuid, uuid, public.artist_access_level, boolean, boolean, boolean, boolean
) is
  'What one prospective artist membership would let a person do, answered by the same derivation crm_private.has_artist_capability uses. The capability editor reads this instead of re-implementing authorization in the browser, so the interface can never offer a right the database would refuse. Excludes the workspace domain, which is not a membership grant.';

revoke all on function public.preview_membership_capabilities(
  uuid, uuid, public.artist_access_level, boolean, boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.preview_membership_capabilities(
  uuid, uuid, public.artist_access_level, boolean, boolean, boolean, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The artist roster of one workspace
--
-- Deliberately not `list_accessible_artists`. That function answers "which
-- artists may I work on", and it is right that a studio administrator with no
-- artist membership gets an empty answer from it. This one answers "which
-- artists does this organization have", which is a different question with a
-- different audience.
--
-- `viewer_has_membership` is what keeps the two from being confused in the
-- interface: it says, per row, whether the person reading this can actually
-- open that artist, so the CRM can offer "you administer this artist but
-- cannot see their work" instead of a link that fails.
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_artists(p_workspace_id uuid)
returns table (
  id                    uuid,
  slug                  text,
  display_name          text,
  timezone              text,
  default_currency      text,
  is_active             boolean,
  member_count          integer,
  active_booking_sources integer,
  enabled_integrations  integer,
  viewer_has_membership boolean,
  created_at            timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_workspace_id is null then
    raise exception 'a workspace is required' using errcode = '22023';
  end if;
  -- Workspace membership of any kind is enough to see the roster; changing it
  -- is what needs manage_workspace.
  perform crm_private.require_workspace_access(p_workspace_id, 'view');

  return query
  select
    a.id, a.slug, a.display_name, a.timezone, a.default_currency, a.is_active,
    (select count(*)::int from public.artist_memberships m
      where m.artist_id = a.id and m.is_active),
    (select count(*)::int from public.booking_sources b
      where b.artist_id = a.id and b.is_active),
    -- A count, never a label, a key or an account identifier. Which providers
    -- an artist has connected is answered by list_integration_status, which
    -- requires the artist-scoped right to ask.
    (select count(*)::int from public.artist_integrations i
      where i.artist_id = a.id and i.is_enabled),
    crm_private.has_artist_capability(a.id, 'view'),
    a.created_at
  from public.artists a
  where a.workspace_id = p_workspace_id
  order by a.is_active desc, a.display_name;
end;
$$;

comment on function public.list_workspace_artists(uuid) is
  'The artists in one organization, with readiness counts. Organizational metadata only: no client, enquiry, financial or provider detail, and no integration labels. viewer_has_membership reports whether the reader could actually open each artist.';

revoke all on function public.list_workspace_artists(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_artists(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The people of one workspace
--
-- This replaces the installation-wide Users x Artists matrix as the primary
-- team surface. The matrix could only ever grow as the product succeeded, and
-- it showed a studio administrator every profile in the installation including
-- people from organizations they have nothing to do with.
--
-- Scoped to a workspace, the same information is bounded and answerable: these
-- are the people here, this is what each holds at organization level, and this
-- is how many of this organization's artists each can reach.
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_team(p_workspace_id uuid)
returns table (
  profile_id              uuid,
  display_name            text,
  email                   text,
  profile_is_active       boolean,
  profile_role            public.crm_role,
  workspace_role          public.workspace_role,
  can_manage_workspace    boolean,
  can_manage_team         boolean,
  can_manage_integrations boolean,
  membership_is_active    boolean,
  artist_access_count     integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_workspace_id is null then
    raise exception 'a workspace is required' using errcode = '22023';
  end if;
  -- Seeing who else is in the organization, and what they hold, is a team
  -- management right. An ordinary member does not get the staff directory.
  perform crm_private.require_workspace_access(p_workspace_id, 'manage_team');

  return query
  select
    pr.id, pr.display_name, pr.email::text, pr.is_active, pr.role,
    wm.workspace_role, wm.can_manage_workspace, wm.can_manage_team,
    wm.can_manage_integrations, wm.is_active,
    (select count(*)::int
       from public.artist_memberships m
       join public.artists a on a.id = m.artist_id
      where m.profile_id = pr.id
        and m.is_active
        and a.workspace_id = p_workspace_id)
  from public.workspace_memberships wm
  join public.profiles pr on pr.id = wm.profile_id
  where wm.workspace_id = p_workspace_id
  order by wm.is_active desc, pr.display_name nulls last, pr.email;
end;
$$;

comment on function public.list_workspace_team(uuid) is
  'The people in one organization and what each holds at organization level. Scoped to the workspace, so it never discloses the wider installation''s staff directory. Requires manage_team on that workspace.';

revoke all on function public.list_workspace_team(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_team(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Who can reach one artist, and why
--
-- The interface question this exists for is "why does this person have access
-- to this artist" - which the CRM should be able to answer without anyone
-- reasoning about triggers. `grant_source` from migration 0074 already records
-- it, so the answer is simply carried through.
-- ---------------------------------------------------------------------------

create or replace function public.list_artist_memberships(p_artist_id uuid)
returns table (
  profile_id              uuid,
  display_name            text,
  email                   text,
  profile_is_active       boolean,
  profile_role            public.crm_role,
  access_level            public.artist_access_level,
  can_view_finance        boolean,
  can_manage_finance      boolean,
  can_manage_sessions     boolean,
  can_manage_integrations boolean,
  is_active               boolean,
  grant_source            text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
begin
  if p_artist_id is null then
    raise exception 'an artist is required' using errcode = '22023';
  end if;

  select a.workspace_id into v_workspace_id
  from public.artists a where a.id = p_artist_id;
  if v_workspace_id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  if not (
    public.is_owner()
    or crm_private.has_artist_capability(p_artist_id, 'manage_team')
    or crm_private.has_workspace_capability(v_workspace_id, 'manage_team')
  ) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  return query
  select
    pr.id, pr.display_name, pr.email::text, pr.is_active, pr.role,
    m.access_level, m.can_view_finance, m.can_manage_finance,
    m.can_manage_sessions, m.can_manage_integrations, m.is_active, m.grant_source
  from public.artist_memberships m
  join public.profiles pr on pr.id = m.profile_id
  where m.artist_id = p_artist_id
  order by m.is_active desc, pr.display_name nulls last, pr.email;
end;
$$;

comment on function public.list_artist_memberships(uuid) is
  'Who holds a membership on one artist, what it grants, and where it came from. Requires manage_team on the artist or on its workspace.';

revoke all on function public.list_artist_memberships(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_artist_memberships(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What is left to do
--
-- The onboarding checklist, computed rather than remembered. There is no
-- `onboarding_state` column and no wizard progress table anywhere in this
-- migration, on purpose: a stored step counter goes stale the moment somebody
-- disables the booking form it claimed was done, and then the checklist starts
-- lying. Every row below is derived from the live state each time it is asked.
--
-- The `status` vocabulary is small and deliberately honest about the thing the
-- brief called an external blocker:
--
--   ready     - done, nothing to do
--   required  - the artist cannot work until this is done
--   recommended - strongly advised, not blocking
--   optional  - available, genuinely fine to skip
--   external  - cannot be finished inside the CRM at all, because it needs a
--               provider approval or an OAuth consent somewhere else
--
-- A wizard that demanded "connect Instagram" as a required step would be
-- asking for something no click in this CRM can deliver. `external` is how the
-- checklist says so instead of pretending.
-- ---------------------------------------------------------------------------

create or replace function public.artist_onboarding_state(p_artist_id uuid)
returns table (
  step        text,
  status      text,
  detail      text,
  sort_order  integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist       public.artists%rowtype;
  v_workspace    public.workspaces%rowtype;
  v_members      integer;
  v_artist_seats integer;
  v_sources      integer;
  v_active_src   integer;
  v_integrations integer;
  v_automations  integer;
  v_defaults     integer;
  v_targets      integer;
begin
  if p_artist_id is null then
    raise exception 'an artist is required' using errcode = '22023';
  end if;

  select * into v_artist from public.artists a where a.id = p_artist_id;
  if v_artist.id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;
  select * into v_workspace from public.workspaces w where w.id = v_artist.workspace_id;

  -- Readable by somebody who administers the organization, or by somebody who
  -- holds a membership on this artist. Both need to follow onboarding; neither
  -- learns anything operational from it.
  if not (
    crm_private.can_administer_workspace(v_artist.workspace_id)
    or crm_private.has_artist_capability(p_artist_id, 'view')
  ) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  select count(*) into v_members
  from public.artist_memberships m where m.artist_id = p_artist_id and m.is_active;

  select count(*) into v_artist_seats
  from public.artist_memberships m
  where m.artist_id = p_artist_id and m.is_active
    and m.access_level in ('owner', 'artist');

  select count(*), count(*) filter (where b.is_active)
    into v_sources, v_active_src
  from public.booking_sources b where b.artist_id = p_artist_id;

  select count(*) into v_integrations
  from public.artist_integrations i where i.artist_id = p_artist_id and i.is_enabled;

  select count(*) into v_automations
  from public.automation_rules r where r.artist_id = p_artist_id and r.is_enabled;

  select count(*) into v_defaults
  from public.workspace_automation_defaults d where d.workspace_id = v_artist.workspace_id;

  -- Whether anybody who works on this artist can actually be reached. Counted
  -- through the private targets table, so no chat id or address is disclosed -
  -- only whether a route exists.
  select count(*) into v_targets
  from crm_private.profile_notification_targets t
  join public.artist_memberships m on m.profile_id = t.profile_id
  where m.artist_id = p_artist_id and m.is_active and t.is_active;

  return query
  select * from (values
    ('identity'::text, (case when v_artist.is_active then 'ready' else 'required' end)::text,
     (case when v_artist.is_active
       then v_artist.display_name || ' · ' || v_artist.timezone || ' · ' || v_artist.default_currency
       else 'This artist is deactivated. Reactivate them to continue.' end)::text,
     1),

    ('workspace', 'ready',
     coalesce(v_workspace.display_name, 'Unknown') ||
       case when v_workspace.workspace_type = 'solo' then ' · solo' else ' · studio' end,
     2),

    -- The one step that is genuinely required. An artist nobody holds a
    -- membership on has no way in: not the CRM, not the GPT, not MCP. It is
    -- also the step people skip, because create_artist deliberately grants the
    -- creator nothing.
    ('team', case when v_artist_seats > 0 then 'ready'
                  when v_members > 0 then 'recommended'
                  else 'required' end,
     case when v_artist_seats > 0
            then v_members::text || ' with access, including the artist'
          when v_members > 0
            then v_members::text || ' with access, but nobody at artist level yet'
          else 'Nobody can open this artist yet' end,
     3),

    ('booking', case when v_active_src > 0 then 'ready'
                     when v_sources > 0 then 'recommended'
                     else 'recommended' end,
     case when v_active_src > 0 then v_active_src::text || ' live'
          when v_sources > 0 then 'Created, not switched on'
          else 'No booking form or website yet' end,
     4),

    ('notifications', case when v_targets > 0 then 'ready' else 'recommended' end,
     case when v_targets > 0 then 'Someone on this artist can be reached'
          else 'Nobody on this artist has a delivery destination' end,
     5),

    -- Never 'required'. Calendar, Gmail, Monzo, WhatsApp and Instagram each
    -- need an OAuth consent or a provider approval that happens outside this
    -- CRM, and an artist works perfectly well with none of them.
    ('integrations', case when v_integrations > 0 then 'ready' else 'external' end,
     case when v_integrations > 0 then v_integrations::text || ' connected'
          else 'Each provider is connected from Integrations, and some need approval outside the CRM' end,
     6),

    ('automations', case when v_automations > 0 then 'ready'
                         when v_defaults > 0 then 'optional'
                         else 'optional' end,
     case when v_automations > 0 then v_automations::text || ' rule(s) running'
          when v_defaults > 0 then v_defaults::text || ' studio default(s) available to apply'
          else 'No studio defaults to apply' end,
     7)
  ) as steps(step, status, detail, sort_order)
  order by 4;
end;
$$;

comment on function public.artist_onboarding_state(uuid) is
  'What an artist still needs, derived from live state on every call rather than stored as wizard progress. status is one of ready, required, recommended, optional, external - where external means the step cannot be completed inside the CRM because a provider approval or consent happens elsewhere.';

revoke all on function public.artist_onboarding_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.artist_onboarding_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Opening the automation-defaults slice
--
-- Migration 0083 shipped its control plane closed - granted to no API role at
-- all - pending a release that gave it a screen. Test 233 asserts that state
-- rather than papering over it, which is why this migration has to update the
-- assertion as well as the grants.
--
-- Two of the three functions open here, and only two. Onboarding's automation
-- step is "apply what this studio already decided to a new artist", which
-- needs to list the defaults and apply them. Authoring defaults is the
-- Automation Product, a separate workstream, and
-- public.upsert_workspace_automation_default stays closed until it has a
-- screen of its own.
--
-- Neither function is loosened. Both already run their own checks:
-- list requires workspace access, and apply requires *both* workspace
-- manage_integrations and artist manage_automations - so a studio
-- administrator with no membership on the new artist still cannot push rules
-- onto them.
-- ---------------------------------------------------------------------------

revoke all on function public.list_workspace_automation_defaults(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_automation_defaults(uuid)
  to authenticated;

revoke all on function public.apply_workspace_automation_defaults_to_artist(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_workspace_automation_defaults_to_artist(uuid)
  to authenticated;
