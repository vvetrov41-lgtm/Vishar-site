-- Profile-scoped ChatGPT Plugin OAuth diagnostics and in-app reconnection notice.
-- No call to ChatGPT, token rotation, provider send, client data, or auth-schema mutation.
-- A quiet connector is never classified as disconnected merely for being idle.
-- If the failure occurs entirely inside ChatGPT, no Supabase record can prove it;
-- the UI must describe the returned state as OAuth evidence, not a live MCP probe.

create or replace function crm_private.chatgpt_plugin_auth_state(
  p_was_authorized boolean,
  p_has_consent boolean,
  p_has_usable_session boolean
)
returns text
language sql
immutable
set search_path = pg_catalog
as $function$
  select case
    when not coalesce(p_was_authorized, false) then 'not_configured'
    when not coalesce(p_has_consent, false)
      or not coalesce(p_has_usable_session, false) then 'reconnect_required'
    else 'authorization_present'
  end;
$function$;

revoke all on function crm_private.chatgpt_plugin_auth_state(boolean, boolean, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.refresh_my_chatgpt_plugin_auth_status()
returns table (connection_state text, last_oauth_refresh_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_profile_id uuid := auth.uid();
  v_client_id uuid;
  v_client_count integer;
  v_had_consent boolean := false;
  v_active_consent boolean := false;
  v_had_session boolean := false;
  v_usable_session boolean := false;
  v_last_refresh timestamptz;
  v_state text;
  v_language text;
begin
  if v_profile_id is null or not public.is_active_user() then
    raise exception 'CRM access required' using errcode = '42501';
  end if;

  -- The dedicated, manual, public OAuth client is not the older artist-bound GPT.
  -- Ambiguous/removed client metadata cannot justify a reconnect warning.
  select count(*)::integer, min(c.id::text)::uuid
    into v_client_count, v_client_id
    from auth.oauth_clients c
   where c.client_name = 'Vishar CRM ChatGPT Plugin'
     and c.deleted_at is null
     and c.client_type::text = 'public'
     and c.token_endpoint_auth_method = 'none';

  if v_client_count <> 1 then
    return query select 'unknown'::text, null::timestamptz;
    return;
  end if;

  select count(*) > 0, count(*) filter (where o.revoked_at is null) > 0
    into v_had_consent, v_active_consent
    from auth.oauth_consents o
   where o.client_id = v_client_id
     and o.user_id = v_profile_id;

  select count(*) > 0,
         coalesce(bool_or(
           (s.not_after is null or s.not_after > now())
           and exists (
             select 1 from auth.refresh_tokens rt
              where rt.session_id = s.id
                and rt.revoked = false
           )
         ), false),
         max(coalesce(s.refreshed_at::timestamptz, s.created_at))
    into v_had_session, v_usable_session, v_last_refresh
    from auth.sessions s
   where s.oauth_client_id = v_client_id
     and s.user_id = v_profile_id;

  v_state := crm_private.chatgpt_plugin_auth_state(
    v_had_consent or v_had_session, v_active_consent, v_usable_session
  );

  if v_state = 'reconnect_required' then
    v_language := crm_private.profile_language(v_profile_id);
    -- A single personal in-app notice, never sent to clients or external channels.
    -- Marking it read prevents repeats. After verified recovery a later incident
    -- can reactivate the same dedupe key, but only after it was dismissed.
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    ) values (
      v_profile_id, null, 'system.chatgpt_reconnect_required',
      case when v_language = 'ru'
        then 'ChatGPT: проверь подключение Vishar CRM'
        else 'ChatGPT: check your Vishar CRM connection' end,
      case when v_language = 'ru'
        then 'OAuth-авторизация плагина больше не подтверждается. Открой ChatGPT → Настройки → Плагины → Vishar CRM и переподключи. Отсутствие активности само по себе не считается сбоем.'
        else 'The Plugin OAuth authorization is no longer valid. Open ChatGPT Settings → Plugins → Vishar CRM and reconnect. Inactivity alone is not an error.' end,
      null, null, 'high', 'delivered',
      'chatgpt_plugin_reconnect:' || v_profile_id::text,
      now(), now()
    )
    on conflict (dedupe_key) do update
       set title = excluded.title,
           body = excluded.body,
           status = 'delivered',
           read_at = null,
           delivered_at = now(),
           scheduled_at = now()
     where public.notifications.status = 'dismissed';
  elsif v_state = 'authorization_present' then
    -- Only an OAuth session with a currently unrevoked refresh token counts
    -- as recovery. This does not claim that ChatGPT has recently called MCP.
    update public.notifications n
       set status = 'dismissed'
     where n.recipient_profile_id = v_profile_id
       and n.notification_type = 'system.chatgpt_reconnect_required'
       and n.status <> 'dismissed';
  end if;

  return query select v_state, v_last_refresh;
end;
$function$;

revoke all on function public.refresh_my_chatgpt_plugin_auth_status()
  from public, anon, service_role;
grant execute on function public.refresh_my_chatgpt_plugin_auth_status()
  to authenticated;

comment on function public.refresh_my_chatgpt_plugin_auth_status() is
  'Checks only the current active CRM profile against the dedicated Plugin OAuth consent and unrevoked session; idempotently maintains one personal in-app warning on definitive loss. A successful status means stored authorization exists, not a live ChatGPT MCP check.';
