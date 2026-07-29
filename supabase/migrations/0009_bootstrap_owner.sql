-- 0009_bootstrap_owner.sql
--
-- Idempotent owner promotion.
--
-- This file contains NO owner email address, NO owner UUID and NO password.
-- The identity is supplied by the owner at run time; see
-- docs/crm/OWNER_SETUP.md section 3. Neither function creates an auth user:
-- the account must already exist, so a promotion cannot invent an identity.
--
-- Forward-only.

create or replace function public.bootstrap_owner(
  p_user_id      uuid,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_email    text;
  v_existing public.profiles%rowtype;
  v_changed  boolean := false;
begin
  if p_user_id is null then
    raise exception 'an explicit auth user id is required' using errcode = '22023';
  end if;

  -- Promotion is authorised by one of three things: the CRM has no owner yet
  -- (first-run bootstrap), an existing owner is doing it, or the trusted
  -- backend is. Checking here rather than leaving it to RLS matters: without
  -- it, an unauthorised call would be silently filtered to zero rows and would
  -- still report success.
  if not (
    crm_private.no_active_owner()
    or public.is_owner()
    or crm_private.is_service_backend()
  ) then
    raise exception 'only an existing owner or the trusted backend may promote an owner'
      using errcode = '42501';
  end if;

  select u.email::text into v_email from auth.users u where u.id = p_user_id;
  if v_email is null then
    raise exception 'no auth user exists with id %', p_user_id
      using errcode = '23503',
            hint = 'Create the account in Supabase Auth first; bootstrap never creates one.';
  end if;

  select * into v_existing from public.profiles p where p.id = p_user_id;
  v_changed := not found or v_existing.role <> 'owner' or not v_existing.is_active;

  -- The audit row is written BEFORE the promotion, deliberately. Both happen in
  -- one transaction, so the ordering changes nothing about the outcome — but it
  -- means the very first bootstrap is still inside the "no active owner yet"
  -- window when the activity policy is checked, and therefore needs no RLS
  -- bypass. A later promotion is authorised as the acting owner or the Worker.
  if v_changed then
    perform crm_private.log_activity(
      'owner.bootstrapped', 'system', null, null, null, null, null, p_user_id,
      null, null, null,
      jsonb_build_object('promoted', true)
    );
  end if;

  if v_existing.id is null then
    insert into public.profiles (id, email, display_name, role, is_active)
    values (p_user_id, v_email, p_display_name, 'owner', true);
  elsif v_changed then
    update public.profiles p
    set role = 'owner',
        is_active = true,
        display_name = coalesce(p_display_name, p.display_name)
    where p.id = p_user_id;
  end if;

  return jsonb_build_object('profile_id', p_user_id, 'role', 'owner', 'changed', v_changed);
end;
$$;

create or replace function public.bootstrap_owner_by_email(
  p_email        text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_user_id uuid;
  v_matches integer;
begin
  if p_email is null or btrim(p_email) = '' then
    raise exception 'an explicit owner email is required' using errcode = '22023';
  end if;

  select count(*) into v_matches
  from auth.users u
  where lower(u.email::text) = public.normalize_email(p_email);

  if v_matches = 0 then
    raise exception 'no auth user exists with email %', p_email
      using errcode = '23503',
            hint = 'Create the account in Supabase Auth first; bootstrap never creates one.';
  elsif v_matches > 1 then
    raise exception 'email % matches % auth users; pass the explicit uuid instead', p_email, v_matches
      using errcode = '22023';
  end if;

  select u.id into v_user_id
  from auth.users u
  where lower(u.email::text) = public.normalize_email(p_email);

  return public.bootstrap_owner(v_user_id, p_display_name);
end;
$$;

-- Bootstrap is a privileged, manually invoked operation. It is never reachable
-- from a browser session or from the Worker's normal call surface.
revoke all on function public.bootstrap_owner(uuid, text) from public;
revoke all on function public.bootstrap_owner_by_email(text, text) from public;
revoke all on function public.bootstrap_owner(uuid, text) from anon, authenticated;
revoke all on function public.bootstrap_owner_by_email(text, text) from anon, authenticated;

comment on function public.bootstrap_owner(uuid, text) is
  'Idempotently promotes an EXISTING auth user to the CRM owner role. Contains no baked-in identity. See docs/crm/OWNER_SETUP.md.';
comment on function public.bootstrap_owner_by_email(text, text) is
  'Email convenience wrapper for bootstrap_owner. Refuses ambiguous matches rather than guessing.';
