-- 0087_artist_workspace_lifecycle.sql
--
-- The lifecycle half of the control plane: creating and administering
-- workspaces and artists as ordinary CRM operations.
--
-- The gap this closes
-- -------------------
-- Migration 0075 gave the platform an organization layer, but nothing could
-- create one. `public.workspaces` carries FORCE ROW LEVEL SECURITY and had no
-- INSERT or UPDATE policy at all, so the only rows that ever existed were the
-- ones the 0075 backfill wrote while the migration itself held superuser.
-- `public.artists` was worse in a subtler way: it has an INSERT policy, but the
-- policy names `public.is_owner()` — the legacy installation-wide role — and
-- `authenticated` holds only SELECT on the table. Adding an artist was
-- therefore not a CRM operation. It was a hand-written statement run by
-- somebody with database credentials.
--
-- That is the single reason a new artist was an engineering project.
--
-- What this migration does NOT do
-- -------------------------------
-- It does not grant `authenticated` write privileges on either table. The
-- named RPCs below are SECURITY DEFINER and remain the only door; the policies
-- exist so that door is auditable and so the definer path is not relying on a
-- BYPASSRLS accident. A browser still cannot write these tables directly.
--
-- It does not give a workspace role any artist-scoped access. Creating an
-- artist grants the creator nothing on that artist — they must go on to call
-- public.grant_workspace_artist_membership like anybody else, which is an
-- explicit, logged, revocable act. That keeps 0075's invariant exact: a
-- workspace membership never, on its own, produces an artist capability.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 0. Addressing, derived rather than asked for
--
-- Both `workspaces.slug` and `artists.slug` are constrained to
-- `^[a-z][a-z0-9-]{1,62}$`. Those are addressing details; a person adding an
-- artist from a phone should not have to know they exist, let alone satisfy a
-- regular expression. Derive one from the display name and let the callers
-- below disambiguate collisions.
--
-- Non-Latin names are the case that decides the shape of this function.
-- `unaccent` would fold "Renée" to "renee" but leaves Cyrillic and CJK names
-- as an empty string, which would then fail the constraint and reject a
-- perfectly good name. So an empty result is not an error here: it returns
-- null and the caller falls back to a generated address.
-- ---------------------------------------------------------------------------

create or replace function crm_private.slugify(p_text text)
returns text
language sql
immutable
as $$
  select case
    when v.slug ~ '^[a-z][a-z0-9-]{1,62}$' then v.slug
    when v.slug ~ '^[a-z0-9-]{2,62}$' then 'a-' || left(v.slug, 60)
    else null
  end
  from (
    select btrim(
      regexp_replace(
        regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ),
      '-'
    ) as slug
  ) v;
$$;

comment on function crm_private.slugify(text) is
  'A public address derived from a display name, or null when the name yields nothing usable (a wholly non-Latin name). Callers substitute a generated address rather than rejecting the name.';

