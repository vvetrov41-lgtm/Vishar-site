-- Instagram DM ingestion: finer webhook outcome evidence.
--
-- The first real production DMs after webhook subscription were delivered and
-- signed, but both events were counted only as `skipped`. The connector now
-- accepts Meta's alternate business-account id on the recipient/sender side
-- (`recipient_alias`) and records why an event is skipped, so a future drop
-- names its cause instead of needing a guess. Counts only, as before.

alter table crm_private.instagram_webhook_delivery_counters
  drop constraint if exists instagram_webhook_delivery_outcome_known;
alter table crm_private.instagram_webhook_delivery_counters
  add constraint instagram_webhook_delivery_outcome_known check (outcome in (
    'accepted', 'signature_invalid', 'rejected',
    'inbound', 'echo', 'read', 'ignored', 'skipped', 'unrouted', 'failed',
    'recipient_alias', 'skipped_ids', 'skipped_timestamp', 'skipped_read',
    'skipped_message', 'skipped_cross_account'
  ));

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
      'inbound', 'echo', 'read', 'ignored', 'skipped', 'unrouted', 'failed',
      'recipient_alias', 'skipped_ids', 'skipped_timestamp', 'skipped_read',
      'skipped_message', 'skipped_cross_account'
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
