-- 20260928140000_artist_facing_notification_recipients.sql
--
-- Personal notifications go to the artist they concern, not to every owner
-- who administers that artist.
--
-- The producers of public.notifications chose recipients three ways:
--   * automation_notification_recipients() - every active 'owner' or 'artist'
--     member. It left out 'manager', so an artist whose own profile is a
--     manager membership (the usual shape for an artist added to a studio)
--     never received their own failure alerts, automation notices or
--     appointment responses, and the studio owner received all of them.
--   * follow_up_recipients() - the assignee, otherwise the same owner/artist
--     set, with the same effect.
--   * telegram_notification_recipient_eligible() - artist/manager preferred,
--     but the owner fallback fired whenever that artist had no *Telegram*
--     destination enabled, so a paused Telegram switch moved the artist's
--     enquiries into the owner's notification centre.
--
-- CRM producers now share artist_notification_recipients(): the active
-- members of the artist's artist-facing tier ('artist' memberships if it has
-- any, otherwise 'manager' memberships); active owners only when that tier
-- has nobody active (the solo-owner case, which is how a studio owner is the
-- artist-facing profile of their own artist). The tiers keep migration 0077's intent that a reminder goes to the
-- people who run the artist rather than every manager, while an artist whose
-- own profile is a manager membership now receives their own notifications.
--
-- The Telegram-routed producers keep their artist+manager preference, but the
-- owner fallback now depends on whether an artist-facing member exists, not on
-- whether that member has Telegram switched on.
--
-- Administrative access is untouched: the owner still opens, edits and reports
-- on every artist they hold.
--
-- Notifications already addressed by the old rule are dismissed, not deleted:
-- the row, its Telegram delivery record and its history stay, and the
-- notification centre stops listing dismissed rows.
--
-- The same migration adds mark_all_notifications_read(): one server-side
-- update over every unread notification the caller can currently see.

-- ---------------------------------------------------------------------------
-- 1. The one recipient rule
-- ---------------------------------------------------------------------------