revoke all on function crm_private.slugify(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. One derivation of an artist capability, not two
--
-- `crm_private.has_artist_capability` decides what a membership row means. Its
-- CASE arm is the authority for the CRM, MCP and GPT surfaces alike.
--
-- The control plane needs to answer a second, closely related question: "if I
-- gave this person this membership shape, what would they be able to do?" A
-- capability editor that cannot answer it has to re-implement the derivation
-- in the browser, and a browser copy of an authorization rule is a second
-- permission system that drifts.
--
-- So the derivation moves into one pure function that both callers share.
-- `has_artist_capability` keeps its exact behaviour - it is re-created below
-- delegating to this - and public.preview_membership_capabilities in migration
-- 0088 asks the same function the hypothetical question.
--
-- Pure by construction: it reads no table and consults no session. Everything
-- it needs is an argument, which is what makes it safe to ask about somebody
-- else's prospective membership.
-- ---------------------------------------------------------------------------

create or replace function crm_private.capability_from_grant(
  p_role                    public.crm_role,
  p_access_level            public.artist_access_level,
  p_can_view_finance        boolean,
  p_can_manage_finance      boolean,
  p_can_manage_sessions     boolean,
  p_can_manage_integrations boolean,
  p_capability              text
)
returns boolean
language sql
immutable
as $$
  select case p_capability
    -- Legacy vocabulary. Unchanged.
    when 'view' then true
    when 'manage' then
      p_role in ('owner', 'booking_manager')
      and p_access_level <> 'read_only'
    when 'view_finance' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_view_finance)
    when 'manage_finance' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_manage_finance)
    when 'manage_sessions' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_manage_sessions)
    when 'manage_integrations' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_manage_integrations)

    -- Reads. Any active membership on the artist already implies these.
    when 'view_clients' then true
    when 'view_enquiries' then true
    when 'view_projects' then true
    when 'view_sessions' then true
    when 'view_communications' then true
    when 'view_integrations' then true
    when 'view_booking_sources' then true
    when 'view_notifications' then true
    when 'view_automations' then true

    -- Writes the legacy `manage` right already covered.
    when 'manage_clients' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'manage_enquiries' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'assign_enquiries' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'manage_projects' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'send_communications' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'manage_communications' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'
    when 'manage_notifications' then
      p_role in ('owner', 'booking_manager') and p_access_level <> 'read_only'

    -- Writes that follow the integrations right, because they change how work
    -- reaches the outside world.
    when 'manage_booking_sources' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_manage_integrations)
    when 'manage_automations' then
      p_role = 'owner'
      or (p_role = 'booking_manager' and p_can_manage_integrations)

    -- An artist runs their own team. A manager does not acquire the power to
    -- invite further managers by being able to manage integrations.
    when 'manage_team' then
      p_role = 'owner'
      or p_access_level in ('owner', 'artist')

    -- Deliberately absent: 'manage_workspace'. It is decided against the
    -- workspace the artist belongs to, not against this membership row, so it
    -- is not derivable from these arguments. has_artist_capability answers it;
    -- a membership editor must never offer it as something to hand out.
    else false
  end;
$$;

comment on function crm_private.capability_from_grant(
  public.crm_role, public.artist_access_level, boolean, boolean, boolean, boolean, text
) is
  'What one artist membership shape means, as a pure function of the grant. The single derivation shared by crm_private.has_artist_capability and public.preview_membership_capabilities, so a capability editor never re-implements authorization in the browser. Returns false for manage_workspace, which is workspace-scoped and not a membership grant.';

revoke all on function crm_private.capability_from_grant(
  public.crm_role, public.artist_access_level, boolean, boolean, boolean, boolean, text
) from public, anon, authenticated, service_role;

