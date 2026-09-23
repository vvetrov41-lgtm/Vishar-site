-- Instagram DM ingestion: webhook subscription state and delivery evidence.
--
-- Production had two connected Instagram accounts and zero Instagram messages.
-- The connector never enabled webhook delivery for the connected accounts:
-- with Instagram API with Instagram Login, subscribing the app to fields in the
-- App Dashboard is not enough, and each account must also be enabled with
-- `POST /me/subscribed_apps?subscribed_fields=...` using that account's token.
-- Nothing recorded whether that had happened, and a webhook delivery that
-- failed its signature or resolved no route left no trace outside Worker logs.
--
-- This migration adds the backend-only state the connector needs to repair and
-- prove that path:
--   * subscription state per integration, kept in the existing non-secret
--     `artist_integrations.configuration` (fields, checked time, error code);
--   * the list of enabled Instagram routes the maintenance pass walks;
--   * hourly delivery counters by outcome, holding no payload, no account id
--     and no message content.
--
-- Every function is callable only by the service backend. The counters are
-- readable only by the owner through a narrow health RPC.

create table if not exists crm_private.instagram_webhook_delivery_counters (
  bucket_hour timestamptz not null,
  outcome     text not null,
  count       bigint not null default 0,
  last_at     timestamptz not null default now(),
  primary key (bucket_hour, outcome),
  constraint instagram_webhook_delivery_outcome_known check (outcome in (
    'accepted', 'signature_invalid', 'rejected',
    'inbound', 'echo', 'read', 'ignored', 'skipped', 'unrouted', 'failed'
  )),
  constraint instagram_webhook_delivery_count_positive check (count >= 0)
);

comment on table crm_private.instagram_webhook_delivery_counters is
  'Hourly counts of Instagram webhook delivery outcomes. No payload, account id, participant id or message content is stored.';

revoke all on crm_private.instagram_webhook_delivery_counters
  from public, anon, authenticated, service_role;

create or replace function public.service_record_instagram_webhook_delivery(
  p_counts jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_key text;
  v_value jsonb;
  v_count integer;
  v_bucket timestamptz := date_trunc('hour', now());
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram webhook evidence is backend-only' using errcode = '42501';
  end if;
  if p_counts is null or jsonb_typeof(p_counts) <> 'object' then
    raise exception 'delivery counts are required' using errcode = '22023';
  end if;

  for v_key, v_value in select * from jsonb_each(p_counts) loop
    if v_key not in (
      'accepted', 'signature_invalid', 'rejected',
      'inbound', 'echo', 'read', 'ignored', 'skipped', 'unrouted', 'failed'
    ) then
      raise exception 'unknown Instagram webhook outcome' using errcode = '22023';
    end if;
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'delivery counts must be numbers' using errcode = '22023';
    end if;
    v_count := (v_value #>> '{}')::numeric::integer;
    if v_count < 0 or v_count > 1000 then
      raise exception 'delivery count out of range' using errcode = '22023';
    end if;
    continue when v_count = 0;

    insert into crm_private.instagram_webhook_delivery_counters as c
      (bucket_hour, outcome, count, last_at)
    values (v_bucket, v_key, v_count, now())
    on conflict (bucket_hour, outcome)
    do update set count = c.count + excluded.count, last_at = excluded.last_at;
  end loop;
end;
$$;

revoke all on function public.service_record_instagram_webhook_delivery(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_instagram_webhook_delivery(jsonb)
  to service_role;

comment on function public.service_record_instagram_webhook_delivery(jsonb) is
  'Backend-only: adds Instagram webhook outcome counts to the current hour. Counts only; nothing identifying.';

create or replace function public.service_list_instagram_maintenance_targets()
returns table (
  artist_id uuid,
  integration_key text,
  instagram_user_id text,
  webhook_subscription_checked_at timestamptz,
  webhook_subscription_error text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram maintenance is backend-only' using errcode = '42501';
  end if;

  return query
  select i.artist_id,
         i.integration_key,
         i.configuration ->> 'instagram_user_id',
         case
           when coalesce(i.configuration ->> 'webhook_subscription_checked_at', '')
                ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           then (i.configuration ->> 'webhook_subscription_checked_at')::timestamptz
         end,
         nullif(i.configuration ->> 'webhook_subscription_error', '')
  from public.artist_integrations i
  join crm_private.artist_state a on a.artist_id = i.artist_id and a.is_active
  where i.integration_type = 'instagram'::public.artist_integration_type
    and i.provider = 'instagram_login'
    and i.is_enabled
    and coalesce(i.configuration ->> 'instagram_user_id', '') ~ '^[0-9]{5,40}$'
  order by i.artist_id, i.integration_key;
end;
$$;

revoke all on function public.service_list_instagram_maintenance_targets()
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_instagram_maintenance_targets()
  to service_role;

comment on function public.service_list_instagram_maintenance_targets() is
  'Backend-only: enabled Instagram Login routes and their last webhook subscription check, for the connector maintenance pass.';

create or replace function public.service_record_instagram_webhook_subscription(
  p_artist_id uuid,
  p_integration_key text,
  p_subscribed_fields text[],
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_fields text[] := coalesce(p_subscribed_fields, array[]::text[]);
  v_updated integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram integration management is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null
     or coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a valid Instagram route is required' using errcode = '22023';
  end if;
  if coalesce(array_length(v_fields, 1), 0) > 16 or exists (
    select 1 from unnest(v_fields) f(field) where f.field !~ '^[a-z][a-z0-9_]{1,63}$'
  ) then
    raise exception 'subscribed fields are not in the expected form' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'error code is not in the expected form' using errcode = '22023';
  end if;

  update public.artist_integrations i
  set configuration = coalesce(i.configuration, '{}'::jsonb)
        || jsonb_build_object(
             'webhook_subscribed_fields', to_jsonb(v_fields),
             'webhook_subscription_checked_at',
               to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'webhook_subscription_error', coalesce(p_error_code, '')
           ),
      updated_at = now()
  where i.artist_id = p_artist_id
    and i.integration_key = p_integration_key
    and i.integration_type = 'instagram'::public.artist_integration_type
    and i.provider = 'instagram_login';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'Instagram route is unavailable' using errcode = '23503';
  end if;

  return jsonb_build_object(
    'subscribed_fields', to_jsonb(v_fields),
    'error_code', p_error_code
  );
end;
$$;

revoke all on function public.service_record_instagram_webhook_subscription(uuid, text, text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_instagram_webhook_subscription(uuid, text, text[], text)
  to service_role;

comment on function public.service_record_instagram_webhook_subscription(uuid, text, text[], text) is
  'Backend-only: records which webhook fields Meta reports as enabled for an Instagram account, and the last subscription error code.';

create or replace function public.get_instagram_webhook_health(
  p_hours integer default 72
)
returns table (
  bucket_hour timestamptz,
  outcome text,
  count bigint,
  last_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner');
  if p_hours is null or p_hours < 1 or p_hours > 720 then
    raise exception 'hours must be between 1 and 720' using errcode = '22023';
  end if;

  return query
  select c.bucket_hour, c.outcome, c.count, c.last_at
  from crm_private.instagram_webhook_delivery_counters c
  where c.bucket_hour >= date_trunc('hour', now()) - make_interval(hours => p_hours)
  order by c.bucket_hour desc, c.outcome;
end;
$$;

revoke all on function public.get_instagram_webhook_health(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_instagram_webhook_health(integer)
  to authenticated;

comment on function public.get_instagram_webhook_health(integer) is
  'Owner-only: hourly Instagram webhook delivery outcomes, to tell "Meta never delivered" from "delivered but rejected or unrouted".';