create or replace function crm_private.artist_notification_recipients(p_artist_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  -- The artist-facing tier is decided by how the artist is set up, not by who
  -- happens to be active: an artist with an 'artist' membership is reached
  -- through it, otherwise through its 'manager' memberships. A deactivated
  -- member is not silently replaced by a colleague of a lower tier. When the
  -- tier has nobody active (or the artist has no artist/manager membership at
  -- all, the solo-owner case), the active owners receive.
  with members as (
    select a.profile_id,
           a.access_level,
           a.is_active and p.is_active as active
    from crm_private.artist_access a
    join crm_private.profile_access p on p.profile_id = a.profile_id
    where a.artist_id = p_artist_id
      and a.access_level in ('owner', 'artist', 'manager')
  ),
  tier as (
    select case
      when exists (select 1 from members where access_level = 'artist') then 'artist'
      when exists (select 1 from members where access_level = 'manager') then 'manager'
      else 'owner'
    end as level
  ),
  facing as (
    select m.profile_id
    from members m, tier t
    where m.active and m.access_level::text = t.level
  )
  select distinct f.profile_id from facing f
  union
  select m.profile_id
  from members m
  where m.active
    and m.access_level = 'owner'
    and not exists (select 1 from facing);
$$;

revoke all on function crm_private.artist_notification_recipients(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.artist_notification_recipients(uuid) is
  'Artist-facing recipients of an artist''s operational notifications: the active members of its artist tier (artist memberships if it has any, otherwise manager memberships); the active owners only when that tier has nobody active. Admin access alone is not a subscription.';

-- ---------------------------------------------------------------------------
-- 2. Automation, failure-alert and appointment-response producers
-- ---------------------------------------------------------------------------

create or replace function crm_private.automation_notification_recipients(p_artist_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select r.profile_id from crm_private.artist_notification_recipients(p_artist_id) r;
$$;

revoke all on function crm_private.automation_notification_recipients(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Follow-ups: an explicit assignee still wins
-- ---------------------------------------------------------------------------

create or replace function crm_private.follow_up_recipients(p_follow_up_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with f as (
    select id, artist_id, assigned_to
    from public.follow_ups
    where id = p_follow_up_id
  ),
  assignee as (
    select p.profile_id
    from f
    join crm_private.profile_access p on p.profile_id = f.assigned_to
    join crm_private.artist_access a
      on a.profile_id = p.profile_id and a.artist_id = f.artist_id
    where p.is_active and a.is_active
  )
  select profile_id from assignee
  union all
  select r.profile_id
  from f
  cross join lateral crm_private.artist_notification_recipients(f.artist_id) r
  where not exists (select 1 from assignee);
$$;

revoke all on function crm_private.follow_up_recipients(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. New enquiries and AI next actions (Telegram-routed producers)
--
-- The Telegram requirement stays: these rows exist to be pushed. The owner
-- fallback now follows the same rule as everything else, so an artist who has
-- paused Telegram is not replaced by the owner.
-- ---------------------------------------------------------------------------

create or replace function crm_private.telegram_notification_recipient_eligible(
  p_profile_id uuid,
  p_artist_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
  select exists (
    select 1
    from public.profiles p
    join crm_private.telegram_destinations d
      on d.destination_kind = 'profile'
     and d.profile_id = p.id
     and d.is_active
    join public.notification_preferences pref
      on pref.profile_id = p.id
     and pref.channel = 'telegram'
     and pref.is_enabled
    where p.id = p_profile_id
      and p.is_active
      and crm_private.profile_can_receive_notification(
        p.id, p_artist_id, p_workspace_id
      )
      and (
        p_artist_id is null
        or exists (
          select 1
          from public.artist_memberships am
          where am.profile_id = p.id
            and am.artist_id = p_artist_id
            and am.is_active
            and (
              am.access_level in ('artist', 'manager')
              or (
                am.access_level = 'owner'
                and not exists (
                  select 1
                  from public.artist_memberships preferred_am
                  join public.profiles preferred_p
                    on preferred_p.id = preferred_am.profile_id
                   and preferred_p.is_active
                  where preferred_am.artist_id = p_artist_id
                    and preferred_am.is_active
                    and preferred_am.access_level in ('artist', 'manager')
                    and crm_private.profile_can_receive_notification(
                      preferred_am.profile_id, p_artist_id, p_workspace_id
                    )
                )
              )
            )
        )
      )
  );
$function$;

comment on function crm_private.telegram_notification_recipient_eligible(uuid, uuid, uuid)
is 'Telegram recipient gate: artist/manager memberships receive; owner only when the artist has no active artist/manager member (whether or not that member has Telegram on); read-only is excluded.';

-- ---------------------------------------------------------------------------
-- 5. The notification centre does not list dismissed rows
-- ---------------------------------------------------------------------------

create or replace function public.list_notifications(
  p_status public.notification_status default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  artist_id uuid,
  artist_label text,
  notification_type text,
  title text,
  body text,
  entity_type text,
  entity_id uuid,
  priority public.notification_priority,
  status public.notification_status,
  scheduled_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select n.id, n.artist_id, a.display_name, n.notification_type, n.title, n.body,
         n.entity_type, n.entity_id, n.priority, n.status, n.scheduled_at, n.read_at
  from public.notifications n
  left join public.artists a on a.id = n.artist_id
  where n.recipient_profile_id = auth.uid()
    and public.is_active_user()
    -- An artist-scoped notification is visible only while the recipient still
    -- holds that artist. A notification with no artist is personal or
    -- workspace-level and is governed by the workspace check below.
    and (n.artist_id is null or public.can_access_artist(n.artist_id))
    and (n.workspace_id is null or public.can_access_workspace(n.workspace_id))
    -- A dismissed row is history, not something waiting for the recipient.
    and (
      (p_status is null and n.status <> 'dismissed')
      or n.status = p_status
    )
  order by n.scheduled_at desc, n.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.list_notifications(public.notification_status, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_notifications(public.notification_status, integer)
  to authenticated;

comment on function public.list_notifications(public.notification_status, integer) is
  'The signed-in profile''s own notifications, restricted to the artists and workspaces they currently hold. Dismissed rows are listed only when asked for by status. Revoking a membership hides its notifications without deleting them.';

-- ---------------------------------------------------------------------------
-- 6. Mark all read
--
-- Exactly the rows list_notifications would show as unread: the caller's own,
-- still in scope, not read and not dismissed. Idempotent: a second call
-- updates nothing and returns 0. Other profiles' rows cannot match because the
-- recipient is auth.uid(), never a parameter.
-- ---------------------------------------------------------------------------

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_updated integer;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'sign in to update notifications' using errcode = '42501';
  end if;

  update public.notifications n
  set status = 'read',
      read_at = coalesce(n.read_at, now()),
      delivered_at = coalesce(n.delivered_at, now())
  where n.recipient_profile_id = auth.uid()
    and n.status in ('pending', 'delivered')
    and (n.artist_id is null or public.can_access_artist(n.artist_id))
    and (n.workspace_id is null or public.can_access_workspace(n.workspace_id));

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.mark_all_notifications_read()
  from public, anon, authenticated, service_role;
grant execute on function public.mark_all_notifications_read()
  to authenticated;

comment on function public.mark_all_notifications_read() is
  'Marks every unread notification the signed-in profile can currently see as read, in one statement. Returns the number of rows changed.';

-- ---------------------------------------------------------------------------
-- 7. Rows the old rules addressed to an administrative owner
--
-- Unread artist-scoped rows addressed to a profile whose only standing on that
-- artist is an owner membership, while the artist has an active artist or
-- manager member of its own, are dismissed. A follow-up explicitly assigned to
-- the owner is theirs and stays. Only rows whose delivery window has passed and
-- whose Telegram push is settled are touched. Nothing is deleted.
-- ---------------------------------------------------------------------------

with misrouted as (
  update public.notifications n
  set status = 'dismissed',
      updated_at = now()
  where n.artist_id is not null
    and n.status in ('pending', 'delivered')
    and n.scheduled_at <= now() - interval '10 minutes'
    and exists (
      select 1
      from crm_private.artist_access own
      where own.profile_id = n.recipient_profile_id
        and own.artist_id = n.artist_id
        and own.access_level = 'owner'
    )
    and exists (
      select 1
      from crm_private.artist_access facing
      join crm_private.profile_access fp on fp.profile_id = facing.profile_id
      where facing.artist_id = n.artist_id
        and facing.is_active
        and fp.is_active
        and facing.access_level in ('artist', 'manager')
    )
    and not exists (
      select 1
      from public.follow_ups f
      where n.entity_type = 'follow_up'
        and f.id = n.entity_id
        and f.assigned_to = n.recipient_profile_id
    )
    -- The Telegram claim does not read status, so a row is dismissed only
    -- once its push is settled: it already has a delivery record, or its
    -- recipient has no active Telegram destination to be claimed for.
    and (
      exists (
        select 1 from crm_private.telegram_notification_deliveries d
        where d.notification_id = n.id
      )
      or not exists (
        select 1 from crm_private.telegram_destinations td
        where td.destination_kind = 'profile'
          and td.profile_id = n.recipient_profile_id
          and td.is_active
      )
    )
  returning n.id
)
select count(*) as dismissed_misrouted_notifications from misrouted;