-- Re-created with every arm now coming from the shared function, except
-- `manage_workspace`, which stays here because it needs the artist id. It also
-- stays *inside* the membership EXISTS on purpose: holding workspace
-- administration while holding no membership on this artist still answers
-- false, which is 0075's invariant stated in code.
--
-- One behavioural change, and it is deliberate: the artist must be active.
--
-- Until now this function checked that the *profile* was active and that the
-- *membership* was active, and never looked at the artist. `list_capabilities`
-- did check - it joins crm_private.artist_state and filters on is_active - so
-- the platform already disagreed with itself: the same person asking "what may
-- I do" and "may I do this" got different answers about a deactivated artist.
-- The second one was the load-bearing question, because require_artist_access
-- calls this, and every artist-scoped RPC calls require_artist_access.
--
-- The practical effect was that deactivating an artist closed the public
-- booking door (the resolvers join artist_state) and the artist selector (it
-- filters on is_active) while leaving every write RPC open to anybody holding
-- a membership. Deactivation has to mean one thing, so it now means this.
--
-- Reactivation is unaffected: public.update_artist authorises through
-- crm_private.can_administer_workspace, which is workspace-scoped and never
-- consults this function. A deactivated artist can always be brought back.
create or replace function crm_private.has_artist_capability(
  p_artist_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from crm_private.profile_access p
    join crm_private.artist_access a on a.profile_id = p.profile_id
    join crm_private.artist_state s on s.artist_id = a.artist_id
    where p.profile_id = auth.uid()
      and p.is_active
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
$$;

-- ---------------------------------------------------------------------------
-- 2. Who may administer an organization
--
-- Two ways in, and they are different rights:
--   * the legacy installation owner, who keeps administering everything until
--     the transition off the global role completes;
--   * a workspace's own `manage_workspace` right.
--
-- Nothing else. A booking_manager with artist memberships across a studio does
-- not administer that studio.
-- ---------------------------------------------------------------------------

create or replace function crm_private.can_administer_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select p_workspace_id is not null
     and (
       public.is_owner()
       or crm_private.has_workspace_capability(p_workspace_id, 'manage_workspace')
     );
$$;

revoke all on function crm_private.can_administer_workspace(uuid)
  from public, anon, authenticated, service_role;

-- Creating a *new* organization is the one control-plane act with no existing
-- workspace to check against. The rule is deliberately narrow: you may found
-- an organization if you already administer one, or if you are the
-- installation owner. There is no self-signup in this CRM - people arrive by
-- invitation - so this never has to admit a stranger.
create or replace function crm_private.can_found_workspace()
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
         select 1
         from crm_private.workspace_access wa
         where wa.profile_id = auth.uid()
           and wa.is_active
           and wa.can_manage_workspace
       )
     );
$$;

revoke all on function crm_private.can_found_workspace()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Row level security for the two identity tables
--
-- `authenticated` still holds SELECT and nothing else on both tables, so these
-- policies are not what stands between a browser and a write - privilege is.
-- Nor are they what makes the RPCs below work: those are SECURITY DEFINER,
-- owned by `postgres`, and `postgres` holds BYPASSRLS on hosted Supabase, so
-- the policy is not consulted on that path either.
--
-- They are here for the same reason as 3b. `public.workspaces` currently has
-- FORCE ROW LEVEL SECURITY and no INSERT or UPDATE policy at all, which reads
-- as "nobody may ever create an organization" - a statement that was true when
-- 0075 shipped and is the exact thing this migration is undoing. Writing the
-- rule down keeps the policies a truthful record of who may bring an artist or
-- an organization into being, and keeps the control plane working rather than
-- silently failing if the `postgres` role is ever tightened.
-- ---------------------------------------------------------------------------

drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces
  for insert
  with check (crm_private.can_found_workspace() or crm_private.is_service_backend());

drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces
  for update
  using (crm_private.can_administer_workspace(id) or crm_private.is_service_backend())
  with check (crm_private.can_administer_workspace(id) or crm_private.is_service_backend());

-- No DELETE policy on either table, here or anywhere. An organization or an
-- artist that has ever held work is deactivated, never removed: `is_active`
-- closes every door while the audit trail and the operational history stay
-- attached to something that still exists.

-- The artist policies widen from the installation-wide owner to "the owner, or
-- somebody who administers the workspace this artist belongs to". Note the
-- predicate reads `workspace_id` from the candidate row, so an administrator of
-- workspace A cannot create or move an artist into workspace B.
drop policy if exists artists_insert on public.artists;
create policy artists_insert on public.artists
  for insert
  with check (
    crm_private.can_administer_workspace(workspace_id)
    or crm_private.is_service_backend()
  );

drop policy if exists artists_update on public.artists;
create policy artists_update on public.artists
  for update
  using (
    crm_private.can_administer_workspace(workspace_id)
    or crm_private.is_service_backend()
  )
  with check (
    crm_private.can_administer_workspace(workspace_id)
    or crm_private.is_service_backend()
  );

