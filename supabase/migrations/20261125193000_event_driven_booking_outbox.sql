-- Wake hints are an optional acceleration layer, never a replacement for the
-- durable integration_outbox, provider leases or existing cron recovery.
-- The vanilla PostgreSQL test harness lacks pg_net; leave it inert there.
do $$
begin
  if exists (select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net;
  end if;
end
$$;

create or replace function crm_private.wake_booking_outbox()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,crm_private
as $$
declare
  v_lane text;
  v_key text;
begin
  if new.status::text <> 'pending' then return new; end if;
  if new.kind::text in ('calendar_create','calendar_update','calendar_cancel') then
    v_lane := 'calendar';
    -- The presence of a durable job means queued, not a disconnected account.
    -- Preserve newer and terminal states; no provider identifiers are modified.
    update public.sessions s
    set calendar_sync_status='queued'
    where s.id=new.session_id and s.artist_id=new.artist_id
      and s.calendar_sync_status='not_connected'
      and s.calendar_version::text=new.payload->>'calendar_version';
  elsif new.dedupe_key like '%:booking_card:%' then
    v_lane := case new.kind::text
      when 'approved_email' then 'email'
      when 'whatsapp_message' then 'whatsapp'
      when 'instagram_message' then 'instagram'
      else null end;
  end if;
  if v_lane is null or new.next_attempt_at > now()+interval '5 minutes' then return new; end if;
  -- Vault secret is provisioned only after the production worker and queue
  -- pass readback. No secret in migrations, logs, job payload or responses.
  -- pg_net starts HTTP delivery only after this transaction commits.
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets
      where name='crm_outbox_wake_secret' limit 1;
    if v_key is null or v_key !~ '^[a-f0-9]{64}$' then return new; end if;
    perform net.http_post(
      url := 'https://outbox-wake.vishartattoo.com/internal/outbox/wake',
      body := jsonb_build_object('lane',v_lane,'due_at',new.next_attempt_at),
      headers := jsonb_build_object('Content-Type','application/json','x-outbox-wake-key',v_key),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- An optional wake cannot roll back a real booking. The scheduled drain
    -- will process the unchanged outbox row even on extension or network failure.
    raise warning 'outbox wake enqueue failed, sqlstate=%', sqlstate;
  end;
  return new;
end
$$;
revoke all on function crm_private.wake_booking_outbox() from public,anon,authenticated,service_role;

drop trigger if exists integration_outbox_wake_booking on public.integration_outbox;
create trigger integration_outbox_wake_booking
after insert on public.integration_outbox
for each row execute function crm_private.wake_booking_outbox();
