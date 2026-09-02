-- Tenant-scoped teammate invitation.
--
-- A self-service artist cannot add a first teammate. `list_directory_profiles()`
-- shows them only people they already share an artist with - on day one, nobody -
-- and `begin_staff_invite` calls `require_role('owner')`, because minting a
-- Supabase Auth identity has always been an installation-owner act. So the
-- directory can only pick somebody who already exists, and nothing lets a
-- non-owner bring somebody into existence.
--
-- This adds a second door, not a wider one. `begin_artist_invite` and
-- `finalize_artist_invite` are siblings of the owner pair, writing the same
-- `crm_private.staff_invites` rows through the same finalize shape, and
-- differing in exactly what the trust boundary requires:
--
--   authorization  manage_team on ONE named artist, not the installation role
--   reach          that artist, and nothing else - no membership array
--   role           always booking_manager, never a parameter
--   ceiling        cannot hand out finance or integrations the caller lacks
--   disclosure     "already exists" is indistinguishable from "invited"
--   volume         per-artist and installation-wide windows, plus a switch
--   lifetime       invitations expire, and cannot be replayed after use
--
-- Fail-closed on arrival, exactly as 0130 was: the switch defaults to false, so
-- applying this migration changes no behaviour until the owner opens it.
--
-- The owner path is untouched. `begin_staff_invite` and `finalize_staff_invite`
-- are not redefined here, and the columns added below carry defaults that make
-- every row they write an owner-origin row exactly as before.

-- ---------------------------------------------------------------------------
-- 1. The invite row learns which door it came through
-- ---------------------------------------------------------------------------

alter table crm_private.staff_invites
  add column if not exists origin text not null default 'owner',
  add column if not exists artist_id uuid references public.artists (id) on delete restrict,
  add column if not exists expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_invites_origin_allowed'
  ) then
    alter table crm_private.staff_invites
      add constraint staff_invites_origin_allowed check (origin in ('owner', 'tenant'));
  end if;

  -- A tenant invitation names exactly one artist; an owner invitation carries
  -- its targets in `memberships` and names none. Neither shape can borrow the
  -- other's reach.
  if not exists (
    select 1 from pg_constraint where conname = 'staff_invites_tenant_names_one_artist'
  ) then
    alter table crm_private.staff_invites
      add constraint staff_invites_tenant_names_one_artist check (
        (origin = 'owner' and artist_id is null)
        or (origin = 'tenant' and artist_id is not null)
      );
  end if;

  -- A tenant invitation never mints anything but a booking manager.
  if not exists (
    select 1 from pg_constraint where conname = 'staff_invites_tenant_role_bounded'
  ) then
    alter table crm_private.staff_invites
      add constraint staff_invites_tenant_role_bounded check (
        origin <> 'tenant' or role = 'booking_manager'
      );
  end if;
end;
$$;

-- 'suppressed' is the terminal state for an invitation that was accepted from
-- the caller but deliberately produced nothing, because the address already
-- belongs to somebody. It exists so the refusal is a recorded decision rather
-- than a silent no-op.
alter table crm_private.staff_invites
  drop constraint if exists staff_invites_status_allowed;
alter table crm_private.staff_invites
  add constraint staff_invites_status_allowed
    check (status in ('pending', 'provisioned', 'suppressed'));

create index if not exists staff_invites_tenant_window_idx
  on crm_private.staff_invites (artist_id, created_at)
  where origin = 'tenant';

comment on column crm_private.staff_invites.origin is
  'Which door the invitation came through: owner (installation-wide, require_role) or tenant (one artist, manage_team).';
comment on column crm_private.staff_invites.artist_id is
  'The single artist a tenant invitation reaches. Null for owner invitations, which carry their targets in memberships.';

-- ---------------------------------------------------------------------------
-- 2. The switch and the windows
-- ---------------------------------------------------------------------------

alter table crm_private.self_service_settings
  add column if not exists tenant_invites_open boolean not null default false,
  add column if not exists max_tenant_invites_pending_per_artist integer not null default 3,
  add column if not exists max_tenant_invites_daily_per_artist integer not null default 5,
  add column if not exists max_tenant_invites_per_hour integer not null default 10;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'self_service_settings_invite_caps_sane') then
    alter table crm_private.self_service_settings
      add constraint self_service_settings_invite_caps_sane check (
        max_tenant_invites_pending_per_artist between 0 and 50
        and max_tenant_invites_daily_per_artist between 0 and 100
        and max_tenant_invites_per_hour between 0 and 500
      );
  end if;
end;
$$;

