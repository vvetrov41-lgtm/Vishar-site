-- 0037_team_access_management.sql
--
-- Owner-managed staff invitation and artist access. Auth invitation remains a
-- trusted-backend operation; these RPCs only prepare and atomically finalise
-- CRM access around that external boundary.
--
-- Forward-only.

create table if not exists crm_private.staff_invites (
  id               uuid primary key default gen_random_uuid(),
  requested_by     uuid not null references public.profiles(id) on delete restrict,
  idempotency_key  uuid not null,
  email_normalized extensions.citext not null,
  display_name     text,
  role             public.crm_role not null,
  memberships      jsonb not null,
  status           text not null default 'pending',
  auth_user_id     uuid references auth.users(id) on delete restrict,
  created_at       timestamptz not null default now(),
  provisioned_at   timestamptz,

  constraint staff_invites_role_not_owner check (role <> 'owner'),
  constraint staff_invites_status_allowed check (status in ('pending', 'provisioned')),
  constraint staff_invites_memberships_array check (jsonb_typeof(memberships) = 'array'),
  constraint staff_invites_display_name_length check (
    display_name is null or char_length(display_name) <= 120
  ),
  constraint staff_invites_request_key unique (requested_by, idempotency_key)
);

create unique index if not exists staff_invites_one_pending_email_idx
  on crm_private.staff_invites (email_normalized)
  where status = 'pending';

revoke all on crm_private.staff_invites from public, anon, authenticated, service_role;

comment on table crm_private.staff_invites is
  'Private idempotency state for owner-approved Auth invitations. Stores no invite token, password or credential.';

create or replace function crm_private.normalise_staff_invite_memberships(
  p_role public.crm_role,
  p_memberships jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_item jsonb;
  v_artist_id uuid;
  v_access_level public.artist_access_level;
  v_can_view_finance boolean;
  v_can_manage_finance boolean;
  v_can_manage_sessions boolean;
  v_can_manage_integrations boolean;
  v_seen uuid[] := array[]::uuid[];
  v_result jsonb := '[]'::jsonb;
begin
  if p_role is null or p_role = 'owner' then
    raise exception 'staff invitations cannot create an owner' using errcode = '22023';
  end if;

  if p_memberships is null or jsonb_typeof(p_memberships) <> 'array' then
    raise exception 'artist memberships must be a JSON array' using errcode = '22023';
  end if;

  if jsonb_array_length(p_memberships) < 1 or jsonb_array_length(p_memberships) > 32 then
    raise exception 'between 1 and 32 artist memberships are required' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_memberships) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each artist membership must be an object' using errcode = '22023';
    end if;

    if exists (
      select 1
      from jsonb_object_keys(v_item) as keys(key_name)
      where key_name not in (
        'artist_id', 'access_level', 'can_view_finance', 'can_manage_finance',
        'can_manage_sessions', 'can_manage_integrations'
      )
    ) then
      raise exception 'artist membership contains an unsupported field' using errcode = '22023';
    end if;

    if not (v_item ? 'artist_id') or not (v_item ? 'access_level') then
      raise exception 'artist_id and access_level are required' using errcode = '22023';
    end if;

    begin
      v_artist_id := (v_item ->> 'artist_id')::uuid;
      v_access_level := (v_item ->> 'access_level')::public.artist_access_level;
    exception when invalid_text_representation then
      raise exception 'artist_id or access_level is invalid' using errcode = '22023';
    end;

    if v_artist_id is null or v_access_level is null then
      raise exception 'artist_id and access_level cannot be null' using errcode = '22023';
    end if;

    if v_access_level = 'owner' then
      raise exception 'an invited non-owner cannot receive owner artist access'
        using errcode = '22023';
    end if;

    if v_artist_id = any(v_seen) then
      raise exception 'each artist may appear only once in an invitation' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_artist_id);

    if not exists (
      select 1 from crm_private.artist_state a
      where a.artist_id = v_artist_id and a.is_active
    ) then
      raise exception 'artist % does not exist or is inactive', v_artist_id using errcode = '23503';
    end if;

    if (v_item ? 'can_view_finance' and jsonb_typeof(v_item -> 'can_view_finance') <> 'boolean')
       or (v_item ? 'can_manage_finance' and jsonb_typeof(v_item -> 'can_manage_finance') <> 'boolean')
       or (v_item ? 'can_manage_sessions' and jsonb_typeof(v_item -> 'can_manage_sessions') <> 'boolean')
       or (v_item ? 'can_manage_integrations' and jsonb_typeof(v_item -> 'can_manage_integrations') <> 'boolean') then
      raise exception 'artist capability flags must be booleans' using errcode = '22023';
    end if;

    v_can_view_finance := coalesce((v_item ->> 'can_view_finance')::boolean, false);
    v_can_manage_finance := coalesce((v_item ->> 'can_manage_finance')::boolean, false);
    v_can_manage_sessions := coalesce((v_item ->> 'can_manage_sessions')::boolean, false);
    v_can_manage_integrations := coalesce((v_item ->> 'can_manage_integrations')::boolean, false);

    if v_can_manage_finance and not v_can_view_finance then
      raise exception 'finance management requires finance visibility' using errcode = '22023';
    end if;

    if p_role = 'read_only' and (
      v_access_level <> 'read_only'
      or v_can_view_finance
      or v_can_manage_finance
      or v_can_manage_sessions
      or v_can_manage_integrations
    ) then
      raise exception 'a global read_only profile cannot receive management capabilities'
        using errcode = '22023';
    end if;

    if v_access_level = 'read_only' and (
      v_can_view_finance
      or v_can_manage_finance
      or v_can_manage_sessions
      or v_can_manage_integrations
    ) then
      raise exception 'read_only artist access cannot carry management capabilities'
        using errcode = '22023';
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'artist_id', v_artist_id,
      'access_level', v_access_level,
      'can_view_finance', v_can_view_finance,
      'can_manage_finance', v_can_manage_finance,
      'can_manage_sessions', v_can_manage_sessions,
      'can_manage_integrations', v_can_manage_integrations
    ));
  end loop;

  select jsonb_agg(value order by value ->> 'artist_id')
  into v_result
  from jsonb_array_elements(v_result);

  return v_result;
