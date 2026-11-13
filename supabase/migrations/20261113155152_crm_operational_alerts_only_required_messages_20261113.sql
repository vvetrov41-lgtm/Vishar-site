CREATE OR REPLACE FUNCTION crm_private.lifecycle_notification_required(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $policy$
  -- Determine if a specific lifecycle message is expected under the active
  -- appointment schedule. Suppressed duplicate jobs are not incidents.
  SELECT COALESCE((
    SELECT CASE
      WHEN s.status IN ('cancelled','no_show') THEN false
      WHEN j.message_purpose='post_session_aftercare' THEN
        s.status='completed'
        AND s.id=(
          SELECT b.session_id
          FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.start_at,b.session_id LIMIT 1
        )
      WHEN j.message_purpose='post_session_checkin' THEN
        s.status='completed'
        AND s.id=(
          SELECT b.session_id
          FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.end_at DESC,b.session_id DESC LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM crm_private.session_lifecycle_block(s.id) b
          JOIN public.sessions bs ON bs.id=b.session_id
          WHERE bs.status<>'completed'
        )
      WHEN j.message_purpose IN ('session_reminder_24h','session_reminder_72h') THEN
        s.status='confirmed'
        AND s.id=(
          SELECT b.session_id FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.start_at,b.session_id LIMIT 1
        )
      WHEN j.message_purpose='consultation_reminder' THEN
        s.status='confirmed'
      ELSE true
    END
    FROM public.automation_jobs j
    JOIN public.sessions s ON s.id=j.session_id AND s.artist_id=j.artist_id
    WHERE j.id=p_job_id
      AND j.action_type='send_client_message'
      AND j.status IN ('pending','failed','completed')
  ), false);
$policy$;

CREATE OR REPLACE FUNCTION crm_private.alert_lifecycle_destination_failure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
begin
  if new.action_type <> 'send_client_message'::public.automation_action_type
     or new.status <> 'failed'::public.automation_job_status
     or old.status = 'failed'::public.automation_job_status
     or new.last_error_category not in ('destination_unavailable', 'integration_unavailable')
     or not crm_private.lifecycle_notification_required(new.id)
  then return new; end if;

  insert into public.notifications (
    recipient_profile_id, artist_id, notification_type, title, body,
    priority, status, dedupe_key, scheduled_at, delivered_at
  )
  select r.profile_id, new.artist_id, 'automation.lifecycle_destination_failed',
    'Automatic message needs attention',
    'An automatic client message could not be prepared because its destination or sending integration is unavailable. Review the booking and Automations for this artist.',
    'high', 'delivered',
    'lifecycle_destination:' || new.id::text || ':' || r.profile_id::text,
    now(), now()
  from crm_private.automation_notification_recipients(new.artist_id) r
  on conflict (dedupe_key) do nothing;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_sweep_lifecycle_failure_alerts(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_created integer;
  v_since timestamptz := now() - interval '24 hours';
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
begin
  if not crm_private.is_service_backend() then
    raise exception 'lifecycle failure alerts are backend-only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'alert limit must be between 1 and 100' using errcode = '22023';
  end if;

  with failures as (
    select j.id, j.artist_id, 'execution'::text as category
    from public.automation_jobs j
    where j.action_type = 'send_client_message'
      and j.status = 'failed'
      and crm_private.lifecycle_notification_required(j.id)
      and j.updated_at >= v_since
      and j.updated_at <= now()
    union all
    select j.id, j.artist_id, 'delivery'::text
    from public.automation_jobs j
    join public.email_messages em
      on em.automation_job_id = j.id and em.artist_id = j.artist_id
    where j.action_type = 'send_client_message'
      and j.status = 'completed'
      and crm_private.lifecycle_notification_required(j.id)
      -- A successful send or a deliberate cancellation overrides an old
      -- failed provider attempt. Retries of one job never count as three jobs.
      and em.status not in ('sent', 'cancelled')
      and (
        (em.status = 'failed' and em.updated_at between v_since and now())
        or exists (
          select 1 from public.integration_outbox io
          where io.kind = 'approved_email'
            and io.email_message_id = em.id
            and io.artist_id = j.artist_id
            and io.status in ('failed', 'dead')
            and io.updated_at between v_since and now()
        )
      )
  ), grouped as (
    select f.artist_id, f.category
    from failures f
    join crm_private.artist_state a on a.artist_id = f.artist_id and a.is_active
    where crm_private.automations_enabled_for_artist(f.artist_id)
    group by f.artist_id, f.category
    having count(distinct f.id) >= 3
  ), targeted as (
    select g.artist_id, g.category, r.profile_id,
      'lifecycle_failure:' || g.artist_id::text || ':' || g.category || ':'
        || v_day || ':' || r.profile_id::text as dedupe_key
    from grouped g
    cross join lateral crm_private.automation_notification_recipients(g.artist_id) r
  ), due as (
    select t.* from targeted t
    -- Filter before LIMIT so already-notified Artists cannot starve later ones.
    where not exists (select 1 from public.notifications n where n.dedupe_key = t.dedupe_key)
    order by t.artist_id, t.category, t.profile_id
    limit p_limit
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select d.profile_id, d.artist_id, 'automation.lifecycle_' || d.category || '_failed',
      case d.category when 'execution' then 'Automatic messages need attention'
        else 'Automatic email delivery needs attention' end,
      case d.category when 'execution'
        then 'At least 3 automatic messages could not be prepared in the last 24 hours. Open Automations for this artist and review the errors.'
        else 'At least 3 automatic emails have delivery errors from the last 24 hours. Open Automations for this artist and review delivery history.' end,
      'high', 'delivered', d.dedupe_key, now(), now()
    from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;
  return v_created + crm_private.notify_missed_aftercare_jobs(p_limit);
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_sweep_operational_failure_alerts(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_created integer;
  v_since timestamptz := now() - interval '24 hours';
begin
  if not crm_private.is_service_backend() then
    raise exception 'operational failure alerts are backend-only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'alert limit must be between 1 and 100' using errcode = '22023';
  end if;

  with failures as (
    select o.id as outbox_id, o.artist_id, o.kind::text as kind, o.client_id, o.enquiry_id,
           o.session_id, o.attempt_count, coalesce(o.last_error_code, 'unknown_error') as error_code,
           o.created_at, o.updated_at, left(btrim(c.full_name), 80) as client_name
    from public.integration_outbox o
    join crm_private.artist_state a on a.artist_id = o.artist_id and a.is_active
    left join public.clients c on c.id = o.client_id
    where o.status = 'dead'
      and o.updated_at between v_since and now()
      and o.kind::text in (
        'approved_email', 'transactional_email', 'whatsapp_message', 'instagram_message',
        'calendar_create', 'calendar_update', 'calendar_cancel',
        'calendar_availability_create', 'calendar_availability_update', 'calendar_availability_cancel')
      and coalesce(o.last_error_code, '') not in (
        'operator_cancelled','gmail_deposit_email_obsolete',
        'booking_card_superseded','gmail_lifecycle_email_obsolete',
        'whatsapp_lifecycle_obsolete','instagram_lifecycle_obsolete'
      )
      -- Client lifecycle jobs are actionable only if their message was required.
      and not exists (
        select 1 from public.email_messages lm
        where lm.id=o.email_message_id
          and lm.automation_job_id is not null
          and not crm_private.lifecycle_notification_required(lm.automation_job_id)
      )
      and not exists (
        select 1 from crm_private.lifecycle_whatsapp_payloads wp
        where wp.communication_message_id=o.communication_message_id
          and not crm_private.lifecycle_notification_required(wp.automation_job_id)
      )
      and not exists (
        select 1 from crm_private.lifecycle_instagram_payloads ip
        where ip.communication_message_id=o.communication_message_id
          and not crm_private.lifecycle_notification_required(ip.automation_job_id)
      )
      -- An already delivered WhatsApp/Instagram message is not a failure.
      and not exists (
        select 1 from public.communication_messages cm
        where cm.id=o.communication_message_id
          and cm.status::text in ('sent','delivered','read','cancelled')
      )
      -- Sent or withdrawn before the sweep ran: nothing to report.
      and not exists (
        select 1 from public.email_messages m
        where m.id = o.email_message_id
          and m.status in ('sent'::public.email_message_status, 'cancelled'::public.email_message_status))
  ), targeted as (
    select f.*, r.profile_id, crm_private.profile_language(r.profile_id) as lang,
      'delivery_failed:' || f.outbox_id::text || ':' || r.profile_id::text as dedupe_key
    from failures f
    cross join lateral crm_private.automation_notification_recipients(f.artist_id) r
  ), due as (
    select t.* from targeted t
    where not exists (select 1 from public.notifications n where n.dedupe_key = t.dedupe_key)
    order by t.updated_at, t.outbox_id, t.profile_id
    limit p_limit
  ), worded as (
    select d.*,
      case
        when d.kind in ('approved_email', 'transactional_email') then
          case when d.lang = 'ru' then 'Письмо клиенту не отправлено' else 'Email to client not sent' end
        when d.kind = 'whatsapp_message' then
          case when d.lang = 'ru' then 'WhatsApp клиенту не отправлен' else 'WhatsApp to client not sent' end
        when d.kind = 'instagram_message' then
          case when d.lang = 'ru' then 'Instagram клиенту не отправлен' else 'Instagram message to client not sent' end
        else
          case when d.lang = 'ru' then 'Запись не синхронизирована с Google Календарём'
               else 'Appointment not synced to Google Calendar' end
      end as headline,
      case
        when d.kind in ('approved_email', 'transactional_email', 'whatsapp_message', 'instagram_message') then
          case when d.lang = 'ru'
            then 'Доставка не подтверждена. Проверьте статус сообщения у провайдера, затем при необходимости свяжитесь с клиентом.'
            else 'Delivery is not confirmed. Check the provider message status before deciding whether to contact the client.' end
        else
          case when d.lang = 'ru'
            then 'Проверьте запись в Google Календаре и подключение календаря в CRM.'
            else 'Check the event in Google Calendar and the calendar connection in the CRM.' end
      end as action_text
    from due d
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select w.profile_id, w.artist_id, 'system.integration_delivery_failed',
      left(w.headline || coalesce(': ' || nullif(w.client_name, ''), ''), 200),
      left(array_to_string(array_remove(array[
        case when w.client_name is not null
          then (case when w.lang = 'ru' then 'Клиент: ' else 'Client: ' end) || w.client_name end,
        (case when w.lang = 'ru' then 'Создано: ' else 'Queued: ' end)
          || to_char(w.created_at at time zone 'Europe/London', 'DD.MM HH24:MI'),
        (case when w.lang = 'ru' then 'Попыток: ' else 'Attempts: ' end) || w.attempt_count
          || (case when w.lang = 'ru' then ', последняя ' else ', last at ' end)
          || to_char(w.updated_at at time zone 'Europe/London', 'DD.MM HH24:MI'),
        (case when w.lang = 'ru' then 'Причина: ' else 'Reason: ' end)
          || crm_private.delivery_failure_reason(w.error_code, w.lang),
        case when w.lang = 'ru' then 'CRM больше не будет повторять попытки.'
             else 'The CRM will not retry it again.' end,
        w.action_text,
        (case when w.lang = 'ru' then 'Код: ' else 'Code: ' end) || w.error_code
      ], null), E'\n'), 2000),
      case when w.client_id is not null then 'client' when w.enquiry_id is not null then 'enquiry'
           when w.session_id is not null then 'session' end,
      coalesce(w.client_id, w.enquiry_id, w.session_id),
      'high', 'delivered', w.dedupe_key, now(), now()
    from worded w
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;
  return v_created;
end;
$function$;

REVOKE ALL ON FUNCTION crm_private.lifecycle_notification_required(uuid) FROM PUBLIC;

COMMENT ON FUNCTION crm_private.lifecycle_notification_required(uuid) IS
'CRM operational alerts: notify only for lifecycle messages required under the current consecutive-session block. One aftercare guide after first session, no intermediate guides, one check-in 24h after last session. Ignore deliberate suppressions, cancellations, superseded provider messages and already delivered messages. Real destination/integration failures are alerted per job, final outbox failures per item, and general lifecycle incidents when >=3 distinct failures in 24 hours (daily dedupe). Do not advise replay of uncertain provider sends.';
