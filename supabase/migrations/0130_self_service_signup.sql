-- 0130_self_service_signup.sql
--
-- Self-service artist signup: one atomic door from a verified Supabase Auth
-- account to a complete, isolated solo tenant.
--
-- What this closes
-- ----------------
-- Migration 0087 made adding an artist a CRM operation, but it kept founding
-- deliberately gated: crm_private.can_found_workspace() admits the
-- installation owner or somebody who already administers an organization,
-- "because there is no self-signup in this CRM - people arrive by invitation".
-- That sentence is what this migration changes, and it changes it in one
-- direction only.
--
-- What it does NOT do
-- -------------------
-- can_found_workspace() is not widened. Handing every authenticated session
-- the right to found organizations would turn a signed-in stranger into an
-- unbounded write surface, and pgTAP 235 pins that refusal. Self-service
-- instead gets its own door: a single SECURITY DEFINER function that writes
-- exactly one profile, one solo workspace, one artist and one membership, all
-- for the caller and never naming anything that already exists.
--
-- It grants nothing at installation level. The profile is created
-- `booking_manager`, never `owner`, so the legacy global role stays where it
-- is and the new account administers only the organization it just founded.
--
-- It does not replace the invitation flow. An account that already has a
-- profile is refused here and keeps arriving the way it always did; the two
-- flows answer different questions and neither is a way around the other.
--
-- Fail-closed by construction
-- ---------------------------
-- Applying this migration changes no behaviour at all. The door starts shut:
-- crm_private.self_service_settings.is_open defaults to false, and opening it
-- is an explicit, audited act by the installation owner. A verified email is
-- required, one tenant per account is a primary key rather than a check, and
-- a rolling-window cap bounds how fast tenants can appear.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. The switch, and the numbers abuse control reads
--
-- One row, enforced by a primary key on a constant. Config that can grow a
-- second row grows a second answer, and then something has to choose.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.self_service_settings (
  id                      boolean primary key default true,
  is_open                 boolean not null default false,
  max_signups_per_hour    integer not null default 20,
  max_workspaces_per_founder integer not null default 3,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references public.profiles (id) on delete set null,
  constraint self_service_settings_singleton check (id),
  constraint self_service_settings_rate_sane
    check (max_signups_per_hour between 0 and 1000),
  constraint self_service_settings_founder_cap_sane
    check (max_workspaces_per_founder between 1 and 50)
);

comment on table crm_private.self_service_settings is
  'Whether public signup is open, and the two numbers that bound it. Lives in crm_private because a browser has no business reading or writing it; public.self_service_signup_policy() discloses the single boolean a signed-out login screen needs.';

insert into crm_private.self_service_settings (id) values (true)
on conflict (id) do nothing;

revoke all on crm_private.self_service_settings
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The ledger
--
-- One row per self-created tenant, keyed on the profile. The primary key is
-- the idempotency guarantee: a second successful bootstrap for the same
-- account is not prevented by an `if` a race could slip past, it is impossible.
--
-- It is also the only place the platform records that an account arrived
-- without an invitation, which is what lets the workspace cap in section 3
-- apply to self-service founders and to nobody else.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.self_service_accounts (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  artist_id    uuid not null references public.artists (id) on delete restrict,
  created_at   timestamptz not null default now()
);

create index if not exists self_service_accounts_created_idx
  on crm_private.self_service_accounts (created_at desc);

comment on table crm_private.self_service_accounts is
  'One row per tenant created by public.bootstrap_artist_account. The primary key makes a second tenant for the same account impossible rather than merely refused.';

revoke all on crm_private.self_service_accounts
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Bounding what a self-service founder may found
--
-- A self-service account owns its solo workspace, and 0075's
-- sync_solo_workspace_owner gives it can_manage_workspace there - which is
-- correct, and which also makes crm_private.can_found_workspace() true for it.
-- That is the same position an invited artist has been in since 0075, so it is
-- not new authority. It is, however, newly reachable by anybody who can create
-- an account, and an unbounded "found another organization" button is a
-- resource-exhaustion surface.
--
-- So the cap applies to self-service founders only, leaving the installation
-- owner and every invited administrator exactly where they were. Putting it
-- inside can_found_workspace() rather than inside create_workspace() keeps one
-- answer: the RPC, the workspaces INSERT policy and the interface's
-- control_plane_access() all read the same predicate, so the button disappears
-- at the same moment the database starts refusing.
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
        join crm_private.workspace_state ws on ws.workspace_id = wa.workspace_id
        where wa.profile_id = auth.uid()
          and wa.is_active
          and ws.is_active
          and wa.can_manage_workspace
      ) >= c.max_workspaces_per_founder
  );
