-- 0135_account_lifecycle.sql
--
-- Two things a person needs about their own account, and one honest answer
-- about what "delete" can mean here.
--
--
-- 1. What the interface should call them
-- --------------------------------------
-- Migration 0130 gives every self-service founder the global role
-- `booking_manager`, deliberately: `owner` is the legacy installation-wide
-- role and a public form may not hand it out. That is the right internal
-- answer and the wrong thing to print next to somebody's name. A tattoo
-- artist who signed up, owns their own solo organization and holds the
-- `artist` seat on their own artist was being shown "Booking manager".
--
-- So the user-facing classification is separated from the authorization role
-- and derived here, on the server, from the same rows authorization reads:
-- `crm_private.profile_access` and `public.artist_memberships`. Nothing about
-- who may do what changes. The browser is told what to print; it is not asked
-- to work it out, and it cannot widen anything by lying about the answer.
--
--
-- 2. Deleting an account
-- ----------------------
-- `public.activity_log` is append-only, and that is enforced by a trigger that
-- survives BYPASSRLS (0005). Three referential facts follow from it:
--
--   * `activity_log.actor_profile_id` and `.profile_id` are ON DELETE SET
--     NULL, and a SET NULL is an UPDATE - which the trigger refuses. A profile
--     that has ever appeared in the log cannot be deleted.
--   * `activity_log.artist_id` is ON DELETE RESTRICT. An artist that has ever
--     appeared in the log cannot be deleted.
--   * `profiles.id` is ON DELETE CASCADE from `auth.users`, so deleting the
--     Auth row would delete the profile and hit the first case.
--
-- This is the wall the earlier production acceptance account ran into. There
-- are exactly two ways past it: mutate the audit log, or stop trying to drop
-- those rows. This migration takes the second.
--
-- `public.delete_my_account` therefore *erases and retires* rather than
-- DROPping rows the log points at:
--
--   the Supabase Auth identity is soft-deleted the way GoTrue itself marks a
--     deleted user (`deleted_at`), permanently banned, stripped of every
--     credential, session, refresh token, identity and factor, and its address
--     is released so it can sign up again
--   the CRM profile becomes an anonymous tombstone: no name, no address,
--     inactive, read_only
--   a self-service founder's artist and solo organization are deactivated and
--     anonymised, and every provider connection, route, booking form and
--     pending invitation belonging to them is deleted outright
--   artist memberships are deleted, so no access survives anywhere
--
-- Nothing in `activity_log` is deleted, updated or truncated, and the
-- append-only trigger is left exactly as it was. The log keeps pointing at
-- rows that still exist and that no longer name anybody.
--
-- What deliberately stays, and why:
--
--   * the artist and workspace rows, because the log references them. They are
--     switched off and hold no personal data afterwards.
--   * the founder's own `workspace_memberships` row. 0089's
--     `protect_last_workspace_owner` refuses to let an organization lose its
--     last active owner, on UPDATE and on DELETE alike. Removing that guard to
--     satisfy a delete button would be the wrong trade: the row denies
--     everything anyway, because every capability predicate reads
--     `crm_private.profile_access.is_active`, which is false from here on.
--   * `crm_private.self_service_accounts`, which is the ledger that makes a
--     second tenant per account impossible and bounds the founder cap.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. The user-facing role
--
-- Order matters, and each step is a decision rather than a fallthrough:
--
--   an installation operator is named as one first, so the `owner` artist
--     memberships that 0015's owner-sync gives them across every artist never
--     make the installation's operator look like somebody's tattoo artist;
--   then an artist seat, which is what `bootstrap_artist_account` and
--     `seat_artist_owner` both write for a working artist;
--   then a manager seat, which is what an invitation grants somebody who
--     handles bookings for an artist they are not;
--   then read-only;
--   and only then the global role, for an account holding no seat at all.
-- ---------------------------------------------------------------------------

