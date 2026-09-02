-- Self-service tenants are private from the installation operator.
--
-- Production acceptance of the signup flow surfaced this: the moment
-- `bootstrap_artist_account` created the new artist, 0015's
-- `grant_artist_to_active_owners` gave every active `owner` profile an
-- `owner` membership on it, and 0075's `sync_solo_workspace_owner` turned
-- that into ownership of the new solo workspace. A stranger who signs up
-- through `crm.vishartattoo.com` therefore handed the installation owner
-- read and write access to their clients, enquiries, projects and payments,
-- and exposed the owner's profile id back to them in the membership row.
--
-- That rule is right for this installation's own artists - Vladimir founded
-- them and staffs them - and wrong for a tenant that belongs to somebody
-- else's business. So the rule is scoped rather than removed: nothing changes
-- for any artist created by an operator, an invitation, or a migration; only
-- workspaces founded through self-service signup are excluded.
--
-- Forward-only and additive. The new table starts empty apart from the
-- backfill below, so on an installation with no self-service tenants every
-- trigger behaves exactly as it did before.

create table if not exists crm_private.self_service_workspaces (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  created_at   timestamptz not null default now()
);

revoke all on crm_private.self_service_workspaces from public;

comment on table crm_private.self_service_workspaces is
  'Workspaces founded through public signup. Marked before the artist exists, '
  'because the owner-grant triggers fire on the artist insert and the '
  'self_service_accounts ledger cannot be written until the artist has an id.';

-- Any tenant already in the ledger is self-service by definition.
insert into crm_private.self_service_workspaces (workspace_id)
select a.workspace_id from crm_private.self_service_accounts a
on conflict (workspace_id) do nothing;

-- ---------------------------------------------------------------------------
-- The two owner-grant paths
-- ---------------------------------------------------------------------------

create or replace function crm_private.grant_artist_to_active_owners()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1 from crm_private.self_service_workspaces s
    where s.workspace_id = new.workspace_id
  ) then
    return new;
  end if;

  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  )
  select p.profile_id, new.id, 'owner', true, true, true, true, true, 'owner_sync'
  from crm_private.profile_access p
  where p.is_active and p.role = 'owner'
  on conflict (profile_id, artist_id) do update
    set access_level = 'owner',
        can_view_finance = true,
        can_manage_finance = true,
        can_manage_sessions = true,
        can_manage_integrations = true,
        is_active = true;

  return new;
end;
$$;

-- The same exclusion on the profile side. Without it, the next time an owner
-- profile is touched the sweep would grant back every membership this
-- migration removes.
create or replace function crm_private.ensure_owner_artist_memberships(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from crm_private.profile_access p
    where p.profile_id = p_profile_id
      and p.is_active
      and p.role = 'owner'
  ) then
    insert into public.artist_memberships (
      profile_id, artist_id, access_level,
      can_view_finance, can_manage_finance,
      can_manage_sessions, can_manage_integrations, is_active, grant_source
    )
    select p_profile_id, s.artist_id, 'owner', true, true, true, true, true, 'owner_sync'
    from crm_private.artist_state s
    where not exists (
      select 1
      from public.artists a
      join crm_private.self_service_workspaces w on w.workspace_id = a.workspace_id
      where a.id = s.artist_id
    )
    on conflict (profile_id, artist_id) do update
      set access_level = 'owner',
          can_view_finance = true,
          can_manage_finance = true,
          can_manage_sessions = true,
          can_manage_integrations = true,
          is_active = true;
  else
    update public.artist_memberships m
    set is_active = false
    where m.profile_id = p_profile_id
      and m.access_level = 'owner'
      and m.is_active;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Repair what the old rule already granted
-- ---------------------------------------------------------------------------

update public.artist_memberships m
   set is_active = false
  from public.artists a
       join crm_private.self_service_workspaces s on s.workspace_id = a.workspace_id
 where m.artist_id = a.id
   and m.grant_source = 'owner_sync'
   and m.is_active;

-- The founder's own seat is keyed by the ledger, so everyone else on a
-- self-service workspace was put there by the owner sweep.
delete from public.workspace_memberships wm
 using crm_private.self_service_workspaces s
       join crm_private.self_service_accounts acc on acc.workspace_id = s.workspace_id
 where wm.workspace_id = s.workspace_id
   and wm.profile_id <> acc.profile_id;

-- ---------------------------------------------------------------------------
-- Mark the workspace during bootstrap, before the artist exists
-- ---------------------------------------------------------------------------

create or replace function crm_private.mark_self_service_workspace(p_workspace_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  insert into crm_private.self_service_workspaces (workspace_id)
  values (p_workspace_id)
  on conflict (workspace_id) do nothing;
$$;

revoke all on function crm_private.mark_self_service_workspace(uuid) from public;

-- The bootstrap itself, re-created so the workspace is marked the moment it is
-- founded. Identical to 0130 apart from that one call.

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

  -- Before the artist exists, so the owner-grant triggers that fire on the
  -- artist insert can already see that this tenant is somebody else's.
  perform crm_private.mark_self_service_workspace(v_workspace_id);

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

-- `create or replace` keeps the existing ACL, but state it anyway so the
-- callable surface is readable in one place.
revoke all on function public.bootstrap_artist_account(text, text, text, text) from public;
revoke all on function public.bootstrap_artist_account(text, text, text, text) from anon;
grant execute on function public.bootstrap_artist_account(text, text, text, text) to authenticated;