$$;

comment on function crm_private.within_self_service_workspace_cap() is
  'True unless the caller is a self-service account that already administers its allowance of organizations. Invited accounts and the installation owner are never in the ledger, so this is true for them by construction.';

revoke all on function crm_private.within_self_service_workspace_cap()
  from public, anon, authenticated, service_role;

-- Re-created from 0087 with the cap added and nothing else changed. The
-- refusal pgTAP 235 pins - a profile that administers no workspace may not
-- found one - is the first conjunct and is untouched.
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
     )
     and crm_private.within_self_service_workspace_cap();
$$;

revoke all on function crm_private.can_found_workspace()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. What a signed-out browser may know
--
-- Exactly one boolean: whether to offer a "Create an account" link. It
-- discloses no count, no address and no identity, and it is a courtesy - the
-- bootstrap re-reads the same switch and refuses on its own authority.
-- ---------------------------------------------------------------------------

create or replace function public.self_service_signup_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'is_open', (select c.is_open from crm_private.self_service_settings c where c.id)
  );
$$;

comment on function public.self_service_signup_policy() is
  'Whether public artist signup is currently open. One boolean, readable before sign-in so the login screen can offer or withhold the link. Hiding the link is a courtesy; public.bootstrap_artist_account re-reads the switch and is the authority.';

revoke all on function public.self_service_signup_policy()
  from public, anon, authenticated, service_role;
grant execute on function public.self_service_signup_policy() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Opening and closing the door
--
-- Installation-owner only, and audited. Closing it stops new tenants from
-- appearing; it does not touch the ones that exist, and section 6 deliberately
-- answers a repeated call for an account that already has its tenant before it
-- consults the switch, so closing signup can never strand somebody mid-flow.
-- ---------------------------------------------------------------------------

