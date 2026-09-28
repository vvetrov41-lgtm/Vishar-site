-- 20260928150000_profile_language_localized_notifications.sql
--
-- A Russian-speaking artist received English system text: "New enquiry",
-- "AI summary", "Needs you", "Suggested next step", failure alerts and
-- appointment responses were written in English by the database, and the
-- model wrote summaries and reasons in English because nothing told it the
-- reader's language. The CRM language lived only in the browser.
--
-- 1. profiles.ui_language ('en' | 'ru'), set by the CRM through
--    set_my_ui_language() whenever the interface language changes.
-- 2. One BEFORE INSERT/UPDATE trigger localises the known system templates
--    of public.notifications into the recipient's language. Producers keep
--    writing their canonical English template; nothing else about them
--    changes. Text a person or the model wrote is never translated here.
-- 3. The Telegram claim returns the recipient's language (for the
--    "Open in CRM" line) and never pushes a dismissed row.
-- 4. service_telegram_chat_language() lets the digest and /today replies
--    use the linked profile's language.
-- 5. client_ai_context() carries artist.output_language: the language the
--    artist-facing recipients read, used by the Worker to have the model
--    write the internal summary and reason in that language. The watermark
--    does not read the context, so no brief goes stale because of this.
-- No external translation service is involved. Enum values and action types
-- stay English inside the system.

-- ---------------------------------------------------------------------------
-- 1. Profile language
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists ui_language text not null default 'en'
    check (ui_language in ('en', 'ru'));

comment on column public.profiles.ui_language is
  'Language the person uses the CRM in. Server-written notifications, Telegram pushes and AI internal notes for this person follow it.';

