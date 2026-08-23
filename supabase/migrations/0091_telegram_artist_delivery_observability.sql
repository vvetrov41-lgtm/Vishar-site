-- 0091_telegram_artist_delivery_observability.sql
--
-- Narrow server-only evidence for shared-bot Artist delivery. The existing
-- telegram_destinations.last_success_at / last_error_at columns already carry
-- personal delivery health, but Phase G Artist sends did not update them. That
-- made a successful legacy binding fallback indistinguishable from a successful
-- DB-registry send in production.
--
-- This RPC records health only for an active Artist registry destination and
-- only while the matching Telegram outbox row is leased by the same Worker.
-- It returns no chat id and creates no browser/GPT/MCP surface.

create or replace function public.service_record_telegram_artist_delivery_result(
  p_destination_id uuid,
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_destination crm_private.telegram_destinations%rowtype;
  v_outbox public.integration_outbox%rowtype;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram Artist delivery acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if p_destination_id is null or p_outbox_id is null then
    raise exception 'a Telegram destination and outbox row are required'
      using errcode = '22023';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;

  if p_succeeded is null then
    raise exception 'Telegram Artist delivery result is required' using errcode = '22023';
  end if;

  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Telegram Artist delivery requires a safe machine error code'
      using errcode = '22023';
  end if;

  select d.* into v_destination
  from crm_private.telegram_destinations d
  where d.id = p_destination_id
    and d.destination_kind = 'artist'
    and d.is_active
  for update;

  if not found then
    raise exception 'Telegram Artist destination is unavailable' using errcode = '22023';
  end if;

  select o.* into v_outbox
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for share;

  if not found then
    raise exception 'Telegram outbox row is unavailable' using errcode = '22023';
  end if;

  if v_outbox.artist_id is distinct from v_destination.artist_id then
    raise exception 'Telegram destination does not belong to the outbox Artist'
      using errcode = '42501';
  end if;

  if v_outbox.status <> 'leased' or v_outbox.leased_by is distinct from p_worker_id then
    raise exception 'Telegram outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  update crm_private.telegram_destinations d
  set last_success_at = case when p_succeeded then now() else d.last_success_at end,
      last_error_at = case when p_succeeded then d.last_error_at else now() end,
      updated_at = now()
  where d.id = v_destination.id;

  return jsonb_build_object(
    'destination_id', v_destination.id,
    'outbox_id', v_outbox.id,
    'delivery_path', 'registry',
    'succeeded', p_succeeded
  );
end;
$$;

revoke all on function public.service_record_telegram_artist_delivery_result(uuid,uuid,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_telegram_artist_delivery_result(uuid,uuid,text,boolean,text)
  to service_role;

comment on function public.service_record_telegram_artist_delivery_result(uuid,uuid,text,boolean,text) is
  'Records non-secret health evidence only when the shared Telegram bot used an active DB-backed Artist destination for the currently leased outbox row.';