create or replace function public.set_self_service_signup(
  p_is_open                    boolean,
  p_max_signups_per_hour       integer default null,
  p_max_workspaces_per_founder integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row crm_private.self_service_settings%rowtype;
begin
  if not public.is_owner() then
    raise exception 'changing signup availability is not permitted' using errcode = '42501';
  end if;
  if p_is_open is null then
    raise exception 'an explicit open or closed state is required' using errcode = '22023';
  end if;

  update crm_private.self_service_settings c
  set is_open = p_is_open,
      max_signups_per_hour = coalesce(p_max_signups_per_hour, c.max_signups_per_hour),
      max_workspaces_per_founder = coalesce(p_max_workspaces_per_founder, c.max_workspaces_per_founder),
      updated_at = now(),
      updated_by = auth.uid()
  where c.id
  returning * into v_row;

  perform crm_private.log_lifecycle_event(
    'signup.availability_changed', null,
    jsonb_build_object(
      'is_open', v_row.is_open,
      'max_signups_per_hour', v_row.max_signups_per_hour,
      'max_workspaces_per_founder', v_row.max_workspaces_per_founder
    )
  );

  return jsonb_build_object(
    'is_open', v_row.is_open,
    'max_signups_per_hour', v_row.max_signups_per_hour,
    'max_workspaces_per_founder', v_row.max_workspaces_per_founder
  );
end;
$$;

comment on function public.set_self_service_signup(boolean, integer, integer) is
  'Open or close public artist signup, and adjust its two limits. Installation owner only, audited. Closing it prevents new tenants; existing self-service tenants are untouched.';

revoke all on function public.set_self_service_signup(boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_self_service_signup(boolean, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The bootstrap
--
-- One function, one transaction, one tenant. Everything a new artist needs to
-- open the CRM, and nothing that reaches anything which already exists.
--
-- The argument list is worth reading for what is absent: no workspace id, no
-- artist id, no profile id, no role, no membership shape. There is no
-- identifier a caller could substitute, so there is no version of this call
-- that attaches the caller to somebody else's organization or artist. The only
-- identity it uses is auth.uid(), which the caller does not choose.
--
-- Order of the guards is deliberate:
--
--   1. an authenticated session, not a service-role or anon call;
--   2. a *verified* email - an unconfirmed address is somebody else's address
--      until proven otherwise, so nothing is created for it;
--   3. the per-account lock, so a double-submit serialises rather than racing;
--   4. the ledger, answered BEFORE the switch, so a retry after success works
--      even if signup has since been closed;
--   5. an existing profile refuses - that account arrived by invitation and
--      this path is not a second way in;
--   6. only then the switch and the rolling-window cap.
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_artist_account(
  p_display_name     text,
  p_business_name    text default null,
  p_timezone         text default null,
  p_default_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_uid           uuid := auth.uid();
  v_email         text;
  v_confirmed     timestamptz;
  v_banned        timestamptz;
  v_deleted       timestamptz;
  v_settings      crm_private.self_service_settings%rowtype;
  v_existing      crm_private.self_service_accounts%rowtype;
  v_name          text;
  v_business      text;
  v_timezone      text;
  v_currency      text;
  v_slug          text;
  v_prefix        text;
  v_suffix        integer := 1;
  v_recent        integer;
  v_workspace_id  uuid;
  v_artist_id     uuid;
begin
  -- 1. An ordinary signed-in browser session, and only that. A service-role
  -- caller has no auth.uid() to act for, and letting one through here would
  -- turn a backend key into a way to mint tenants for arbitrary accounts.
  if v_uid is null or crm_private.jwt_role() <> 'authenticated' then
    raise exception 'sign in before setting up your CRM' using errcode = '42501';
  end if;

  select u.email::text, u.email_confirmed_at, u.banned_until, u.deleted_at
    into v_email, v_confirmed, v_banned, v_deleted
  from auth.users u
  where u.id = v_uid;

  if v_email is null then
    raise exception 'this account is unavailable' using errcode = '22023';
  end if;
  if v_deleted is not null or (v_banned is not null and v_banned > now()) then
    raise exception 'this account is unavailable' using errcode = '42501';
  end if;

  -- 2. Verification is the whole basis for trusting the address, and the
  -- address is what the CRM will send a client-facing artist's mail to.
  if v_confirmed is null then
    raise exception 'confirm your email address before setting up your CRM'
      using errcode = '42501';
  end if;

  -- 3. Two taps on Continue are one tenant, not two.
  perform pg_advisory_xact_lock(hashtextextended('crm:self-service:' || v_uid::text, 0));

  -- 4. Already done. Answered before the switch on purpose: closing signup
  -- must stop new tenants without breaking a retry for somebody who already
  -- has one.
  select * into v_existing
  from crm_private.self_service_accounts s
  where s.profile_id = v_uid;

  if v_existing.profile_id is not null then
    return jsonb_build_object(
      'profile_id', v_existing.profile_id,
      'workspace_id', v_existing.workspace_id,
      'artist_id', v_existing.artist_id,
      'created', false
    );
  end if;

  -- 5. A profile this function did not create belongs to the invitation flow.
  -- Refusing keeps the two paths distinct: an invited account never gets a
  -- second, self-founded tenant out of the same identity, and self-service is
  -- never a way to skip an invitation.
  if exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'this account already has CRM access'
      using errcode = '23505',
            hint = 'Sign in, or ask whoever invited you if you cannot see your work.';
  end if;

  -- 6. The switch and the rolling window. Serialised globally so the count
  -- cannot be read by two callers at once, which also removes the realistic
  -- slug race below.
  perform pg_advisory_xact_lock(hashtextextended('crm:self-service-admission', 0));

  select * into v_settings from crm_private.self_service_settings c where c.id;
  if not coalesce(v_settings.is_open, false) then
    raise exception 'signing up is not open at the moment' using errcode = '42501';
  end if;

  select count(*) into v_recent
  from crm_private.self_service_accounts s
  where s.created_at > now() - interval '1 hour';

  if v_recent >= v_settings.max_signups_per_hour then
    raise exception 'too many accounts have been created recently; try again shortly'
      using errcode = '53400';
  end if;

  -- Input, validated here rather than trusted from the browser.
  v_name := btrim(coalesce(p_display_name, ''));
  if v_name = '' then
    raise exception 'a name is required' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'that name is too long' using errcode = '22023';
  end if;

  v_business := nullif(btrim(coalesce(p_business_name, '')), '');
  if v_business is not null and char_length(v_business) > 120 then
    raise exception 'that studio name is too long' using errcode = '22023';
  end if;

  v_timezone := nullif(btrim(coalesce(p_timezone, '')), '');
  if v_timezone is null
     or not exists (
       select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone
     ) then
    v_timezone := 'Europe/London';
  end if;

  v_currency := case
    when p_default_currency ~ '^[A-Z]{3}$' then p_default_currency
    else 'GBP'
  end;

  -- The CRM identity. `booking_manager`, never `owner`: the legacy
  -- installation-wide role is not something a public form may hand out, and a
  -- read_only profile could not use the artist seat it is about to be given.
  --
  -- The unique index on profiles.email is the one collision a person can
  -- actually cause: the same address already belongs to another CRM identity.
  -- Caught here rather than around the whole function, so it cannot swallow a
  -- refusal raised deliberately above with the same SQLSTATE.
  begin
    insert into public.profiles (id, email, display_name, role, is_active)
    values (v_uid, v_email, v_name, 'booking_manager', true);
  exception when unique_violation then
    raise exception 'that email address is already registered'
      using errcode = '23505',
            hint = 'Sign in with it, or ask whoever invited you.';
  end;

  -- The organization. Solo, always: this is one artist founding their own
  -- book, and 0087's create_artist refuses a second artist on a solo workspace,
  -- which is what keeps 0075's sync_solo_workspace_owner trigger safe.
  v_slug := coalesce(
    crm_private.slugify(coalesce(v_business, v_name)),
    'workspace-' || replace(gen_random_uuid()::text, '-', '')
  );
  while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := left(v_slug, 60) || '-' || v_suffix::text;
  end loop;

  insert into public.workspaces (
    slug, display_name, workspace_type, timezone, default_currency, is_active
  ) values (
    v_slug, coalesce(v_business, v_name), 'solo', v_timezone, v_currency, true
  )
  returning id into v_workspace_id;

  insert into public.workspace_memberships (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  ) values (
    v_uid, v_workspace_id, 'owner', true, true, true, true
  )
  on conflict (profile_id, workspace_id) do nothing;

  -- The artist. workspace_id is supplied, so 0075's provision_artist_workspace
  -- trigger is a no-op and this artist joins the organization just founded
  -- rather than founding a second one.
  v_slug := coalesce(
    crm_private.slugify(v_name),
    'artist-' || replace(gen_random_uuid()::text, '-', '')
  );
  v_suffix := 1;
  while exists (select 1 from public.artists a where a.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := left(v_slug, 60) || '-' || v_suffix::text;
  end loop;

  v_prefix := upper(left(regexp_replace(v_slug, '[^a-z0-9]', '', 'g'), 3));
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

  insert into public.artists (
    workspace_id, slug, display_name, timezone, default_currency,
    booking_reference_prefix, is_active
  ) values (
    v_workspace_id, v_slug, v_name, v_timezone, v_currency, v_prefix, true
  )
  returning id into v_artist_id;

  -- The seat. Same shape public.seat_artist_owner writes, for the same reason:
  -- an artist nobody holds a membership on has no way in. `artist` rather than
  -- `owner` matches how a working artist is seated elsewhere in this platform
  -- and reaches exactly one artist either way.
  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  ) values (
    v_uid, v_artist_id, 'artist', true, true, true, true, true, 'explicit'
  );

  insert into crm_private.self_service_accounts (profile_id, workspace_id, artist_id)
  values (v_uid, v_workspace_id, v_artist_id);

  perform crm_private.log_lifecycle_event(
    'signup.tenant_created', v_artist_id,
    jsonb_build_object(
      'workspace_id', v_workspace_id,
      'workspace_type', 'solo',
      'source', 'self_service'
    )
  );

  return jsonb_build_object(
    'profile_id', v_uid,
    'workspace_id', v_workspace_id,
    'artist_id', v_artist_id,
    'created', true
  );
end;
$$;

comment on function public.bootstrap_artist_account(text, text, text, text) is
  'Turn a verified Supabase Auth account into a complete isolated solo tenant: profile, solo workspace, artist, workspace ownership and the artist seat, in one transaction. Idempotent - a second call returns the first result. Takes no identifier of any kind, so it cannot attach the caller to an existing organization or artist, and it never creates an installation owner.';

revoke all on function public.bootstrap_artist_account(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.bootstrap_artist_account(text, text, text, text) to authenticated;
