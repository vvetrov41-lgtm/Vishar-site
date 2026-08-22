-- 0085_notification_scope_revocation.sql
--
-- Phase U found this, and it is the kind of defect only a cross-phase test can
-- find: every read in the platform re-derives artist membership on the request
-- that uses it, except one.
--
-- A notification is addressed to a person, so `list_notifications` matched on
-- `recipient_profile_id` and stopped there. That was correct when notifications
-- were built, because delivery and access were decided at the same moment. It
-- stopped being correct once membership became something a studio grants and
-- revokes: the row keeps the artist's display name, the title and body an
-- automation wrote for that artist, and the entity id of the enquiry or project
-- it concerns. A revoked manager kept all of it, in their own inbox, after the
-- CRM had otherwise closed to them.
--
-- The fix is the rule the rest of the platform already follows. A delivered
-- notification is not a standing grant; it is re-checked like everything else.
--
-- Nothing is deleted. Revocation hides the row and restoring the membership
-- brings it back, which is the same posture the unified GPT takes with a
-- persisted Artist selector: stale means inert, never gone.

-- ---------------------------------------------------------------------------
-- 1. Reading an inbox re-derives scope.
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
    and (p_status is null or n.status = p_status)
  order by n.scheduled_at desc, n.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.list_notifications(public.notification_status, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_notifications(public.notification_status, integer)
  to authenticated;

comment on function public.list_notifications(public.notification_status, integer) is
  'The signed-in profile''s own notifications, restricted to the artists and workspaces they currently hold. Revoking a membership hides its notifications without deleting them.';

-- ---------------------------------------------------------------------------
-- 2. Acting on one does too.
--
-- Marking a notification read only changes the recipient's own row, so this is
-- the smaller half. It matters anyway: a request that can still mutate a row it
-- can no longer read is a boundary with two different answers.
-- ---------------------------------------------------------------------------

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_updated integer;
begin
  update public.notifications n
  set status = 'read',
      read_at = coalesce(n.read_at, now()),
      delivered_at = coalesce(n.delivered_at, now())
  where n.id = p_notification_id
    and n.recipient_profile_id = auth.uid()
    and (n.artist_id is null or public.can_access_artist(n.artist_id))
    and (n.workspace_id is null or public.can_access_workspace(n.workspace_id))
    and n.status <> 'read';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_notification_read(uuid)
  to authenticated;

comment on function public.mark_notification_read(uuid) is
  'Marks one of the signed-in profile''s own notifications read. A notification whose artist or workspace the caller no longer holds cannot be marked, for the same reason it cannot be read.';
