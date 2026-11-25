-- Wake hints are an optional acceleration layer, never a replacement for the
-- durable integration_outbox, provider leases or existing cron recovery.
-- pg_net installation is an explicit infrastructure gate, not a side effect
-- of applying CRM migrations. Without it (including the local test shim),
-- the original scheduled processing is unchanged.

create or replace function crm_private.wake_booking_outbox()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,crm_private
as $$
declare
  v_lane text;
  v_key text;
  v_due_ms bigint;
  v_issued_ms bigint;
  v_signature text;
begin
  if new.status::text <> 'pending' then return new; end if;
  if new.kind::text in ('calendar_create','calendar_update','calendar_cancel') then
    v_lane := 'calendar';
    -- Match the connection-status RPC: only an enabled, exact artist route
    -- means a new pending job is queued. Truly disconnected artists retain
    -- not_connected. Preserve newer and terminal states.
    update public.sessions s
    set calendar_sync_status='queued'
    where s.id=new.session_id and s.artist_id=new.artist_id
      and s.calendar_sync_status='not_connected'
      and s.calendar_version::text=new.payload->>'calendar_version'
      and exists (
        select 1 from public.artist_integrations i
        join public.artists a on a.id=i.artist_id
        where i.artist_id=s.artist_id and i.is_enabled and a.is_active
          and i.integration_type='calendar' and i.provider='google'
          and i.integration_key='google_calendar_'||a.slug
      );
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
    if not exists (select 1 from pg_extension where extname='pg_net') then return new; end if;
    -- Hosted extension ownership can prevent REVOKE from taking effect.
    -- Do not activate until effective permissions have been verified.
    if has_table_privilege('anon','net.http_request_queue','SELECT')
       or has_table_privilege('authenticated','net.http_request_queue','SELECT')
       or has_schema_privilege('anon','net','USAGE')
       or has_schema_privilege('authenticated','net','USAGE') then
      return new;
    end if;
    select decrypted_secret into v_key from vault.decrypted_secrets
      where name='crm_outbox_wake_secret' limit 1;
    if v_key is null or v_key !~ '^[a-f0-9]{64}$' then return new; end if;
    v_due_ms := floor(extract(epoch from new.next_attempt_at)*1000)::bigint;
    v_issued_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
    -- Never store the long-lived secret in pg_net's request queue. The
    -- signature is short-lived and bound to a specific lane/due time.
    v_signature := encode(extensions.hmac(
      convert_to('v1:'||v_lane||':'||v_due_ms||':'||v_issued_ms,'UTF8'),
      decode(v_key,'hex'),'sha256'),'hex');
    -- Keep optional extension references out of static function resolution:
    -- local CI and inactive installations do not require pg_net.
    execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
      using 'https://outbox-wake.vishartattoo.com/internal/outbox/wake'::text,
        jsonb_build_object('lane',v_lane,'due_ms',v_due_ms,'issued_ms',v_issued_ms),
        jsonb_build_object('Content-Type','application/json','x-outbox-wake-signature',v_signature);
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