end;
$$;

revoke all on function crm_private.normalise_staff_invite_memberships(public.crm_role,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.list_team_memberships()
returns table (
  profile_id uuid,
  artist_id uuid,
  access_level public.artist_access_level,
  can_view_finance boolean,
  can_manage_finance boolean,
  can_manage_sessions boolean,
  can_manage_integrations boolean,
  is_active boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner');

  return query
  select m.profile_id, m.artist_id, m.access_level,
         m.can_view_finance, m.can_manage_finance,
         m.can_manage_sessions, m.can_manage_integrations, m.is_active
  from public.artist_memberships m
  order by m.profile_id, m.artist_id;
end;
$$;

create or replace function public.begin_staff_invite(
  p_idempotency_key uuid,
  p_email text,
  p_display_name text,
  p_role public.crm_role,
  p_memberships jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_email text;
  v_display_name text;
  v_memberships jsonb;
  v_existing crm_private.staff_invites%rowtype;
  v_invite_id uuid;
begin
  perform crm_private.require_role('owner');

  if p_idempotency_key is null then
    raise exception 'an idempotency key is required' using errcode = '22023';
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

  v_memberships := crm_private.normalise_staff_invite_memberships(p_role, p_memberships);

  perform pg_advisory_xact_lock(hashtextextended('crm:staff-invite:' || v_email, 0));

  select * into v_existing
  from crm_private.staff_invites i
  where i.requested_by = auth.uid() and i.idempotency_key = p_idempotency_key
  for update;

  if v_existing.id is not null then
    if v_existing.email_normalized::text <> v_email
       or v_existing.display_name is distinct from v_display_name
       or v_existing.role <> p_role
       or v_existing.memberships <> v_memberships then
      raise exception 'an idempotency key cannot be reused for a different invitation'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'invite_request_id', v_existing.id,
      'email_normalized', v_existing.email_normalized::text,
      'status', v_existing.status,
      'profile_id', v_existing.auth_user_id,
      'role', v_existing.role,
      'is_active', v_existing.status = 'provisioned',
      'idempotent_replay', true
    );
  end if;

  select * into v_existing
  from crm_private.staff_invites i
  where i.email_normalized = v_email and i.status = 'pending'
  for update;

  if v_existing.id is not null then
    if v_existing.requested_by = auth.uid()
       and v_existing.display_name is not distinct from v_display_name
       and v_existing.role = p_role
       and v_existing.memberships = v_memberships then
      return jsonb_build_object(
        'invite_request_id', v_existing.id,
        'email_normalized', v_existing.email_normalized::text,
        'status', v_existing.status,
        'profile_id', null,
        'role', v_existing.role,
        'is_active', false,
        'idempotent_replay', true
      );
    end if;

    raise exception 'a different pending invitation already exists for that email address'
      using errcode = '23505';
  end if;

  if exists (select 1 from public.profiles p where p.email = v_email) then
    raise exception 'a CRM profile already exists for that email address' using errcode = '23505';
  end if;

  insert into crm_private.staff_invites (
    requested_by, idempotency_key, email_normalized,
    display_name, role, memberships
  ) values (
    auth.uid(), p_idempotency_key, v_email,
    v_display_name, p_role, v_memberships
  ) returning id into v_invite_id;

  perform crm_private.log_activity(
    'profile.invite_requested', 'owner', auth.uid(),
    null, null, null, null, null, null, null, null,
    jsonb_build_object(
      'invite_request_id', v_invite_id,
      'target_role', p_role,
      'membership_count', jsonb_array_length(v_memberships)
    )
  );

  return jsonb_build_object(
    'invite_request_id', v_invite_id,
    'email_normalized', v_email,
    'status', 'pending',
    'profile_id', null,
    'role', p_role,
    'is_active', false,
    'idempotent_replay', false
  );
end;
$$;

create or replace function public.finalize_staff_invite(p_invite_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invite crm_private.staff_invites%rowtype;
  v_user_id uuid;
  v_user_count integer;
  v_item jsonb;
begin
  perform crm_private.require_role('owner');

  select * into v_invite
  from crm_private.staff_invites i
  where i.id = p_invite_request_id and i.requested_by = auth.uid()
  for update;

  if v_invite.id is null then
    raise exception 'staff invitation does not exist' using errcode = '23503';
  end if;

  if v_invite.status = 'provisioned' then
    return jsonb_build_object(
      'invite_request_id', v_invite.id,
      'status', v_invite.status,
      'profile_id', v_invite.auth_user_id,
      'role', v_invite.role,
      'is_active', true,
      'idempotent_replay', true
    );
  end if;

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

  if exists (
    select 1 from public.profiles p
    where p.id = v_user_id or p.email = v_invite.email_normalized
  ) then
    raise exception 'the invited Auth user already has a CRM profile' using errcode = '23505';
  end if;

  insert into public.profiles (id, email, display_name, role, is_active)
  values (
    v_user_id,
    v_invite.email_normalized,
    v_invite.display_name,
    v_invite.role,
    false
  );

  for v_item in select value from jsonb_array_elements(v_invite.memberships) loop
    insert into public.artist_memberships (
      profile_id, artist_id, access_level,
      can_view_finance, can_manage_finance,
      can_manage_sessions, can_manage_integrations, is_active
    ) values (
      v_user_id,
      (v_item ->> 'artist_id')::uuid,
      (v_item ->> 'access_level')::public.artist_access_level,
      (v_item ->> 'can_view_finance')::boolean,
      (v_item ->> 'can_manage_finance')::boolean,
      (v_item ->> 'can_manage_sessions')::boolean,
      (v_item ->> 'can_manage_integrations')::boolean,
      true
    );

    perform crm_private.log_artist_activity(
      (v_item ->> 'artist_id')::uuid,
      'membership.updated',
      'owner',
      auth.uid(),
      null, null, null, null,
      v_user_id,
      jsonb_build_object(
        'source', 'invite_provision',
        'access_level', v_item ->> 'access_level',
        'is_active', true,
        'can_view_finance', (v_item ->> 'can_view_finance')::boolean,
        'can_manage_finance', (v_item ->> 'can_manage_finance')::boolean,
        'can_manage_sessions', (v_item ->> 'can_manage_sessions')::boolean,
        'can_manage_integrations', (v_item ->> 'can_manage_integrations')::boolean
      )
    );
  end loop;

  -- Access becomes effective only after every membership is present. This is
  -- the atomic database boundary around the non-transactional Auth email call.
  update public.profiles p set is_active = true where p.id = v_user_id;

  update crm_private.staff_invites i
  set status = 'provisioned', auth_user_id = v_user_id, provisioned_at = now()
  where i.id = v_invite.id;

  perform crm_private.log_activity(
    'profile.provisioned', 'owner', auth.uid(),
    null, null, null, null, v_user_id, null, null, null,
    jsonb_build_object(
      'invite_request_id', v_invite.id,
      'target_role', v_invite.role,
      'membership_count', jsonb_array_length(v_invite.memberships)
    )
  );

  return jsonb_build_object(
    'invite_request_id', v_invite.id,
    'status', 'provisioned',
    'profile_id', v_user_id,
    'role', v_invite.role,
    'is_active', true,
    'idempotent_replay', false
  );
end;
$$;

-- Demoting a profile to read_only also removes stored management capability
-- flags. Effective access was already narrowed by the global role; clearing the
-- rows prevents stale privileges from reappearing after a later promotion.
create or replace function public.set_profile_role(
  p_profile_id uuid,
  p_role public.crm_role
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_previous public.crm_role;
  v_owner_count integer;
  v_membership record;
begin
  perform pg_advisory_xact_lock(hashtextextended('crm:active-owner-invariant', 0));
  perform crm_private.require_role('owner');

  select p.role into v_previous
  from public.profiles p
  where p.id = p_profile_id
  for update;
  if v_previous is null then
    raise exception 'profile % does not exist', p_profile_id using errcode = '23503';
  end if;

  update public.profiles p set role = p_role where p.id = p_profile_id;

  if p_role = 'read_only' then
    for v_membership in
      update public.artist_memberships m
      set access_level = 'read_only',
          can_view_finance = false,
          can_manage_finance = false,
          can_manage_sessions = false,
          can_manage_integrations = false
      where m.profile_id = p_profile_id
        and (
          m.access_level <> 'read_only'
          or m.can_view_finance
          or m.can_manage_finance
          or m.can_manage_sessions
          or m.can_manage_integrations
        )
      returning m.artist_id, m.is_active
    loop
      perform crm_private.log_artist_activity(
        v_membership.artist_id,
        'membership.updated',
        'owner',
        auth.uid(),
        null, null, null, null,
        p_profile_id,
        jsonb_build_object(
          'source', 'role_narrowed',
          'access_level', 'read_only',
          'is_active', v_membership.is_active,
          'can_view_finance', false,
          'can_manage_finance', false,
          'can_manage_sessions', false,
          'can_manage_integrations', false
        )
      );
    end loop;
  end if;

  select count(*) into v_owner_count
  from crm_private.profile_access a where a.role = 'owner' and a.is_active;
  if v_owner_count = 0 then
    raise exception 'at least one active owner must remain' using errcode = '22023';
  end if;

  perform crm_private.log_activity(
    'profile.role_changed', 'owner', auth.uid(), null, null, null, null, p_profile_id,
    null, null, null,
    jsonb_build_object('from_role', v_previous, 'to_role', p_role)
  );

  return jsonb_build_object('profile_id', p_profile_id, 'role', p_role);
end;
$$;

revoke all on function public.list_team_memberships()
  from public, anon, authenticated, service_role;
revoke all on function public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_staff_invite(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_team_memberships() to authenticated;
grant execute on function public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb) to authenticated;
grant execute on function public.finalize_staff_invite(uuid) to authenticated;

comment on function public.list_team_memberships() is
  'Owner-only safe team access graph. Returns no credential or provider configuration.';
comment on function public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb) is
  'Owner-only idempotent preparation for a trusted-backend Auth invitation. Cannot create an owner.';
comment on function public.finalize_staff_invite(uuid) is
  'Owner-only atomic profile and membership provisioning after the Auth account exists.';
