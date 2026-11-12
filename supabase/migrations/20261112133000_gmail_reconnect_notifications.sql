-- Surface revoked Google Gmail authorization to the affected artist.
-- No provider request, token access, client message, or historical replay.
-- The existing Gmail Worker remains the authority on invalid_grant.
--
-- Transition-only trigger: a manual disconnect has no revoked-token alert.
-- Successful OAuth reconnection dismisses its previous alert.

create or replace function crm_private.handle_gmail_authorization_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_recipient uuid;
  v_event_key text;
begin
  if new.integration_type <> 'email'::public.artist_integration_type
     or new.provider <> 'google'
     or old.is_enabled is not distinct from new.is_enabled then
    return new;
  end if;

  if old.is_enabled and not new.is_enabled
     and new.configuration ->> 'disabled_reason' = 'gmail_refresh_token_revoked' then
    -- The existing service_disable_gmail_integration RPC only wrote a safe
    -- configuration reason; expose the authorization failure in status metadata.
    update public.artist_integrations i
    set last_error_at = now(),
        last_error_category = 'permission_revoked'::public.integration_error_category
    where i.id = new.id
      and i.is_enabled = false;

    -- Never prevent a token-revocation state update if notification delivery
    -- fails; the client must still see the disabled Gmail state.
    begin
      v_event_key := 'gmail_reconnect:' || new.id::text || ':'
        || to_char(new.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
      for v_recipient in
        select r.profile_id
        from crm_private.artist_notification_recipients(new.artist_id) r
      loop
        insert into public.notifications (
          recipient_profile_id, artist_id, notification_type, title, body,
          entity_type, entity_id, priority, status, dedupe_key,
          scheduled_at, delivered_at
        ) values (
          v_recipient, new.artist_id, 'system.google_reconnect_required',
          case when crm_private.profile_language(v_recipient) = 'ru'
            then 'Gmail отключён: переподключи Google'
            else 'Gmail disconnected: reconnect Google' end,
          case when crm_private.profile_language(v_recipient) = 'ru'
            then 'Доступ Google к Gmail был отозван. Открой «Интеграции» и нажми «Переподключить Gmail».'
            else 'Google Gmail authorization was revoked. Open Integrations and select Reconnect Gmail.' end,
          'integration', new.id, 'high', 'delivered',
          v_event_key || ':' || v_recipient::text, now(), now()
        )
        on conflict (dedupe_key) do nothing;
      end loop;
    exception when others then
      raise warning 'gmail reconnect notification failed for integration % (SQLSTATE %)', new.id, sqlstate;
    end;

  elsif not old.is_enabled and new.is_enabled then
    -- A successful verified OAuth binding is the only recovery signal.
    update public.artist_integrations i
    set last_error_at = null,
        last_error_category = 'none'::public.integration_error_category
    where i.id = new.id
      and (i.last_error_at is not null
        or i.last_error_category <> 'none'::public.integration_error_category);

    update public.notifications n
    set status = 'dismissed'
    where n.artist_id = new.artist_id
      and n.entity_type = 'integration'
      and n.entity_id = new.id
      and n.notification_type = 'system.google_reconnect_required'
      and n.status <> 'dismissed';
  end if;

  return new;
end;
$function$;

revoke all on function crm_private.handle_gmail_authorization_transition()
  from public, anon, authenticated, service_role;

drop trigger if exists artist_integrations_gmail_auth_transition on public.artist_integrations;
create trigger artist_integrations_gmail_auth_transition
after update of is_enabled on public.artist_integrations
for each row
when (old.is_enabled is distinct from new.is_enabled)
execute function crm_private.handle_gmail_authorization_transition();

comment on function crm_private.handle_gmail_authorization_transition() is
  'On Gmail invalid_grant create one personal in-app reconnection notice per active artist-facing recipient; after successful verified OAuth dismiss it. No credentials or provider calls.';
