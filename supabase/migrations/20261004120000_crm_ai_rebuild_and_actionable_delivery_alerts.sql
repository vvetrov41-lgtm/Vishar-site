-- 20261004120000_crm_ai_rebuild_and_actionable_delivery_alerts.sql
--
-- Two independent problems found in production on 2026-10-04.
--
-- A. Integration delivery alerts ("Доставки интеграций требуют внимания").
--
--    No approved CRM email that belongs to an enquiry was ever sent. Production
--    history: 3 were approved (2026-09-16, 10-01, 10-04); one was cancelled by
--    the operator, the other two failed every attempt. approve_email_draft queued the outbox job with enquiry_id and
--    project_id NULL, while the email row carries them. The Gmail target
--    resolver requires both to match, so every attempt raised 22023 and the
--    Worker recorded gmail_rpc_failed (or gmail_email_job_invalid when a Gmail
--    thread was attached: the claim compares the thread's enquiry with NULL).
--    Eight deterministic retries later the job died and the daily sweep sent a
--    count-only Telegram alert, at most once per UTC day but over a rolling
--    24-hour window, so one failure late in the day alerted twice.
--
--    1. approve_email_draft queues the email's own enquiry and project.
--    2. Approved-email jobs that are still retryable are repaired in place.
--    3. gmail_email_job_invalid is a property of the CRM record, not of the
--       network: it now stops retrying at once instead of eight times.
--    4. The sweep sends one alert per failed delivery, ever: who, what, when,
--       attempts, the reason in words, that the CRM has stopped retrying and
--       what to do, with a deep link to the client. Deliveries that were sent
--       or withdrawn before the sweep, Telegram's own deliveries, contact sync
--       and ad conversions do not alert. AI job failures no longer alert at
--       all: there is nothing for the artist to do about them.
--
-- B. AI output in the artist's workflow.
--
--    The automatic client brief (Workers AI Llama 3.1 8B, written in Russian)
--    misplaced tattoos (shin -> side of the leg, whole arm -> shoulder),
--    mistranslated subjects (jaguar -> lambs), inverted a colour preference and
--    reported size disagreements that were not in the data. The intake
--    extraction duplicated the booking form and was shown nowhere; its 34
--    automatic drafts were all discarded.
--
--    5. The new-enquiry Telegram card is built from the form and the client's
--       own words only. It is no longer held for an AI brief.
--    6. Intake extraction is switched off (crm_private.enquiry_ai_config).
--    7. The internal brief that remains for the MCP plugin is written in
--       English, the language of the source messages, so it is no longer a
--       machine translation.
--
-- Nothing is deleted. Rollback: re-apply the previous function bodies and set
-- enquiry_ai_config.enabled = true.

-- ---------------------------------------------------------------------------
-- 1. Approved email keeps its enquiry and project in the outbox
-- ---------------------------------------------------------------------------

create or replace function crm_private.legacy_approve_email_draft(p_email_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_status public.email_message_status;
  v_client uuid;
  v_enquiry uuid;
  v_project uuid;
begin
  -- Approval is the human gate on anything personalised leaving the system.
  perform crm_private.require_role('owner');

  select m.status, m.client_id, m.enquiry_id, m.project_id
    into v_status, v_client, v_enquiry, v_project
  from public.email_messages m
  where m.id = p_email_message_id
  for update;

  if v_status is null then
    raise exception 'email message % does not exist', p_email_message_id using errcode = '23503';
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft may be approved (current status %)', v_status using errcode = '22023';
  end if;

  update public.email_messages m
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where m.id = p_email_message_id;

  -- The Gmail resolver binds the job to the email's enquiry and project; a
  -- job without them can never be sent.
  perform crm_private.enqueue_outbox(
    'approved_email', 'email:approved:' || p_email_message_id,
    jsonb_build_object('email_message_id', p_email_message_id),
    v_client, v_enquiry, v_project, null, p_email_message_id
  );

  perform crm_private.log_activity(
    'email.approved', 'owner', auth.uid(), v_client, v_enquiry, v_project, null, null, null, null, null,
    jsonb_build_object('email_message_id', p_email_message_id)
  );

  return jsonb_build_object('email_message_id', p_email_message_id, 'status', 'approved');
end;
$$;

revoke all on function crm_private.legacy_approve_email_draft(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Repair approved-email jobs that can still be retried
-- ---------------------------------------------------------------------------

update public.integration_outbox o
set enquiry_id = m.enquiry_id,
    project_id = m.project_id,
    updated_at = now()
from public.email_messages m
where o.kind = 'approved_email'::public.outbox_kind
  and o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
  and m.id = o.email_message_id
  and m.status = 'approved'::public.email_message_status
  and (o.enquiry_id is distinct from m.enquiry_id or o.project_id is distinct from m.project_id)
  and m.booking_card_id is null
  and m.payment_request_id is null;

-- ---------------------------------------------------------------------------
-- 3. A record the CRM cannot send stops retrying at once
-- ---------------------------------------------------------------------------

create or replace function public.record_email_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text := nullif(btrim(coalesce(p_provider_message_id, '')), '');
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox acknowledgement is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' or p_succeeded is null then
    raise exception 'valid email worker result is required' using errcode = '22023';
  end if;
  if p_succeeded and (v_provider_message_id is null or v_provider_message_id !~ '^[A-Za-z0-9_-]{4,255}$') then
    raise exception 'successful Gmail send requires a provider message id' using errcode = '22023';
  end if;
  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Gmail result requires a safe error code' using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
  for update;
  if not found then
    raise exception 'email outbox job is unavailable' using errcode = '22023';
  end if;

  if v_job.status = 'succeeded'::public.outbox_status and p_succeeded then
    return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_job.status, 'attempt_count', v_job.attempt_count, 'changed', false);
  end if;
  if v_job.status <> 'leased'::public.outbox_status or v_job.leased_by is distinct from p_worker_id then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when p_error_code = 'gmail_deposit_email_obsolete'
      and crm_private.gmail_deposit_email_obsolete(v_job.email_message_id)
      then 'dead'::public.outbox_status
    -- The claim found the CRM record itself unsendable (status, recipient,
    -- integration, card or thread). Retrying the same record cannot help.
    when p_error_code = 'gmail_email_job_invalid' then 'dead'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead'::public.outbox_status then o.next_attempt_at
        else now() + make_interval(secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600))
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  if p_succeeded then
    update public.email_messages m
    set status = 'sent'::public.email_message_status,
        sent_at = coalesce(m.sent_at, now()),
        failed_at = null,
        provider = 'google_gmail',
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        error_code = null,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.email_messages m
    set status = 'failed'::public.email_message_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  end if;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker', null,
    v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
    null, null, null, p_outbox_id,
    jsonb_build_object(
      'channel', 'email',
      'provider', 'google_gmail',
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'dead_letter', v_status = 'dead'::public.outbox_status
    )
  );

  return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_status, 'attempt_count', v_attempt_count, 'changed', true);