create or replace function public.set_my_ui_language(p_language text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'sign in to change the language' using errcode = '42501';
  end if;
  if p_language is null or p_language not in ('en', 'ru') then
    raise exception 'language must be en or ru' using errcode = '22023';
  end if;

  update public.profiles p
  set ui_language = p_language
  where p.id = auth.uid()
    and p.ui_language is distinct from p_language;

  return p_language;
end;
$$;

revoke all on function public.set_my_ui_language(text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_my_ui_language(text) to authenticated;

comment on function public.set_my_ui_language(text) is
  'Records the signed-in profile''s CRM language (en or ru). Idempotent.';

create or replace function crm_private.profile_language(p_profile_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce((select p.ui_language from public.profiles p where p.id = p_profile_id), 'en');
$$;

revoke all on function crm_private.profile_language(uuid)
  from public, anon, authenticated, service_role;

-- The language of an artist's internal notes: Russian when every artist-facing
-- recipient reads Russian, otherwise English (the neutral choice when readers
-- disagree).
create or replace function crm_private.artist_output_language(p_artist_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when count(*) > 0 and bool_and(crm_private.profile_language(r.profile_id) = 'ru') then 'ru'
    else 'en'
  end
  from crm_private.artist_notification_recipients(p_artist_id) r;
$$;

revoke all on function crm_private.artist_output_language(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Localised system templates
-- ---------------------------------------------------------------------------

create or replace function crm_private.client_ai_action_label(p_action_type text, p_language text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case when p_language = 'ru' then
    case p_action_type
      when 'request_information' then 'Запросить у клиента недостающие детали'
      when 'artist_review' then 'Нужна ваша проверка'
      when 'prepare_quote' then 'Подготовить оценку стоимости'
      when 'offer_dates' then 'Предложить даты'
      when 'request_deposit' then 'Запросить депозит'
      when 'confirm_booking' then 'Подтвердить запись'
      when 'follow_up' then 'Напомнить о себе'
      when 'await_client' then 'Ждём ответа клиента'
      when 'no_action' then 'Действий не требуется'
      else 'Нужна ваша проверка'
    end
  else p_action_type end;
$$;

revoke all on function crm_private.client_ai_action_label(text, text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.localize_notification_copy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_lines text[];
  v_count text;
  v_disclaimer constant text := 'This is a suggestion for your review. Nothing has been sent to the client.';
begin
  if crm_private.profile_language(new.recipient_profile_id) <> 'ru' then
    return new;
  end if;

  if new.notification_type = 'enquiry.created' then
    if new.title like 'New enquiry: %' then
      new.title := left('Новая заявка: ' || substr(new.title, 14), 200);
    end if;
    if new.body = 'New enquiry received.' then
      new.body := 'Новая заявка получена.';
    elsif new.body = 'New enquiry received. AI summary is being prepared.' then
      new.body := 'Новая заявка получена. AI-сводка готовится.';
    elsif new.body like 'AI summary:' || E'\n' || '%' then
      new.body := left('AI-сводка:' || E'\n' || substr(new.body, 13), 2000);
    end if;

  elsif new.notification_type = 'client_ai.next_action' then
    if new.title like 'Needs you: %' then
      new.title := left('Нужно ваше решение: ' || substr(new.title, 12), 200);
    end if;
    if new.body like 'Suggested next step: %' then
      v_lines := string_to_array(new.body, E'\n');
      v_lines[1] := 'Предлагаемый шаг: '
        || crm_private.client_ai_action_label(substr(v_lines[1], 22), 'ru');
      if v_lines[array_length(v_lines, 1)] = v_disclaimer then
        v_lines[array_length(v_lines, 1)] :=
          'Это подсказка для вашей проверки. Клиенту ничего не отправлено.';
      end if;
      new.body := left(array_to_string(v_lines, E'\n'), 2000);
    end if;

  elsif new.notification_type = 'system.ai_processing_failed' then
    if new.title = 'AI processing needs attention' then
      new.title := 'AI-обработка требует внимания';
    end if;
    v_count := substring(new.body from '^([0-9]+) AI summaries could not be produced in the last 24 hours\.');
    if v_count is not null then
      new.body := 'За последние 24 часа не удалось подготовить AI-сводки: ' || v_count
        || '. Заявки сохранены — откройте их, чтобы разобрать вручную или повторить AI.';
    end if;

  elsif new.notification_type = 'system.integration_delivery_failed' then
    if new.title = 'Integration deliveries need attention' then
      new.title := 'Доставки интеграций требуют внимания';
    end if;
    v_count := substring(new.body from '^([0-9]+) notification, calendar or message deliveries stopped retrying in the last 24 hours\.');
    if v_count is not null then
      new.body := 'За последние 24 часа прекратились повторные попытки доставки уведомлений, календаря или сообщений: '
        || v_count || '. Откройте «Журнал» этого мастера и проверьте ошибки.';
    end if;

  elsif new.notification_type = 'automation.lifecycle_execution_failed' then
    if new.title = 'Automatic messages need attention' then
      new.title := 'Не удалось подготовить автоматические сообщения';
      new.body := 'За последние 24 часа не удалось подготовить как минимум 3 автоматических сообщения. Откройте «Автоматизации» этого мастера и проверьте ошибки.';
    end if;

  elsif new.notification_type = 'automation.lifecycle_delivery_failed' then
    if new.title = 'Automatic email delivery needs attention' then
      new.title := 'Ошибки доставки автоматических писем';
      new.body := 'За последние 24 часа ошибки доставки затронули как минимум 3 автоматических письма. Откройте «Автоматизации» этого мастера и проверьте историю отправок.';
    end if;

  elsif new.notification_type = 'appointment.attendance_confirmed' then
    if new.title = 'Client confirmed attendance' then
      new.title := 'Клиент подтвердил визит';
      new.body := 'Клиент подтвердил, что придёт на эту запись.';
    end if;

  elsif new.notification_type = 'appointment.reschedule_requested' then
    if new.title = 'Client requested a reschedule' then
      new.title := 'Клиент просит перенести запись';
      new.body := 'Время записи не изменилось. Свяжитесь с клиентом и выберите новое время, прежде чем переносить запись в CRM.';
    end if;

  elsif new.notification_type = 'appointment.cancelled_by_client' then
    if new.title = 'Client cancelled an appointment' then
      new.title := 'Клиент отменил запись';
      new.body := 'Клиент отменил эту запись по защищённой ссылке из напоминания.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.localize_notification_copy()
  from public, anon, authenticated, service_role;

drop trigger if exists notifications_localize_copy on public.notifications;
create trigger notifications_localize_copy
  before insert or update of title, body on public.notifications
  for each row execute function crm_private.localize_notification_copy();

-- ---------------------------------------------------------------------------
-- 3. Telegram claim: recipient language, dismissed rows never pushed
--
-- Body identical to 20260910220000 apart from the dismissed filter and the
-- language column; the return type changes, so the function is recreated.
-- ---------------------------------------------------------------------------

drop function if exists public.service_claim_telegram_notifications(text, integer, integer);

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
  entity_id uuid,
  language text
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
    on pref.profile_id = d.profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where n.scheduled_at <= now()
    and n.created_at >= d.connected_at
    -- A dismissed row is history; it is never pushed.
    and n.status <> 'dismissed'
    and crm_private.profile_can_receive_notification(
          n.recipient_profile_id, n.artist_id, n.workspace_id)
    and crm_private.client_ai_notification_is_current(n)
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
      and crm_private.client_ai_notification_is_current(n)
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
    n.entity_id,
    crm_private.profile_language(l.profile_id)
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

comment on function public.service_claim_telegram_notifications(text,integer,integer) is
  'Leases profile Telegram notifications with the recipient''s language. CRM-AI next-action pushes are eligible only while the recommendation remains open and its watermark matches the live CRM at claim time. Dismissed rows are never pushed.';

-- ---------------------------------------------------------------------------
-- 4. Language of a linked Telegram chat, for digest and /today replies
-- ---------------------------------------------------------------------------

create or replace function public.service_telegram_chat_language(p_chat_id text)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_language text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid Telegram chat id' using errcode = '22023';
  end if;

  -- Same resolution as the digest: an active profile destination whose owner
  -- still has Telegram enabled. An unknown chat answers 'en' like any other.
  select p.ui_language into v_language
  from crm_private.telegram_destinations d
  join public.profiles p on p.id = d.profile_id and p.is_active
  join public.notification_preferences pref
    on pref.profile_id = d.profile_id and pref.channel = 'telegram' and pref.is_enabled
  where d.chat_id = p_chat_id
    and d.destination_kind = 'profile'
    and d.is_active
  limit 1;

  return coalesce(v_language, 'en');
end;
$$;

revoke all on function public.service_telegram_chat_language(text)
  from public, anon, authenticated;
grant execute on function public.service_telegram_chat_language(text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. AI context carries the artist's output language
--
-- Body identical to 20260924040000 apart from artist.output_language.
-- ---------------------------------------------------------------------------

create or replace function crm_private.client_ai_context(
  p_artist_id uuid,
  p_client_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
set "TimeZone" = 'UTC'
as $$
  select jsonb_build_object(
    'client', jsonb_build_object(
      'full_name', c.full_name,
      'preferred_contact', c.preferred_contact
    ),
    'artist', jsonb_build_object(
      'display_name', a.display_name,
      'timezone', a.timezone,
      -- Language the artist-facing recipients read the CRM in. The Worker
      -- uses it only to choose the language of the internal note; it is not
      -- prompt data and does not enter the watermark.
      'output_language', crm_private.artist_output_language(p_artist_id)
    ),
    'enquiries', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'reference', e.reference_number,
          'status', e.status,
          'project_type', left(e.project_type, 200),
          'placement', left(e.placement, 200),
          'approximate_size', left(e.approximate_size, 200),
          'cover_up', left(e.cover_up, 200),
          'preferred_timing', left(e.preferred_timing, 200),
          'idea', left(e.idea, 2000),
          'created_at', e.created_at
        ) as item,
        row_number() over (order by e.created_at desc, e.id desc) as rank
        from public.enquiries e
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
        order by e.created_at desc, e.id desc
        limit 5
      ) s
    ),
    'crm_facts', jsonb_build_object(
      'has_scheduled_appointment', crm_private.client_has_scheduled_appointment(p_artist_id, p_client_id),
      'scheduled_appointment_count', (
        select count(*)
        from public.sessions s
        where s.client_id = p_client_id
          and s.artist_id = p_artist_id
          and s.status in ('proposed', 'confirmed')
          and s.cancelled_at is null
      ),
      'references_attached', crm_private.client_has_reference_files(p_artist_id, p_client_id),
      'reference_file_count', (
        select count(*)
        from public.enquiries e
        join public.enquiry_files f on f.enquiry_id = e.id
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
          and f.upload_state = 'ready'
          and f.category = 'reference'
      ),
      'ready_file_count', (
        select count(*)
        from public.enquiries e
        join public.enquiry_files f on f.enquiry_id = e.id
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
          and f.upload_state = 'ready'
      ),
      'reference_analysis_count', (
        select count(*)
        from public.enquiry_file_ai_analysis f
        where f.client_id = p_client_id
          and f.artist_id = p_artist_id
      ),
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', p.status,
          'deposit_status', p.deposit_status,
          'deposit_amount', p.deposit_amount,
          'estimated_sessions', p.estimated_sessions,
          'estimated_hours', p.estimated_hours,
          'estimate_total', p.estimate_total,
          'currency', p.currency
        ) order by p.created_at desc), '[]'::jsonb)
        from public.projects p
        where p.client_id = p_client_id
          and p.artist_id = p_artist_id
          and p.archived_at is null
      ),
      'sessions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', s.status,
          'appointment_type', s.appointment_type,
          'start_at', s.start_at,
          'end_at', s.end_at,
          'payment_status', s.payment_status,
          'price', s.price
        ) order by s.start_at desc), '[]'::jsonb)
        from public.sessions s
        where s.client_id = p_client_id
          and s.artist_id = p_artist_id
          and s.start_at > clock_timestamp() - interval '180 days'
      )
    ),
    'timeline', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'source', u.source,
          'direction', u.direction,
          'text', left(u.body, 1000),
          'occurred_at', u.occurred_at
        ) as item,
        row_number() over (order by u.occurred_at desc, u.source_id desc) as rank
        from crm_private.client_timeline_items(p_artist_id, p_client_id) u
        order by u.occurred_at desc, u.source_id desc
        limit 20
      ) s
    ),
    'reference_images', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'summary', f.summary,
        'analysis', f.analysis
      ) order by f.analyzed_at desc, f.id desc), '[]'::jsonb)
      from public.enquiry_file_ai_analysis f
      where f.client_id = p_client_id
        and f.artist_id = p_artist_id
    ),
    -- Phase 3: deterministic workflow facts. The model is told these are
    -- authoritative and chooses its recommendation from allowed_actions.
    'attention', crm_private.client_attention(p_artist_id, p_client_id),
    'previous_brief', (
      select jsonb_build_object('summary', st.summary, 'brief', st.brief)
      from public.client_ai_state st
      where st.artist_id = p_artist_id
        and st.client_id = p_client_id
    )
  )
  from public.clients c
  join public.artists a on a.id = p_artist_id
  where c.id = p_client_id
    and crm_private.client_ai_scope(p_artist_id, p_client_id) is not null;
$$;

revoke execute on function crm_private.client_ai_context(uuid, uuid)
  from public, anon, authenticated, service_role;
