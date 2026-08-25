-- 0101_telegram_notification_entity_targets.sql
-- Preserve the entity target already attached to an internal notification when
-- the trusted Telegram connector leases it.
--
-- The existing RPC identity is intentionally retained. Its result gains two
-- nullable fields (`entity_type`, `entity_id`), which is backward-compatible
-- for the old Worker because it ignores unknown JSON properties. This keeps the
-- backend RPC allow-list unchanged and makes DB-first rollout safe.

-- PostgreSQL cannot change OUT columns with CREATE OR REPLACE, so replace the
-- function atomically inside this migration while preserving the same input
-- signature and service-role-only ACL.
drop function public.service_claim_telegram_notifications(text,integer,integer);

create function public.service_claim_telegram_notifications(
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
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
#variable_conflict use_column
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram notification leasing is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Telegram claim limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Telegram lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  -- Materialise only notifications created after the current destination was
  -- connected. Linking Telegram must never replay an old in-app backlog.
  insert into crm_private.telegram_notification_deliveries (
    notification_id, profile_id, destination_id, next_attempt_at
  )
  select n.id, n.recipient_profile_id, d.id, now()
  from public.notifications n
  join crm_private.telegram_destinations d
    on d.destination_kind = 'profile'
   and d.profile_id = n.recipient_profile_id
   and d.is_active
  join public.notification_preferences pref
    on pref.profile_id = n.recipient_profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where n.scheduled_at <= now()
    and n.created_at >= d.connected_at
    and crm_private.profile_can_receive_notification(
          n.recipient_profile_id, n.artist_id, n.workspace_id)
    and not exists (
      select 1
      from crm_private.telegram_notification_deliveries x
      where x.notification_id = n.id
    )
  on conflict (notification_id) do nothing;

  return query
  with candidates as (
    select x.id
    from crm_private.telegram_notification_deliveries x
    join public.notifications n on n.id = x.notification_id
    join crm_private.telegram_destinations d on d.id = x.destination_id
    join public.notification_preferences pref
      on pref.profile_id = x.profile_id
     and pref.channel = 'telegram'
     and pref.is_enabled
    where d.is_active
      and d.destination_kind = 'profile'
      and d.profile_id = x.profile_id
      and crm_private.profile_can_receive_notification(x.profile_id, n.artist_id, n.workspace_id)
      and (
        (x.status in ('pending', 'failed') and x.next_attempt_at <= now())
        or (x.status = 'leased' and x.lease_expires_at <= now())
      )
    order by x.next_attempt_at, x.id
    for update of x skip locked
    limit p_limit
  ),
  leased as (
    update crm_private.telegram_notification_deliveries x
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    where x.id in (select id from candidates)
    returning x.*
  )
  select
    l.id,
    n.id,
    l.profile_id,
    d.chat_id,
    n.title,
    n.body,
    n.priority,
    n.artist_id,
    n.workspace_id,
    n.entity_type,
    n.entity_id
  from leased l
  join public.notifications n on n.id = l.notification_id
  join crm_private.telegram_destinations d on d.id = l.destination_id
  order by l.leased_at, l.id;
end;
$$;

revoke all on function public.service_claim_telegram_notifications(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_claim_telegram_notifications(text,integer,integer)
  to service_role;