-- ---------------------------------------------------------------------------
-- 3b. Aligning the audit policy with who the platform now admits
--
-- Be precise about what this does and does not fix, because it is easy to tell
-- a more dramatic story than the truth.
--
-- `activity_log_insert_artist_scope` from migration 0019 admits three kinds of
-- writer: the service backend, the installation owner, and a booking_manager
-- writing ordinary operational events. It then excludes `artist.%`,
-- `membership.%`, `profile.%` and `settings.%` from that third case, because in
-- 0019 those event families were owner-only administration.
--
-- Migration 0075 introduced somebody 0019 could not have anticipated: a
-- workspace administrator who is not the installation owner. Read literally,
-- this policy says such a person may not record a `membership.%` event - even
-- though public.grant_workspace_artist_membership is granted to them and ends
-- by logging exactly that.
--
-- That contradiction is currently inert, and it is worth saying why rather
-- than implying a bug that does not exist. Every writer here goes through a
-- SECURITY DEFINER function owned by `postgres`, and on hosted Supabase
-- `postgres` holds BYPASSRLS. The policy is therefore not consulted on any of
-- these paths today: 0075's staffing call works, and the control-plane
-- functions below would work whatever this policy said.
--
-- So this is not a fix for a live failure. It is removing a statement that has
-- become false. The policy is the readable record of who may append what to
-- the audit trail; leaving it saying "installation owner only" while the
-- platform deliberately admits workspace administrators would make it
-- misleading documentation, and would turn any future tightening of the
-- `postgres` role - a hosting decision this repository does not control - into
-- a broken control plane rather than a no-op.
--
-- It keeps every existing rule and adds one alternative: a workspace
-- administrator may write the control-plane event families, for an artist in
-- the workspace they administer. It widens nothing else - operational events
-- still require can_manage_artist, and finance, payment and integration events
-- are still refused to a workspace role, because administering an organization
-- has never implied reading an artist's money.
-- ---------------------------------------------------------------------------

drop policy if exists activity_log_insert_artist_scope on public.activity_log;
create policy activity_log_insert_artist_scope on public.activity_log
  for insert
  with check (
    crm_private.is_service_backend()
    or public.is_owner()
    or (
      artist_id is not null
      and public.can_manage_artist(artist_id)
      and event_type not like 'profile.%'
      and event_type not like 'settings.%'
      and event_type not like 'artist.%'
      and event_type not like 'membership.%'
      and event_type not like 'payment.%'
      and event_type not like 'finance.%'
      and event_type not like 'integration.%'
    )
    or (
      -- The control plane, writing about the organization it administers.
      artist_id is not null
      and (event_type like 'artist.%' or event_type like 'membership.%')
      and crm_private.can_administer_workspace(
        (select a.workspace_id from public.artists a where a.id = activity_log.artist_id)
      )
    )
    or (
      -- Workspace-level events carry no artist at all.
      artist_id is null
      and event_type like 'workspace.%'
      and crm_private.can_found_workspace()
    )
  );

-- ---------------------------------------------------------------------------
-- 3c. Recording a lifecycle event about an artist that is not active
--
-- crm_private.log_artist_activity calls crm_private.require_active_artist,
-- which is right for operational events and exactly wrong for these: the two
-- most important control-plane events to record are the deactivation of an
-- artist and the reactivation of one. Both are about an artist that is, at the
-- moment the row is written, not active.
--
-- So the lifecycle RPCs use this instead. Same table, same guard trigger, same
-- policy; it simply does not require the subject to be live.
-- ---------------------------------------------------------------------------

