-- 0101_telegram_notification_entity_targets.sql
-- Preserve the entity target already attached to an internal notification when
-- the trusted Telegram connector leases it. The existing v1 claim remains
-- intact as a rollback-compatible surface; v2 only enriches its leased result.

create or replace function public.service_claim_telegram_notifications_v2(
  p_worker_id text,
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  profile_id uuid,
  chat_id text,
  title text,
  body text,
  priority public.notification_priority,
  artist_id uuid,
  workspace_id uuid,
  entity_type text,
  entity_id uuid
)
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    c.delivery_id,
    c.notification_id,
    c.profile_id,
    c.chat_id,
    c.title,
    c.body,
    c.priority,
    c.artist_id,
    c.workspace_id,
    n.entity_type,
    n.entity_id
  from public.service_claim_telegram_notifications(
    p_worker_id,
    p_limit,
    p_lease_seconds
  ) c
  join public.notifications n on n.id = c.notification_id
  order by c.delivery_id;
$$;

revoke all on function public.service_claim_telegram_notifications_v2(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_claim_telegram_notifications_v2(text,integer,integer)
  to service_role;