create or replace function crm_private.user_facing_role(p_profile_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_access crm_private.profile_access%rowtype;
  v_levels text[];
begin
  if p_profile_id is null then
    return 'none';
  end if;

  select * into v_access
  from crm_private.profile_access a
  where a.profile_id = p_profile_id;

  if v_access.profile_id is null or not v_access.is_active then
    return 'none';
  end if;

  -- The installation's own operator. Said first and unconditionally: this
  -- account administers the installation, and every other branch below would
  -- describe it as a tenant.
  if v_access.role = 'owner' then
    return 'operator';
  end if;

  select coalesce(array_agg(distinct m.access_level::text), array[]::text[])
    into v_levels
  from public.artist_memberships m
  where m.profile_id = p_profile_id and m.is_active;

  -- `owner` here is an artist seat, not the installation role - the branch
  -- above already claimed that case - so somebody holding one runs that
  -- artist and is described as one.
  if v_levels && array['artist', 'owner'] then
    return 'artist';
  end if;
  if v_levels && array['manager'] then
    return 'booking_manager';
  end if;
  if v_levels && array['read_only'] then
    return 'read_only';
  end if;

  return case v_access.role
    when 'booking_manager' then 'booking_manager'
    when 'read_only' then 'read_only'
    else 'none'
  end;
end;
$$;

comment on function crm_private.user_facing_role(uuid) is
  'What to call this person in the interface, derived from the same rows authorization reads. Never an authorization answer: nothing consults it to decide access.';

revoke all on function crm_private.user_facing_role(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The account page's one read
--
-- Deliberately about the caller and nothing else. It takes no argument, so
-- there is no identifier to substitute, and it answers for `auth.uid()` only.
-- ---------------------------------------------------------------------------

create or replace function public.account_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_uid       uuid := auth.uid();
  v_profile   public.profiles%rowtype;
  v_ledger    crm_private.self_service_accounts%rowtype;
  v_others    integer := 0;
  v_blocked   text := null;
begin
  if v_uid is null or crm_private.jwt_role() <> 'authenticated' then
    raise exception 'sign in to read your account' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles p where p.id = v_uid;
  if v_profile.id is null or not v_profile.is_active then
    raise exception 'this account has no CRM access' using errcode = '42501';
  end if;

  select * into v_ledger
  from crm_private.self_service_accounts s
  where s.profile_id = v_uid;

  if v_ledger.profile_id is not null then
    select count(*) into v_others
    from public.artist_memberships m
    where m.artist_id = v_ledger.artist_id
      and m.profile_id <> v_uid
      and m.is_active;

    if v_others = 0 then
      select count(*) into v_others
      from public.workspace_memberships w
      where w.workspace_id = v_ledger.workspace_id
        and w.profile_id <> v_uid
        and w.is_active;
    end if;
  end if;

  -- The installation owner is refused first, because that refusal is about who
  -- they are rather than about what is attached to them.
  if v_profile.role = 'owner' then
    v_blocked := 'installation_owner';
  elsif v_others > 0 then
    v_blocked := 'shared_tenant';
  end if;

  return jsonb_build_object(
    'profile_id', v_profile.id,
    'email', v_profile.email,
    'display_name', v_profile.display_name,
    'global_role', v_profile.role,
    'user_role', crm_private.user_facing_role(v_uid),
    'is_self_service_founder', v_ledger.profile_id is not null,
    'owned_artist_id', v_ledger.artist_id,
    'owned_workspace_id', v_ledger.workspace_id,
    'can_delete_account', v_blocked is null,
    'delete_blocked_reason', v_blocked
  );
end;
$$;

comment on function public.account_overview() is
  'The signed-in account, as its own account page needs it: identity, the user-facing role derived server-side, whether this account founded its own tenant, and whether it may delete itself. Answers for auth.uid() only and takes no identifier.';

revoke all on function public.account_overview()
  from public, anon, authenticated, service_role;
grant execute on function public.account_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. A person may change their own name
--
-- The only column it touches, on the only row it can reach. `profiles` has had
-- no self-update path at all - `profiles_update_owner` is the installation
-- owner's policy - so an artist who typed their name once at signup could
-- never correct it. Role, is_active and email are not arguments here and are
-- not reachable from here.
-- ---------------------------------------------------------------------------

create or replace function public.set_my_display_name(p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if v_uid is null or crm_private.jwt_role() <> 'authenticated' then
    raise exception 'sign in to change your name' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.is_active
  ) then
    raise exception 'this account has no CRM access' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'a name is required' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'that name is too long' using errcode = '22023';
  end if;

  update public.profiles set display_name = v_name where id = v_uid;

  perform crm_private.log_lifecycle_event(
    'account.name_changed', null, jsonb_build_object('scope', 'self')
  );

  return jsonb_build_object('display_name', v_name);
end;
$$;

comment on function public.set_my_display_name(text) is
  'Change the signed-in account own display name. Touches one column on one row, chosen by auth.uid() rather than by an argument.';

revoke all on function public.set_my_display_name(text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_my_display_name(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Deleting an account
--
-- The guards, in the order they run:
--
--   1. an ordinary signed-in browser session, and only that - a backend key
--      has no auth.uid() to act for, and admitting one would make it a way to
--      delete arbitrary accounts;
--   2. an active CRM profile;
--   3. the installation owner is refused by name, for the same reason 0006
--      refuses them deactivating themselves: an installation with no owner has
--      no way back;
--   4. the confirmation, which is the account's own address typed out. A
--      fixed word would be guessable from the source; an address proves the
--      caller is looking at the account they are deleting. It is compared and
--      then discarded - it is never logged;
--   5. a per-account advisory lock, so two taps are one deletion;
--   6. a founder whose tenant has anybody else in it is refused, with the
--      reason, rather than quietly deleting somebody else's access.
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_uid        uuid := auth.uid();
  v_profile    public.profiles%rowtype;
  v_ledger     crm_private.self_service_accounts%rowtype;
  v_others     integer := 0;
  v_scope      text := 'membership';
  v_artist     uuid;
  v_workspace  uuid;
  v_slug       text;
begin
  if v_uid is null or crm_private.jwt_role() <> 'authenticated' then
    raise exception 'sign in to delete your account' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles p where p.id = v_uid;
  if v_profile.id is null or not v_profile.is_active then
    raise exception 'this account has no CRM access' using errcode = '42501';
  end if;

  if v_profile.role = 'owner' then
    raise exception 'the installation owner cannot delete their own account'
      using errcode = '42501',
            hint = 'Hand the installation over first.';
  end if;

  if lower(btrim(coalesce(p_confirmation, ''))) is distinct from lower(v_profile.email::text) then
    raise exception 'type your email address exactly to confirm' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('crm:account-delete:' || v_uid::text, 0));

  select * into v_ledger
  from crm_private.self_service_accounts s
  where s.profile_id = v_uid;

  if v_ledger.profile_id is not null then
    v_scope := 'tenant';
    v_artist := v_ledger.artist_id;
    v_workspace := v_ledger.workspace_id;

    select count(*) into v_others
    from public.artist_memberships m
    where m.artist_id = v_artist and m.profile_id <> v_uid and m.is_active;

    if v_others = 0 then
      select count(*) into v_others
      from public.workspace_memberships w
      where w.workspace_id = v_workspace and w.profile_id <> v_uid and w.is_active;
    end if;

    if v_others > 0 then
      raise exception 'remove everybody else from your account before deleting it'
        using errcode = '23514',
              hint = 'Revoke the other people on your artist first.';
    end if;
  end if;

  -- Written before anything is taken apart, so the event is recorded by an
  -- account that still exists, and against the artist while it still resolves.
  perform crm_private.log_lifecycle_event(
    'account.self_deleted',
    v_artist,
    jsonb_build_object('scope', v_scope, 'source', 'self_service')
  );

  -- -------------------------------------------------------------------------
  -- The tenant, for a founder deleting the whole thing.
  --
  -- Providers first: a live connection is the one thing that keeps acting on
  -- its own after the person has gone. Deleting the integration takes its
  -- routes with it (ON DELETE CASCADE), which is why routes are not deleted
  -- separately.
  -- -------------------------------------------------------------------------
  if v_scope = 'tenant' then
    delete from crm_private.telegram_link_sessions
    where artist_id = v_artist or profile_id = v_uid or requested_by = v_uid;

    delete from crm_private.telegram_destinations
    where artist_id = v_artist or profile_id = v_uid;

    delete from public.artist_integrations where artist_id = v_artist;
    delete from public.integration_assignments where artist_id = v_artist;
    delete from public.workspace_integrations where workspace_id = v_workspace;

    -- Booking forms are switched off rather than dropped: `enquiries` holds
    -- ON DELETE RESTRICT to the source it arrived through, so deleting one
    -- that ever took an enquiry would fail. Inactive is what actually stops
    -- the form taking another.
    update public.booking_sources
       set is_active = false, allowed_origin = null
     where artist_id = v_artist;

    delete from crm_private.staff_invites
    where artist_id = v_artist or requested_by = v_uid;

    delete from public.automation_rules where artist_id = v_artist;

    -- Anonymised, not renamed to something else recognisable. Both addresses
    -- are rotated rather than merely blanked, which also releases the name,
    -- the slug and the booking reference prefix for whoever wants them next.
    v_slug := 'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 40);
    while exists (select 1 from public.artists a where a.slug = v_slug) loop
      v_slug := 'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 40);
    end loop;

    update public.artists
       set is_active = false,
           display_name = 'Deleted account',
           legal_name = null,
           slug = v_slug,
           booking_reference_prefix = null
     where id = v_artist;

    v_slug := 'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 40);
    while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
      v_slug := 'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 40);
    end loop;

    update public.workspaces
       set is_active = false,
           display_name = 'Deleted account',
           slug = v_slug
     where id = v_workspace;
  else
    delete from crm_private.staff_invites where requested_by = v_uid;
  end if;

  -- -------------------------------------------------------------------------
  -- The person.
  --
  -- Artist seats go entirely: this is the row every artist-scoped predicate
  -- reads, so removing it is what makes the access gone rather than merely
  -- switched off. The workspace ownership row stays - see the header.
  -- -------------------------------------------------------------------------
  delete from public.artist_memberships where profile_id = v_uid;
  delete from public.notification_preferences where profile_id = v_uid;
  delete from public.notifications where recipient_profile_id = v_uid;
  delete from crm_private.gpt_profile_artist_contexts where profile_id = v_uid;

  update public.profiles
     set display_name = 'Deleted account',
         email = 'deleted-' || replace(v_uid::text, '-', '') || '@deleted.invalid',
         role = 'read_only',
         is_active = false
   where id = v_uid;

  -- -------------------------------------------------------------------------
  -- The Auth identity.
  --
  -- `deleted_at` is GoTrue's own marker for a deleted user and it is what
  -- 0130's bootstrap already refuses on; GoTrue will not find this row again.
  -- The ban, the unusable password and the removal of every identity, session,
  -- refresh token, factor and one-time token are belt and braces on top of it.
  -- The address is rewritten rather than kept, so the person can sign up again
  -- with it tomorrow.
  --
  -- The row itself is not DELETEd because `profiles.id` cascades from it, and
  -- the profile is the tombstone the append-only log points at.
  -- -------------------------------------------------------------------------
  delete from auth.sessions where user_id = v_uid;
  delete from auth.refresh_tokens where user_id = v_uid::text;
  delete from auth.identities where user_id = v_uid;
  delete from auth.mfa_factors where user_id = v_uid;
  delete from auth.one_time_tokens where user_id = v_uid;

  update auth.users
     set email = 'deleted-' || replace(v_uid::text, '-', '') || '@deleted.invalid',
         phone = null,
         encrypted_password = null,
         email_change = '',
         phone_change = '',
         confirmation_token = '',
         recovery_token = '',
         email_change_token_new = '',
         email_change_token_current = '',
         phone_change_token = '',
         reauthentication_token = '',
         raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data = '{}'::jsonb,
         banned_until = 'infinity'::timestamptz,
         deleted_at = now(),
         updated_at = now()
   where id = v_uid;

  return jsonb_build_object(
    'deleted', true,
    'scope', v_scope,
    'artist_id', v_artist,
    'workspace_id', v_workspace
  );
end;
$$;

comment on function public.delete_my_account(text) is
  'Erase and retire the signed-in account: Auth identity soft-deleted and stripped, profile anonymised and deactivated, artist seats removed, and for a self-service founder the artist, the solo organization and every provider connection retired. Acts for auth.uid() only. Nothing in public.activity_log is deleted, updated or truncated.';

revoke all on function public.delete_my_account(text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_my_account(text) to authenticated;