create or replace function crm_private.log_lifecycle_event(
  p_event_type text,
  p_artist_id  uuid default null,
  p_metadata   jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  -- Generated rather than read back with RETURNING, for the same reason
  -- crm_private.log_activity does it: RETURNING applies the SELECT policy, and
  -- a workspace administrator cannot necessarily read this artist's log.
  v_id uuid := gen_random_uuid();
begin
  insert into public.activity_log (id, artist_id, event_type, actor_kind, actor_profile_id, metadata)
  values (v_id, p_artist_id, p_event_type, 'staff', auth.uid(), coalesce(p_metadata, '{}'::jsonb));
  return v_id;
end;
$$;

revoke all on function crm_private.log_lifecycle_event(text, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Workspace lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace(
  p_display_name     text,
  p_workspace_type   public.workspace_type default 'studio',
  p_slug             text default null,
  p_timezone         text default 'Europe/London',
  p_default_currency text default 'GBP'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug   text;
  v_suffix integer := 1;
  v_id     uuid;
begin
  if not crm_private.can_found_workspace() then
    raise exception 'creating an organization is not permitted' using errcode = '42501';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'a display name is required' using errcode = '22023';
  end if;
  if char_length(btrim(p_display_name)) > 120 then
    raise exception 'the display name is too long' using errcode = '22023';
  end if;

  -- A slug is an addressing detail, not something a CRM user should have to
  -- invent. Derive one from the name when none is offered, and disambiguate
  -- rather than failing, so "Ink Studio" twice is not an error the user has to
  -- understand.
  v_slug := coalesce(
    nullif(btrim(coalesce(p_slug, '')), ''),
    crm_private.slugify(p_display_name),
    'workspace-' || replace(gen_random_uuid()::text, '-', '')
  );
  -- Only an explicitly supplied slug can fail this: the derived paths are
  -- valid by construction.
  if v_slug !~ '^[a-z][a-z0-9-]{1,62}$' then
    raise exception 'that short name cannot be used as an address' using errcode = '22023';
  end if;

  while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := left(v_slug, 60) || '-' || v_suffix::text;
  end loop;

  insert into public.workspaces (
    slug, display_name, workspace_type, timezone, default_currency, is_active
  ) values (
    v_slug,
    btrim(p_display_name),
    coalesce(p_workspace_type, 'studio'),
    case when p_timezone is null or btrim(p_timezone) = '' then 'Europe/London' else btrim(p_timezone) end,
    case when p_default_currency ~ '^[A-Z]{3}$' then p_default_currency else 'GBP' end,
    true
  )
  returning id into v_id;

  -- Whoever founded the organization administers it. This is the only place a
  -- workspace owner appears without being named by an existing owner, and it
  -- reaches no artist: the new workspace has none.
  insert into public.workspace_memberships (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  ) values (
    auth.uid(), v_id, 'owner', true, true, true, true
  )
  on conflict (profile_id, workspace_id) do nothing;

  perform crm_private.log_lifecycle_event(
    'workspace.created', null,
    jsonb_build_object(
      'workspace_id', v_id,
      'workspace_type', coalesce(p_workspace_type, 'studio')::text,
      'slug', v_slug
    )
  );

  return v_id;
end;
$$;

comment on function public.create_workspace(text, public.workspace_type, text, text, text) is
  'Found an organization. The caller becomes its owner; the workspace starts with no artists, so this grants no artist-scoped access to anything.';

revoke all on function public.create_workspace(text, public.workspace_type, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_workspace(text, public.workspace_type, text, text, text)
  to authenticated;

create or replace function public.update_workspace(
  p_workspace_id     uuid,
  p_display_name     text default null,
  p_timezone         text default null,
  p_default_currency text default null,
  p_is_active        boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_before public.workspaces%rowtype;
begin
  if p_workspace_id is null then
    raise exception 'a workspace is required' using errcode = '22023';
  end if;
  if not crm_private.can_administer_workspace(p_workspace_id) then
    raise exception 'administering this organization is not permitted' using errcode = '42501';
  end if;

  select * into v_before from public.workspaces w where w.id = p_workspace_id;
  if v_before.id is null then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  if p_display_name is not null and btrim(p_display_name) = '' then
    raise exception 'a display name is required' using errcode = '22023';
  end if;
  if p_default_currency is not null and p_default_currency !~ '^[A-Z]{3}$' then
    raise exception 'that is not a three letter currency code' using errcode = '22023';
  end if;

  -- Deactivating an organization that still runs active artists would strand
  -- them: the artists stay active, their booking forms keep accepting work,
  -- and no screen would show the organization any more. Refuse, and say what
  -- to do about it.
  if p_is_active is false and v_before.is_active then
    if exists (
      select 1 from public.artists a
      where a.workspace_id = p_workspace_id and a.is_active
    ) then
      raise exception 'deactivate this organization''s artists first'
        using errcode = '23514';
    end if;
  end if;

  update public.workspaces w
  set display_name     = coalesce(nullif(btrim(p_display_name), ''), w.display_name),
      timezone         = coalesce(nullif(btrim(p_timezone), ''), w.timezone),
      default_currency = coalesce(p_default_currency, w.default_currency),
      is_active        = coalesce(p_is_active, w.is_active),
      updated_at       = now()
  where w.id = p_workspace_id;

  perform crm_private.log_lifecycle_event(
    'workspace.updated', null,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'is_active', coalesce(p_is_active, v_before.is_active),
      'renamed', p_display_name is not null and btrim(p_display_name) <> v_before.display_name
    )
  );

  return true;
end;
$$;

comment on function public.update_workspace(uuid, text, text, text, boolean) is
  'Change organization identity or activate/deactivate it. Requires manage_workspace on that exact workspace. Refuses to deactivate an organization that still has active artists.';

revoke all on function public.update_workspace(uuid, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_workspace(uuid, text, text, text, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Artist lifecycle
--
-- The operation this whole workstream exists for.
-- ---------------------------------------------------------------------------

create or replace function public.create_artist(
  p_workspace_id            uuid,
  p_display_name            text,
  p_slug                    text default null,
  p_timezone                text default null,
  p_default_currency        text default null,
  p_booking_reference_prefix text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace public.workspaces%rowtype;
  v_slug      text;
  v_prefix    text;
  v_suffix    integer := 1;
  v_id        uuid;
begin
  if p_workspace_id is null then
    raise exception 'a workspace is required' using errcode = '22023';
  end if;
  if not crm_private.can_administer_workspace(p_workspace_id) then
    raise exception 'adding an artist to this organization is not permitted'
      using errcode = '42501';
  end if;

  select * into v_workspace from public.workspaces w where w.id = p_workspace_id;
  if v_workspace.id is null or not v_workspace.is_active then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'a display name is required' using errcode = '22023';
  end if;
  if char_length(btrim(p_display_name)) > 120 then
    raise exception 'the display name is too long' using errcode = '22023';
  end if;

  -- A solo workspace means one artist working alone. Adding a second one to it
  -- would silently turn every solo-workspace assumption elsewhere - including
  -- 0075's sync_solo_workspace_owner trigger, which makes an artist membership
  -- into workspace ownership - into a way to reach somebody else's records.
  if v_workspace.workspace_type = 'solo'
     and exists (select 1 from public.artists a where a.workspace_id = p_workspace_id) then
    raise exception 'a solo workspace holds one artist; create a studio for more'
      using errcode = '23514';
  end if;

  v_slug := coalesce(
    nullif(btrim(coalesce(p_slug, '')), ''),
    crm_private.slugify(p_display_name),
    'artist-' || replace(gen_random_uuid()::text, '-', '')
  );
  if v_slug !~ '^[a-z][a-z0-9-]{1,62}$' then
    raise exception 'that short name cannot be used as an address' using errcode = '22023';
  end if;
  while exists (select 1 from public.artists a where a.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := left(v_slug, 60) || '-' || v_suffix::text;
  end loop;

  -- The booking reference prefix appears on client-facing references, so it is
  -- derived from the name and disambiguated rather than being one more thing
  -- to invent. It is uniquely constrained on the table.
  v_prefix := upper(coalesce(
    nullif(btrim(coalesce(p_booking_reference_prefix, '')), ''),
    left(regexp_replace(v_slug, '[^a-z0-9]', '', 'g'), 3)
  ));
  if v_prefix !~ '^[A-Z0-9]{2,8}$' then
    v_prefix := 'ART';
  end if;
  v_suffix := 1;
  while exists (
    select 1 from public.artists a where a.booking_reference_prefix = v_prefix
  ) loop
    v_suffix := v_suffix + 1;
    v_prefix := left(v_prefix, 6) || v_suffix::text;
  end loop;

  -- workspace_id is supplied, so 0075's provision_artist_workspace trigger is
  -- a no-op here: this artist joins the organization the caller chose rather
  -- than founding a solo one of its own.
  insert into public.artists (
    workspace_id, slug, display_name, timezone, default_currency,
    booking_reference_prefix, is_active
  ) values (
    p_workspace_id,
    v_slug,
    btrim(p_display_name),
    coalesce(nullif(btrim(coalesce(p_timezone, '')), ''), v_workspace.timezone),
    case
      when p_default_currency ~ '^[A-Z]{3}$' then p_default_currency
      else v_workspace.default_currency
    end,
    v_prefix,
    true
  )
  returning id into v_id;

  -- Deliberately absent: any membership for the caller, and any integration,
  -- booking source or automation rule. A new artist starts with no way in and
  -- no way out. Everything else is an explicit, logged step - which is what
  -- makes the onboarding checklist honest rather than decorative.
  perform crm_private.log_lifecycle_event(
    'artist.created', v_id,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'slug', v_slug,
      'workspace_type', v_workspace.workspace_type::text
    )
  );

  return v_id;
end;
$$;

comment on function public.create_artist(uuid, text, text, text, text, text) is
  'Add an artist to a workspace. Requires manage_workspace on that workspace. Creates identity only: no membership for the caller, no integration, no booking source, no automation. Every one of those is a separate explicit grant.';

revoke all on function public.create_artist(uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_artist(uuid, text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Seating the artist on their own book
--
-- The deadlock this exists to break, because it is not obvious and it stops
-- the whole operatorless path dead.
--
-- public.grant_workspace_artist_membership refuses to hand out finance or
-- integration management unless the caller already holds that right on that
-- exact artist. That rule is correct and load-bearing: it is what stops a
-- studio administrator from staffing their way into an artist's money.
--
-- But apply it to an artist created one second ago and nobody can ever hold
-- those rights. The administrator does not have them - create_artist
-- deliberately granted them nothing - so they cannot pass them on. The artist
-- themself has no membership yet, so they cannot grant their own. The result
-- is a new artist who can never be given full access to their own book by
-- anyone except the legacy installation owner, which is exactly the operator
-- dependency this workstream exists to remove.
--
-- So there is one bootstrap, shaped like crm_private.no_active_owner in
-- migration 0006: a door that is open exactly once and then shuts forever.
--
-- The condition is "this artist has never had a membership row" - not "has no
-- active one". The difference matters and is the whole security argument:
--
--   * An artist with no membership row in its history has never been reachable
--     by any CRM user, and therefore holds no client, no enquiry, no project
--     and no payment. Seating somebody on it discloses nothing, because there
--     is nothing there.
--
--   * An artist whose membership was deactivated - somebody leaving a studio -
--     has a history, and very probably has records. Checking `is_active` would
--     reopen this door for them, letting an administrator seat themselves with
--     finance access on a departed artist's real book. That is the precise
--     scenario the platform must refuse, so the door stays shut on any artist
--     that has ever had a member.
--
-- One row, full rights, on an empty artist, logged. Then never again.
-- ---------------------------------------------------------------------------

-- Argument order matches public.grant_workspace_artist_membership next door:
-- who, then which artist.
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
  'Give an artist full access to their own book, once. Requires manage_workspace, and refuses the moment the artist has any membership row at all - so it can only ever run on an artist that has never been reachable, and therefore holds no records to disclose. Every later change goes through public.grant_workspace_artist_membership.';

revoke all on function public.seat_artist_owner(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.seat_artist_owner(uuid, uuid) to authenticated;

create or replace function public.update_artist(
  p_artist_id        uuid,
  p_display_name     text default null,
  p_timezone         text default null,
  p_default_currency text default null,
  p_is_active        boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_before public.artists%rowtype;
begin
  if p_artist_id is null then
    raise exception 'an artist is required' using errcode = '22023';
  end if;

  select * into v_before from public.artists a where a.id = p_artist_id;
  if v_before.id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  -- Artist identity and lifecycle are organization-level decisions. An
  -- artist-scoped `manage` right runs the artist's work; it does not rename or
  -- retire the artist.
  if not crm_private.can_administer_workspace(v_before.workspace_id) then
    raise exception 'administering this artist is not permitted' using errcode = '42501';
  end if;

  if p_display_name is not null and btrim(p_display_name) = '' then
    raise exception 'a display name is required' using errcode = '22023';
  end if;
  if p_default_currency is not null and p_default_currency !~ '^[A-Z]{3}$' then
    raise exception 'that is not a three letter currency code' using errcode = '22023';
  end if;

  update public.artists a
  set display_name     = coalesce(nullif(btrim(p_display_name), ''), a.display_name),
      timezone         = coalesce(nullif(btrim(p_timezone), ''), a.timezone),
      default_currency = coalesce(p_default_currency, a.default_currency),
      is_active        = coalesce(p_is_active, a.is_active),
      updated_at       = now()
  where a.id = p_artist_id;

  -- Deliberately no cascade over booking sources. The obvious worry is that
  -- deactivating an artist leaves a live public form still taking enquiries,
  -- and it would be easy to write an UPDATE here that switches them all off.
  -- It would also be wrong twice over.
  --
  -- It is unnecessary: both public resolvers in migration 0079 already join
  -- crm_private.artist_state and require the artist to be active, so the
  -- public door shuts the moment the artists row does - through the mirror the
  -- trigger maintains, in this same transaction, with no second write to get
  -- out of step. Test 235 pins that rather than trusting this comment.
  --
  -- And it is not this caller's write to make: public.booking_sources is
  -- artist-scoped, its UPDATE policy names can_manage_artist_booking_sources,
  -- and a workspace administrator does not hold that. Making the cascade work
  -- would mean widening an artist-scoped policy to a workspace role, which is
  -- the exact inheritance this platform refuses.
  --
  -- Reactivation is symmetric: sources return to whatever state their owner
  -- left them in. An artist coming back does not silently republish a form
  -- somebody had switched off.

  perform crm_private.log_lifecycle_event(
    case
      when p_is_active is false and v_before.is_active then 'artist.deactivated'
      when p_is_active is true and not v_before.is_active then 'artist.reactivated'
      else 'artist.updated'
    end,
    p_artist_id,
    jsonb_build_object(
      'workspace_id', v_before.workspace_id,
      'is_active', coalesce(p_is_active, v_before.is_active)
    )
  );

  return true;
end;
$$;

comment on function public.update_artist(uuid, text, text, text, boolean) is
  'Change artist identity, or deactivate/reactivate the artist. Requires manage_workspace on the artist''s workspace. Deactivation writes nothing to public.booking_sources: the public resolvers in 0079 join crm_private.artist_state, so intake refuses for an inactive artist while each source row keeps whatever state its owner set. Reactivation therefore restores exactly that state rather than republishing a form somebody had switched off.';

revoke all on function public.update_artist(uuid, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_artist(uuid, text, text, text, boolean)
  to authenticated;