end;
$function$;

revoke all on function public.record_email_outbox_result(uuid, text, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_email_outbox_result(uuid, text, boolean, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. One actionable alert per failed delivery
-- ---------------------------------------------------------------------------

-- The reason, in words, from the stable error code. Unknown codes fall back to
-- a generic provider failure; the code itself is shown on its own line.
create or replace function crm_private.delivery_failure_reason(p_error_code text, p_language text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_error_code in ('gmail_rpc_failed', 'gmail_email_job_invalid', 'gmail_target_scope_invalid',
                          'gmail_email_route_changed', 'gmail_thread_subject_mismatch',
                          'gmail_thread_reply_context_invalid')
      then case when p_language = 'ru'
        then 'CRM не смогла подготовить письмо: данные письма не прошли проверку перед отправкой'
        else 'the CRM could not prepare the email: its record failed the pre-send check' end
    when p_error_code ~ '(forbidden|unauthori[sz]ed|oauth|token|scope|reconnect|revoked|invalid_grant)'
      then case when p_language = 'ru'
        then 'нет доступа к подключённому аккаунту (нужно переподключить)'
        else 'no access to the connected account (it needs reconnecting)' end
    when p_error_code ~ 'window'
      then case when p_language = 'ru'
        then 'закрыто 24-часовое окно WhatsApp: свободный текст отправить нельзя'
        else 'the 24-hour WhatsApp window is closed: free text cannot be sent' end
    when p_error_code ~ '(rate|quota|429)'
      then case when p_language = 'ru' then 'сервис ограничил частоту запросов' else 'the provider rate-limited the CRM' end
    else case when p_language = 'ru' then 'сервис доставки вернул ошибку' else 'the delivery provider returned an error' end
  end;
$$;

revoke all on function crm_private.delivery_failure_reason(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.service_sweep_operational_failure_alerts(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
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
      and coalesce(o.last_error_code, '') not in ('operator_cancelled', 'gmail_deposit_email_obsolete')
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
            then 'Клиент ничего не получил. Отправьте сообщение ещё раз из CRM или напишите клиенту напрямую.'
            else 'The client received nothing. Send it again from the CRM or contact the client directly.' end
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
$$;

revoke all on function public.service_sweep_operational_failure_alerts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_sweep_operational_failure_alerts(integer) to service_role;

comment on function public.service_sweep_operational_failure_alerts(integer) is
  'Backend-only. One alert per dead client-facing delivery (email, WhatsApp, Instagram, Calendar), deduplicated per job and recipient, with client, timing, attempts, reason, retry state and action. AI job failures do not alert.';

-- ---------------------------------------------------------------------------
-- 5. The new-enquiry Telegram card uses the form and the client's words only
-- ---------------------------------------------------------------------------

-- p_summary and p_brief are kept in the signature for callers and ignored.
create or replace function crm_private.enquiry_telegram_card(
  p_enquiry_id uuid,
  p_language text,
  p_summary text default null,
  p_brief jsonb default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_e public.enquiries%rowtype;
  v_files integer;
  v_ru boolean := p_language = 'ru';
  v_type text;
  v_cover text;
  v_idea text;
  v_lines text[] := array[]::text[];
begin
  select e.* into v_e from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    return null;
  end if;

  select count(*)::integer into v_files
  from public.enquiry_files f
  where f.enquiry_id = p_enquiry_id and f.upload_state = 'ready';

  v_type := crm_private.telegram_card_value(v_e.project_type, 80);
  if v_ru then
    v_type := case v_type
      when 'Colour realism' then 'Цветной реализм'
      when 'Black and grey realism' then 'Ч/б реализм'
      when 'Portrait' then 'Портрет'
      when 'Cover-up' then 'Перекрытие (кавер)'
      when 'Large-scale project / sleeve' then 'Крупный проект / рукав'
      when 'Not sure yet' then 'Пока не определился'
      else v_type
    end;
  end if;

  v_cover := crm_private.telegram_card_value(v_e.cover_up, 40);
  if v_ru then
    v_cover := case v_cover
      when 'No' then 'нет' when 'Yes' then 'да' when 'Not sure' then 'не уверен(а)'
      else v_cover end;
  end if;

  -- The client's own words. A long idea is cut, never paraphrased.
  v_idea := crm_private.telegram_card_value(v_e.idea, 280);

  v_lines := array_remove(array[
    case when v_type is not null then (case when v_ru then 'Тип: ' else 'Type: ' end) || v_type end,
    case when crm_private.telegram_card_value(v_e.placement) is not null
      then (case when v_ru then 'Место: ' else 'Placement: ' end) || crm_private.telegram_card_value(v_e.placement) end,
    case when crm_private.telegram_card_value(v_e.approximate_size, 120) is not null
      then (case when v_ru then 'Размер: ' else 'Size: ' end) || crm_private.telegram_card_value(v_e.approximate_size, 120) end,
    case when v_cover is not null then (case when v_ru then 'Кавер: ' else 'Cover-up: ' end) || v_cover end,
    case when crm_private.telegram_card_value(v_e.preferred_timing) is not null
      then (case when v_ru then 'Сроки: ' else 'Timing: ' end) || crm_private.telegram_card_value(v_e.preferred_timing) end,
    case when crm_private.telegram_card_value(v_e.submitted_travelling_from, 120) is not null
      then (case when v_ru then 'Откуда: ' else 'From: ' end) || crm_private.telegram_card_value(v_e.submitted_travelling_from, 120) end,
    case when v_files > 0 then (case when v_ru then 'Референсы: ' else 'References: ' end) || v_files end
  ], null);

  if v_idea is not null then
    v_lines := v_lines || ('' || E'\n' || (case when v_ru then 'Идея: ' else 'Idea: ' end) || v_idea);
  end if;

  if cardinality(v_lines) = 0 then
    return case when v_ru then 'Новая заявка получена.' else 'New enquiry received.' end;
  end if;
  return left(array_to_string(v_lines, E'\n'), 2000);
end;
$$;

revoke all on function crm_private.enquiry_telegram_card(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.service_route_telegram_enquiry_notification(
  p_outbox_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_client_id uuid;
  v_client_name text;
  v_file_count integer;
  v_notification_count integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram enquiry routing is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for update;

  if not found
     or v_job.status <> 'leased'
     or v_job.leased_by is distinct from p_worker_id
     or v_job.enquiry_id is null then
    raise exception 'Telegram enquiry outbox lease is unavailable' using errcode = '42501';
  end if;

  select e.client_id,
         left(c.full_name, 80),
         count(f.id)::integer
    into v_client_id, v_client_name, v_file_count
  from public.enquiries e
  join public.clients c on c.id = e.client_id
  left join public.enquiry_files f
    on f.enquiry_id = e.id and f.upload_state = 'ready'
  where e.id = v_job.enquiry_id
    and e.artist_id = v_job.artist_id
    and e.intake_state = 'complete'
  group by e.client_id, c.full_name;

  if not found or v_file_count < 1 or nullif(btrim(v_client_name), '') is null then
    raise exception 'Telegram enquiry projection is invalid' using errcode = '22023';
  end if;

  -- The card is complete from the form and goes out at once.
  insert into public.notifications (
    recipient_profile_id, artist_id, workspace_id,
    notification_type, title, body, entity_type, entity_id,
    priority, status, dedupe_key, scheduled_at, delivered_at
  )
  select
    am.profile_id,
    v_job.artist_id,
    a.workspace_id,
    'enquiry.created',
    crm_private.enquiry_telegram_title(v_client_name, crm_private.profile_language(am.profile_id)),
    crm_private.enquiry_telegram_card(v_job.enquiry_id, crm_private.profile_language(am.profile_id)),
    'enquiry',
    v_job.enquiry_id,
    'high',
    'delivered',
    'enquiry_created:' || v_job.enquiry_id::text || ':' || am.profile_id::text,
    now(),
    now()
  from public.artist_memberships am
  join public.artists a
    on a.id = am.artist_id and a.is_active
  where am.artist_id = v_job.artist_id
    and am.is_active
    and crm_private.telegram_notification_recipient_eligible(
      am.profile_id, v_job.artist_id, a.workspace_id
    )
  on conflict (dedupe_key) do nothing;

  select count(*)::integer into v_notification_count
  from public.notifications n
  where n.entity_type = 'enquiry'
    and n.entity_id = v_job.enquiry_id
    and n.notification_type = 'enquiry.created'
    and n.dedupe_key like 'enquiry_created:' || v_job.enquiry_id::text || ':%';

  if v_notification_count = 0 then
    return jsonb_build_object(
      'routed', false,
      'notification_count', 0,
      'error_code', 'telegram_destination_unavailable'
    );
  end if;

  return jsonb_build_object(
    'routed', true,
    'notification_count', v_notification_count,
    'error_code', null
  );
end;
$$;

revoke all on function public.service_route_telegram_enquiry_notification(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_route_telegram_enquiry_notification(uuid, text)
  to service_role;

-- A brief no longer rewrites a queued card.
drop trigger if exists client_ai_state_enrich_enquiry_notification
  on public.client_ai_state;

-- Cards already held for a brief go out now, as they are.
update public.notifications n
set scheduled_at = now(), updated_at = now()
where n.notification_type = 'enquiry.created'
  and n.scheduled_at > now()
  and not exists (
    select 1 from crm_private.telegram_notification_deliveries d where d.notification_id = n.id);

-- ---------------------------------------------------------------------------
-- 6. Intake extraction off
-- ---------------------------------------------------------------------------

update crm_private.enquiry_ai_config set enabled = false where singleton;

-- ---------------------------------------------------------------------------
-- 7. The internal brief stays in the language of the source messages
-- ---------------------------------------------------------------------------

-- Was: Russian when every artist-facing reader reads Russian. The Russian
-- brief was a machine translation by a small model and changed meaning. The
-- brief is no longer shown in the CRM or Telegram; its remaining reader (the
-- MCP plugin) translates on request with a stronger model.
create or replace function crm_private.artist_output_language(p_artist_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select 'en'::text;
$$;

revoke all on function crm_private.artist_output_language(uuid)
  from public, anon, authenticated, service_role;