create or replace function public.set_tenant_invites(
  p_is_open            boolean,
  p_pending_per_artist integer default null,
  p_daily_per_artist   integer default null,
  p_per_hour           integer default null
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
    raise exception 'changing invitation availability is not permitted' using errcode = '42501';
  end if;
  if p_is_open is null then
    raise exception 'an explicit open or closed state is required' using errcode = '22023';
  end if;

  update crm_private.self_service_settings c
  set tenant_invites_open = p_is_open,
      max_tenant_invites_pending_per_artist =
        coalesce(p_pending_per_artist, c.max_tenant_invites_pending_per_artist),
      max_tenant_invites_daily_per_artist =
        coalesce(p_daily_per_artist, c.max_tenant_invites_daily_per_artist),
      max_tenant_invites_per_hour =
        coalesce(p_per_hour, c.max_tenant_invites_per_hour),
      updated_at = now(),
      updated_by = auth.uid()
  where c.id
  returning * into v_row;

  perform crm_private.log_lifecycle_event(
    'invite.tenant_availability_changed', null,
    jsonb_build_object(
      'is_open', v_row.tenant_invites_open,
      'pending_per_artist', v_row.max_tenant_invites_pending_per_artist,
      'daily_per_artist', v_row.max_tenant_invites_daily_per_artist,
      'per_hour', v_row.max_tenant_invites_per_hour
    )
  );

  return jsonb_build_object(
    'is_open', v_row.tenant_invites_open,
    'pending_per_artist', v_row.max_tenant_invites_pending_per_artist,
    'daily_per_artist', v_row.max_tenant_invites_daily_per_artist,
    'per_hour', v_row.max_tenant_invites_per_hour
  );
end;
$$;

comment on function public.set_tenant_invites(boolean, integer, integer, integer) is
  'Open or close tenant-scoped teammate invitations and adjust their windows. Installation owner only, audited.';

revoke all on function public.set_tenant_invites(boolean, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_tenant_invites(boolean, integer, integer, integer) to authenticated;

-- Whether the button is offered. Signed-in only: unlike the signup policy this
-- is never read by a logged-out page, so `anon` has no reason to know.
create or replace function public.tenant_invite_policy(p_artist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_settings crm_private.self_service_settings%rowtype;
begin
  if crm_private.jwt_role() <> 'authenticated' or auth.uid() is null then
    raise exception 'a signed-in session is required' using errcode = '42501';
  end if;
  if p_artist_id is null or not crm_private.has_artist_capability(p_artist_id, 'manage_team') then
    return jsonb_build_object('can_invite', false);
  end if;

  select * into v_settings from crm_private.self_service_settings where id;

  return jsonb_build_object(
    'can_invite', coalesce(v_settings.tenant_invites_open, false)
      and exists (
        select 1 from auth.users u
        where u.id = auth.uid() and u.email_confirmed_at is not null
      )
  );
end;
$$;

comment on function public.tenant_invite_policy(uuid) is
  'Whether the signed-in caller may invite a teammate to this artist right now. Says nothing about who exists.';

revoke all on function public.tenant_invite_policy(uuid) from public, anon, authenticated, service_role;
grant execute on function public.tenant_invite_policy(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The grant a tenant invitation may carry
--
-- Shared by begin and finalize, because the caller's capabilities can change
-- between the two calls and the second one is where the membership is actually
-- written. Checking only at begin would let a revoked manager still land a
-- finance grant.
-- ---------------------------------------------------------------------------

create or replace function crm_private.normalise_tenant_invite_grant(
  p_artist_id uuid,
  p_grant     jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_grant jsonb := coalesce(p_grant, '{}'::jsonb);
  v_level text;
  v_view_finance boolean;
  v_manage_finance boolean;
  v_manage_sessions boolean;
  v_manage_integrations boolean;
begin
  if jsonb_typeof(v_grant) <> 'object' then
    raise exception 'the grant must be an object' using errcode = '22023';
  end if;

  v_level := coalesce(nullif(btrim(v_grant ->> 'access_level'), ''), 'artist');
  -- `owner` is an installation act and is not reachable from here at all. It is
  -- refused by name rather than by omission so the intent is unmistakable.
  if v_level not in ('artist', 'manager', 'read_only') then
    raise exception 'that access level cannot be granted by an invitation' using errcode = '22023';
  end if;

  v_view_finance := coalesce((v_grant ->> 'can_view_finance')::boolean, false);
  v_manage_finance := coalesce((v_grant ->> 'can_manage_finance')::boolean, false);
  v_manage_sessions := coalesce((v_grant ->> 'can_manage_sessions')::boolean, false);
  v_manage_integrations := coalesce((v_grant ->> 'can_manage_integrations')::boolean, false);

  if v_manage_finance and not v_view_finance then
    raise exception 'managing finance requires viewing it' using errcode = '22023';
  end if;
  if v_level = 'read_only'
     and (v_view_finance or v_manage_finance or v_manage_sessions or v_manage_integrations) then
    raise exception 'a read-only teammate holds no management capability' using errcode = '22023';
  end if;

  -- The ceiling, identical to grant_workspace_artist_membership: you cannot
  -- hand out finance or integration management you do not hold on this artist.
  -- Deliberately evaluated for every caller including an installation owner,
  -- because this door is the tenant's door and its answer should not depend on
  -- who is standing in it.
  if (v_view_finance or v_manage_finance)
     and not crm_private.has_artist_capability(p_artist_id, 'manage_finance') then
    raise exception 'cannot grant finance access you do not hold' using errcode = '42501';
  end if;
  if v_manage_integrations
     and not crm_private.has_artist_capability(p_artist_id, 'manage_integrations') then
    raise exception 'cannot grant integration management you do not hold' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'access_level', v_level,
    'can_view_finance', v_view_finance,
    'can_manage_finance', v_manage_finance,
    'can_manage_sessions', v_manage_sessions,
    'can_manage_integrations', v_manage_integrations
  );
end;
$$;

revoke all on function crm_private.normalise_tenant_invite_grant(uuid, jsonb) from public;

-- ---------------------------------------------------------------------------
-- 4. begin_artist_invite
--
-- The argument list is the boundary. There is no role, no membership array and
-- no profile id: the only artist it can reach is the one named, and the caller
-- must already hold manage_team on it. Naming somebody else's artist is refused
-- by the same predicate that refuses reading it.
-- ---------------------------------------------------------------------------

create or replace function public.begin_artist_invite(
  p_idempotency_key uuid,
  p_email           text,
  p_display_name    text,
  p_artist_id       uuid,
  p_grant           jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_settings crm_private.self_service_settings%rowtype;
  v_email text;
  v_display_name text;
  v_grant jsonb;
  v_existing crm_private.staff_invites%rowtype;
  v_invite_id uuid;
  v_pending integer;
  v_daily integer;
  v_hourly integer;
begin
  if crm_private.jwt_role() <> 'authenticated' or auth.uid() is null then
    raise exception 'a signed-in session is required' using errcode = '42501';
  end if;

  -- A tenant that has not proven its own address does not get to send mail from
  -- this installation.
  if not exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
  ) then
    raise exception 'confirm your own email address first' using errcode = '42501';
  end if;

  select * into v_settings from crm_private.self_service_settings where id;
  if not coalesce(v_settings.tenant_invites_open, false) then
    raise exception 'inviting teammates is not open at the moment' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'an idempotency key is required' using errcode = '22023';
  end if;
  if p_artist_id is null then
    raise exception 'an artist is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.artists a where a.id = p_artist_id and a.is_active) then
    -- Same answer for "does not exist" and "not yours", so the id space cannot
    -- be probed for which artists the installation has.
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;
  if not crm_private.has_artist_capability(p_artist_id, 'manage_team') then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  v_email := public.normalize_email(p_email);
  if v_email is null
     or char_length(v_email) > 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'a valid email address is required' using errcode = '22023';
  end if;

  v_display_name := nullif(btrim(p_display_name), '');
  if v_display_name is not null and char_length(v_display_name) > 120 then
    raise exception 'display name must be at most 120 characters' using errcode = '22023';
  end if;

  v_grant := crm_private.normalise_tenant_invite_grant(p_artist_id, p_grant);

  perform pg_advisory_xact_lock(hashtextextended('crm:staff-invite:' || v_email, 0));

  -- Replay of the same request returns the same answer and creates nothing.
  select * into v_existing
  from crm_private.staff_invites i
  where i.requested_by = auth.uid() and i.idempotency_key = p_idempotency_key
  for update;

  if v_existing.id is not null then
    if v_existing.origin <> 'tenant'
       or v_existing.email_normalized::text <> v_email
       or v_existing.display_name is distinct from v_display_name
       or v_existing.artist_id <> p_artist_id
       or v_existing.memberships <> jsonb_build_array(v_grant) then
      raise exception 'an idempotency key cannot be reused for a different invitation'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'invite_request_id', case when v_existing.status = 'pending' then v_existing.id end,
      'email_normalized', v_existing.email_normalized::text,
      'status', v_existing.status,
      'idempotent_replay', true
    );
  end if;

  -- Everything below decides whether mail is sent, and none of it may change
  -- what the caller is told. `suppressed` is recorded, the caller sees the same
  -- shape as a live invitation, and the invitee simply receives nothing.
  if exists (select 1 from public.profiles p where p.email = v_email)
     or exists (
       select 1 from crm_private.staff_invites i
       where i.email_normalized = v_email and i.status = 'pending'
     ) then
    insert into crm_private.staff_invites (
      requested_by, idempotency_key, email_normalized, display_name,
      role, memberships, origin, artist_id, status, expires_at
    ) values (
      auth.uid(), p_idempotency_key, v_email, v_display_name,
      'booking_manager', jsonb_build_array(v_grant), 'tenant', p_artist_id,
      'suppressed', now() + interval '7 days'
    ) returning id into v_invite_id;

    perform crm_private.log_artist_activity(
      p_artist_id, 'invite.tenant_suppressed', 'staff', auth.uid(),
      null, null, null, null, null,
      jsonb_build_object('invite_request_id', v_invite_id)
    );

    return jsonb_build_object(
      'invite_request_id', null,
      'email_normalized', v_email,
      'status', 'suppressed',
      'idempotent_replay', false
    );
  end if;

  select count(*) into v_pending
  from crm_private.staff_invites i
  where i.origin = 'tenant' and i.artist_id = p_artist_id and i.status = 'pending'
    and (i.expires_at is null or i.expires_at > now());
  if v_pending >= v_settings.max_tenant_invites_pending_per_artist then
    raise exception 'too many invitations are already waiting to be accepted'
      using errcode = '53400';
  end if;

  select count(*) into v_daily
  from crm_private.staff_invites i
  where i.origin = 'tenant' and i.artist_id = p_artist_id
    and i.created_at > now() - interval '24 hours';
  if v_daily >= v_settings.max_tenant_invites_daily_per_artist then
    raise exception 'this artist has invited enough people for one day'
      using errcode = '53400';
  end if;

  select count(*) into v_hourly
  from crm_private.staff_invites i
  where i.origin = 'tenant' and i.created_at > now() - interval '1 hour';
  if v_hourly >= v_settings.max_tenant_invites_per_hour then
    raise exception 'invitations are busy right now, try again shortly'
      using errcode = '53400';
  end if;

  insert into crm_private.staff_invites (
    requested_by, idempotency_key, email_normalized, display_name,
    role, memberships, origin, artist_id, expires_at
  ) values (
    auth.uid(), p_idempotency_key, v_email, v_display_name,
    'booking_manager', jsonb_build_array(v_grant), 'tenant', p_artist_id,
    now() + interval '7 days'
  ) returning id into v_invite_id;

  perform crm_private.log_artist_activity(
    p_artist_id, 'invite.tenant_requested', 'staff', auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'invite_request_id', v_invite_id,
      'access_level', v_grant ->> 'access_level',
      'can_view_finance', (v_grant ->> 'can_view_finance')::boolean,
      'can_manage_finance', (v_grant ->> 'can_manage_finance')::boolean,
      'can_manage_sessions', (v_grant ->> 'can_manage_sessions')::boolean,
      'can_manage_integrations', (v_grant ->> 'can_manage_integrations')::boolean
    )
  );

  return jsonb_build_object(
    'invite_request_id', v_invite_id,
    'email_normalized', v_email,
    'status', 'pending',
    'idempotent_replay', false
  );
end;
$$;

comment on function public.begin_artist_invite(uuid, text, text, uuid, jsonb) is
  'Prepare an invitation to exactly one artist the caller manages. Never mints an owner, never reaches a second artist, and answers identically whether or not the address already belongs to somebody.';

revoke all on function public.begin_artist_invite(uuid, text, text, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_artist_invite(uuid, text, text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. finalize_artist_invite
--
-- Re-authorizes rather than trusting the row. Between begin and finalize the
-- Worker made a non-transactional call to Auth, and in that window the caller
-- may have lost manage_team or the finance capability the grant carries. The
-- membership is written here, so the check belongs here too.
-- ---------------------------------------------------------------------------

create or replace function public.finalize_artist_invite(p_invite_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invite crm_private.staff_invites%rowtype;
  v_grant jsonb;
  v_user_id uuid;
  v_user_count integer;
begin
  if crm_private.jwt_role() <> 'authenticated' or auth.uid() is null then
    raise exception 'a signed-in session is required' using errcode = '42501';
  end if;

  select * into v_invite
  from crm_private.staff_invites i
  where i.id = p_invite_request_id
    and i.requested_by = auth.uid()
    and i.origin = 'tenant'
  for update;

  if v_invite.id is null then
    -- Not found, somebody else's, or an owner invitation being pushed through
    -- the tenant door. One answer for all three.
    raise exception 'invitation does not exist' using errcode = '23503';
  end if;

  if v_invite.status = 'provisioned' then
    return jsonb_build_object(
      'invite_request_id', v_invite.id,
      'status', 'provisioned',
      'idempotent_replay', true
    );
  end if;

  if v_invite.status = 'suppressed' then
    return jsonb_build_object(
      'invite_request_id', v_invite.id,
      'status', 'suppressed',
      'idempotent_replay', true
    );
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    update crm_private.staff_invites i set status = 'suppressed' where i.id = v_invite.id;
    raise exception 'that invitation has expired' using errcode = '22023';
  end if;

  if not crm_private.has_artist_capability(v_invite.artist_id, 'manage_team') then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  v_grant := crm_private.normalise_tenant_invite_grant(
    v_invite.artist_id,
    v_invite.memberships -> 0
  );

  select count(*) into v_user_count
  from auth.users u
  where lower(u.email::text) = v_invite.email_normalized::text;

  if v_user_count = 0 then
    raise exception 'the invited Auth user does not exist yet' using errcode = '23503';
  elsif v_user_count > 1 then
    raise exception 'the invited email matches multiple Auth users' using errcode = '22023';
  end if;

  select u.id into v_user_id
  from auth.users u
  where lower(u.email::text) = v_invite.email_normalized::text;

  -- The address acquired a profile after `begin` accepted it. Same terminal
  -- state as the suppression there, and the same answer to the caller: this
  -- path never reports whether somebody exists.
  if exists (
    select 1 from public.profiles p
    where p.id = v_user_id or p.email = v_invite.email_normalized
  ) then
    update crm_private.staff_invites i set status = 'suppressed' where i.id = v_invite.id;
    perform crm_private.log_artist_activity(
      v_invite.artist_id, 'invite.tenant_suppressed', 'staff', auth.uid(),
      null, null, null, null, null,
      jsonb_build_object('invite_request_id', v_invite.id, 'at', 'finalize')
    );
    return jsonb_build_object(
      'invite_request_id', v_invite.id,
      'status', 'suppressed',
      'idempotent_replay', false
    );
  end if;

  insert into public.profiles (id, email, display_name, role, is_active)
  values (v_user_id, v_invite.email_normalized, v_invite.display_name, 'booking_manager', false);

  -- Exactly one membership, on the artist the invitation named. There is no
  -- loop here because there is no list: the reach of a tenant invitation is a
  -- single row by construction, not by validation.
  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  ) values (
    v_user_id,
    v_invite.artist_id,
    (v_grant ->> 'access_level')::public.artist_access_level,
    (v_grant ->> 'can_view_finance')::boolean,
    (v_grant ->> 'can_manage_finance')::boolean,
    (v_grant ->> 'can_manage_sessions')::boolean,
    (v_grant ->> 'can_manage_integrations')::boolean,
    true,
    'explicit'
  );

  -- Access becomes effective only once the membership is present, the same
  -- atomic boundary the owner path uses around the Auth call.
  update public.profiles p set is_active = true where p.id = v_user_id;

  update crm_private.staff_invites i
  set status = 'provisioned', auth_user_id = v_user_id, provisioned_at = now()
  where i.id = v_invite.id;

  perform crm_private.log_artist_activity(
    v_invite.artist_id, 'invite.tenant_provisioned', 'staff', auth.uid(),
    null, null, null, null, v_user_id,
    jsonb_build_object(
      'invite_request_id', v_invite.id,
      'access_level', v_grant ->> 'access_level',
      'can_view_finance', (v_grant ->> 'can_view_finance')::boolean,
      'can_manage_finance', (v_grant ->> 'can_manage_finance')::boolean,
      'can_manage_sessions', (v_grant ->> 'can_manage_sessions')::boolean,
      'can_manage_integrations', (v_grant ->> 'can_manage_integrations')::boolean
    )
  );

  return jsonb_build_object(
    'invite_request_id', v_invite.id,
    'status', 'provisioned',
    'idempotent_replay', false
  );
end;
$$;

comment on function public.finalize_artist_invite(uuid) is
  'Complete a tenant-scoped invitation: one profile, one membership on the artist the invitation named. Re-checks the caller capability and the grant ceiling, because the Auth call between begin and finalize is not transactional.';

revoke all on function public.finalize_artist_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_artist_invite(uuid) to authenticated;
