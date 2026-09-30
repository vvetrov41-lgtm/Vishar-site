-- 20260930150000_telegram_notification_rework.sql
--
-- Owner feedback (2026-09-30): Telegram pushes were not useful.
--
--   1. The new-enquiry push carried one free-text AI paragraph and hid the
--      facts the artist decides on. It now renders a fact card: project type,
--      style, placement, size, colour, cover-up, timing, where the client
--      travels from, the idea (verbatim when short, the AI project summary
--      when long) and the reference count. Form answers win; the AI brief only
--      fills gaps.
--
--   2. `client_ai.next_action` ("Needs you: ...") was pushed after every CRM-AI
--      refresh, i.e. after every client message and even after a consultation
--      was booked, because each refresh derives a new recommendation id. The
--      recommendations stay in the CRM (Today, client card); they are no longer
--      created as notifications and any already queued are never pushed.
--
--   3. Replacing that noise: a reminder when a client has been waiting for a
--      reply. One at 6 hours and one final at 24 hours per unanswered inbound
--      message (a newer client message restarts the clock), nothing after
--      that, nothing older than 72 hours, and nothing between 22:00 and 08:00
--      Europe/London: a reminder that falls due overnight is created by the
--      first sweep after 08:00. "Mark handled" in Today (attention
--      acknowledgement) silences it.

-- ---------------------------------------------------------------------------
-- 1. New-enquiry fact card
-- ---------------------------------------------------------------------------

create or replace function crm_private.telegram_card_value(p_value text, p_max integer default 160)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when nullif(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')), '') is null then null
    when char_length(btrim(regexp_replace(p_value, '\s+', ' ', 'g'))) <= p_max
      then btrim(regexp_replace(p_value, '\s+', ' ', 'g'))
    else left(btrim(regexp_replace(p_value, '\s+', ' ', 'g')), p_max - 1) || '…'
  end;
$$;

revoke all on function crm_private.telegram_card_value(text, integer)
  from public, anon, authenticated, service_role;

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
  v_brief jsonb := case when jsonb_typeof(p_brief) = 'object' then p_brief else '{}'::jsonb end;
  v_type text;
  v_style text;
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

  -- The AI style line is shown only when it adds something the type does not
  -- already say ("Black and grey realism" twice is noise).
  v_style := crm_private.telegram_card_value(v_brief ->> 'style', 120);
  if v_style is not null and lower(v_style) = lower(coalesce(v_e.project_type, '')) then
    v_style := null;
  end if;

  v_cover := crm_private.telegram_card_value(v_e.cover_up, 40);
  if v_ru then
    v_cover := case v_cover
      when 'No' then 'нет' when 'Yes' then 'да' when 'Not sure' then 'не уверен(а)'
      else v_cover end;
  end if;
  if v_cover is not null and coalesce(v_e.cover_up, '') <> 'No'
     and crm_private.telegram_card_value(v_brief ->> 'cover_up_context', 120) is not null then
    v_cover := v_cover || ' — ' || crm_private.telegram_card_value(v_brief ->> 'cover_up_context', 120);
  end if;

  -- A short idea is the client's own words and is shown as written. A wall of
  -- text becomes the AI project summary; without one yet, it is truncated.
  v_idea := crm_private.telegram_card_value(v_e.idea, 100000);
  if v_idea is not null and char_length(v_idea) > 280 then
    v_idea := coalesce(
      crm_private.telegram_card_value(v_brief ->> 'project_summary', 400),
      crm_private.telegram_card_value(p_summary, 400),
      crm_private.telegram_card_value(v_idea, 280));
  end if;

  v_lines := array_remove(array[
    case when v_type is not null then (case when v_ru then 'Тип: ' else 'Type: ' end) || v_type end,
    case when v_style is not null then (case when v_ru then 'Стиль: ' else 'Style: ' end) || v_style end,
    case when coalesce(crm_private.telegram_card_value(v_e.placement), crm_private.telegram_card_value(v_brief ->> 'placement')) is not null
      then (case when v_ru then 'Место: ' else 'Placement: ' end)
        || coalesce(crm_private.telegram_card_value(v_e.placement), crm_private.telegram_card_value(v_brief ->> 'placement')) end,
    case when coalesce(crm_private.telegram_card_value(v_e.approximate_size, 120), crm_private.telegram_card_value(v_brief ->> 'size', 120)) is not null
      then (case when v_ru then 'Размер: ' else 'Size: ' end)
        || coalesce(crm_private.telegram_card_value(v_e.approximate_size, 120), crm_private.telegram_card_value(v_brief ->> 'size', 120)) end,
    case when crm_private.telegram_card_value(v_brief ->> 'colour', 80) is not null
      then (case when v_ru then 'Цвет: ' else 'Colour: ' end) || crm_private.telegram_card_value(v_brief ->> 'colour', 80) end,
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

create or replace function crm_private.enquiry_telegram_title(p_client_name text, p_language text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select left(case when p_language = 'ru' then 'Новая заявка: ' else 'New enquiry: ' end
              || p_client_name, 200);
$$;

revoke all on function crm_private.enquiry_telegram_title(text, text)
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
  v_ai_enabled boolean := false;
  v_ai_summary text;
  v_ai_brief jsonb;
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

  select coalesce(enabled, false)
    into v_ai_enabled
  from crm_private.crm_agent_config
  where singleton;
  v_ai_enabled := coalesce(v_ai_enabled, false);

  -- Use an existing brief only when its watermark still describes the live CRM
  -- after this enquiry; otherwise the normal refresh enriches the held card.
  if v_ai_enabled then
    select left(btrim(st.summary), 1800), st.brief
      into v_ai_summary, v_ai_brief
    from public.client_ai_state st
    where st.artist_id = v_job.artist_id
      and st.client_id = v_client_id
      and st.source_watermark = crm_private.client_ai_watermark(v_job.artist_id, v_client_id)
    order by st.refreshed_at desc
    limit 1;
  end if;

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
    crm_private.enquiry_telegram_card(
      v_job.enquiry_id, crm_private.profile_language(am.profile_id), v_ai_summary, v_ai_brief),
    'enquiry',
    v_job.enquiry_id,
    'high',
    'delivered',
    'enquiry_created:' || v_job.enquiry_id::text || ':' || am.profile_id::text,
    -- The card is complete from the form alone. It is held for at most five
    -- minutes only so the AI brief can add style/colour and condense a long idea.
    case when v_ai_enabled and v_ai_brief is null
         then now() + interval '5 minutes'
         else now()
    end,
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

-- Rebuild the SAME held card once a fresh brief lands. A card Telegram has
-- already started delivering is immutable, as before.
create or replace function crm_private.enrich_recent_enquiry_notification_from_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_name text;
begin
  select left(c.full_name, 80)
    into v_client_name
  from public.clients c
  where c.id = new.client_id;

  if not found or nullif(btrim(v_client_name), '') is null then
    return new;
  end if;

  update public.notifications n
  set title = crm_private.enquiry_telegram_title(
                v_client_name, crm_private.profile_language(n.recipient_profile_id)),
      body = coalesce(
               crm_private.enquiry_telegram_card(
                 e.id, crm_private.profile_language(n.recipient_profile_id),
                 new.summary, new.brief),
               n.body),
      scheduled_at = now(),
      updated_at = now()
  from public.enquiries e
  where n.notification_type = 'enquiry.created'
    and n.entity_type = 'enquiry'
    and n.entity_id = e.id
    and e.client_id = new.client_id
    and e.artist_id = new.artist_id
    and n.artist_id = new.artist_id
    and n.created_at >= now() - interval '15 minutes'
    and not exists (
      select 1
      from crm_private.telegram_notification_deliveries d
      where d.notification_id = n.id
    );

  return new;
end;
$$;

revoke all on function crm_private.enrich_recent_enquiry_notification_from_client_ai()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. CRM-AI recommendations are no longer pushed
-- ---------------------------------------------------------------------------

-- Kept with the same signature because service_complete_client_ai_state_job
-- calls it; it now announces nothing. Recommendations remain visible in Today
-- and on the client card.
create or replace function crm_private.enqueue_client_ai_notification(p_next_action_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select 0;
$$;

revoke all on function crm_private.enqueue_client_ai_notification(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.enqueue_client_ai_notification(uuid) is
  'Retired 2026-09-30: CRM-AI recommendations are shown in the CRM only and are not pushed. Unanswered clients are surfaced by service_sweep_unanswered_client_reminders.';

-- ---------------------------------------------------------------------------
-- 3. Unanswered-client reminders
-- ---------------------------------------------------------------------------

create or replace function crm_private.unanswered_reminder_quiet(p_at timestamptz)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select extract(hour from p_at at time zone 'Europe/London') >= 22
      or extract(hour from p_at at time zone 'Europe/London') < 8;
$$;

revoke all on function crm_private.unanswered_reminder_quiet(timestamptz)
  from public, anon, authenticated, service_role;

-- The single definition of "this client is still waiting on a reply", shared
-- by the sweep that creates a reminder and the Telegram claim that sends it.
-- Returns the instant the client started waiting, or null when nothing is
-- waiting (answered, acknowledged in Today, archived, engaged with).
--
-- Conversations are judged by the conversation's own event timestamps
-- (maintained with greatest() by every ingest path, echoes included), not by
-- message insertion order, so a late webhook for an older inbound message
-- cannot resurrect a conversation the artist already answered.
create or replace function crm_private.unanswered_waiting_since(
  p_entity_type text,
  p_artist_id uuid,
  p_entity_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case p_entity_type
    when 'conversation' then (
      select c.last_inbound_at
      from public.communication_conversations c
      where c.id = p_entity_id
        and c.artist_id = p_artist_id
        and c.state = 'open'
        and c.last_inbound_at is not null
        and c.last_inbound_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = c.artist_id and k.item_kind = 'conversation_reply'
            and k.entity_id = c.id and k.observed_at >= c.last_inbound_at))
    when 'client' then (
      select g.last_message_at
      from public.gmail_client_metadata_snapshots g
      where g.artist_id = p_artist_id
        and g.client_id = p_entity_id
        and g.direction = 'inbound'
        and g.last_message_at is not null
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = g.artist_id and k.item_kind = 'gmail_reply'
            and k.entity_id = g.client_id and k.observed_at >= g.last_message_at))
    when 'enquiry' then (
      -- A website enquiry nobody has engaged with (same rule as Today).
      select e.created_at
      from public.enquiries e
      where e.id = p_entity_id
        and e.artist_id = p_artist_id
        and e.archived_at is null and e.status = 'new' and e.intake_state = 'complete'
        and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
        and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
        and not exists (
          select 1 from public.communication_conversations c
          where c.artist_id = e.artist_id
            and (c.enquiry_id = e.id or c.client_id = e.client_id)
            and c.last_message_at >= e.created_at)
        and not exists (
          select 1 from public.gmail_client_metadata_snapshots g
          where g.artist_id = e.artist_id and g.client_id = e.client_id
            and g.last_message_at >= e.created_at)
        and not exists (
          select 1 from public.email_messages m
          where m.artist_id = e.artist_id
            and (m.enquiry_id = e.id or m.client_id = e.client_id)
            and m.created_at >= e.created_at
            and (m.created_by_kind = 'human' or m.status in ('approved', 'queued', 'sent', 'failed')))
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = e.artist_id and k.item_kind = 'new_enquiry'
            and k.entity_id = e.id and k.observed_at >= e.created_at))
  end;
$$;

revoke all on function crm_private.unanswered_waiting_since(text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Claim-time truth for a queued reminder. A reminder created earlier may only
-- be pushed while the same wait is still open, outside quiet hours, within
-- 72 hours, and (for the 6 h reminder) before the final one exists: a Telegram
-- outage must not release a stale reminder or both stages together.
create or replace function crm_private.unanswered_reminder_is_current(
  n public.notifications,
  p_now timestamptz
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when n.notification_type <> 'client.reply_overdue' then true
    else coalesce((
      select not crm_private.unanswered_reminder_quiet(p_now)
         and w.since > p_now - interval '72 hours'
         and floor(extract(epoch from w.since))::bigint::text = split_part(n.dedupe_key, ':', 4)
         and not (
           split_part(n.dedupe_key, ':', 5) = '6h'
           and exists (select 1 from public.notifications x
                       where x.dedupe_key = replace(n.dedupe_key, ':6h:', ':24h:')))
      from (select crm_private.unanswered_waiting_since(n.entity_type, n.artist_id, n.entity_id) as since) w
    ), false)
  end;
$$;

revoke all on function crm_private.unanswered_reminder_is_current(public.notifications, timestamptz)
  from public, anon, authenticated, service_role;

-- The claim already calls this guard for every row. CRM-AI recommendation
-- pushes (including rows queued before this migration) are never current;
-- unanswered-client reminders are rechecked against the live CRM.
create or replace function crm_private.client_ai_notification_is_current(
  n public.notifications
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select n.notification_type <> 'client_ai.next_action'
     and crm_private.unanswered_reminder_is_current(n, now());
$$;

revoke execute on function crm_private.client_ai_notification_is_current(public.notifications)
  from public, anon, authenticated, service_role;

create or replace function public.service_sweep_unanswered_client_reminders(
  p_limit integer default 50,
  p_now timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_created integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'unanswered client reminders are backend-only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'reminder limit must be between 1 and 100' using errcode = '22023';
  end if;
  if crm_private.unanswered_reminder_quiet(v_now) then
    return 0;
  end if;

  with candidates as (
    -- Cheap time-window prefilter; unanswered_waiting_since() decides.
    select c.artist_id, 'conversation'::text as entity_type, c.id as entity_id,
           c.last_inbound_at as observed_at,
           coalesce(left(cl.full_name, 80), c.external_display_label, c.external_username) as who,
           case c.channel when 'whatsapp' then 'WhatsApp' else 'Instagram' end as channel_label,
           latest.body as excerpt,
           coalesce(latest.has_media, false) as has_media
    from public.communication_conversations c
    left join public.clients cl on cl.id = c.client_id
    left join lateral (
      -- The newest inbound message by event time, for the excerpt only.
      select m.body, jsonb_array_length(m.attachments) > 0 as has_media
      from public.communication_messages m
      where m.conversation_id = c.id and m.direction = 'inbound'
      order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
      limit 1
    ) latest on true
    where c.state = 'open'
      and c.last_inbound_at > v_now - interval '72 hours'
      and c.last_inbound_at <= v_now - interval '6 hours'
    union all
    select g.artist_id, 'client'::text, g.client_id, g.last_message_at,
           left(cl.full_name, 80), 'Email'::text,
           nullif(btrim(g.subject), ''), false
    from public.gmail_client_metadata_snapshots g
    join public.clients cl on cl.id = g.client_id
    where g.direction = 'inbound'
      and g.last_message_at > v_now - interval '72 hours'
      and g.last_message_at <= v_now - interval '6 hours'
    union all
    select e.artist_id, 'enquiry'::text, e.id, e.created_at,
           left(cl.full_name, 80), 'enquiry'::text,
           concat_ws(' · ', crm_private.telegram_card_value(e.project_type, 60),
                            crm_private.telegram_card_value(e.placement, 60)),
           false
    from public.enquiries e
    join public.clients cl on cl.id = e.client_id
    where e.status = 'new'
      and e.created_at > v_now - interval '72 hours'
      and e.created_at <= v_now - interval '6 hours'
  ), waiting as (
    select c.*, crm_private.unanswered_waiting_since(c.entity_type, c.artist_id, c.entity_id) as waiting_since
    from candidates c
    join crm_private.artist_state st on st.artist_id = c.artist_id and st.is_active
  ), staged as (
    select w.*,
           case when w.waiting_since <= v_now - interval '24 hours' then '24h' else '6h' end as stage,
           floor(extract(epoch from (v_now - w.waiting_since)) / 3600)::integer as hours
    from waiting w
    where w.waiting_since = w.observed_at
  ), targeted as (
    select s.*, am.profile_id, a.workspace_id,
           crm_private.profile_language(am.profile_id) as lang,
           'unanswered:' || s.entity_type || ':' || s.entity_id::text || ':'
             || floor(extract(epoch from s.waiting_since))::bigint::text || ':'
             || s.stage || ':' || am.profile_id::text as dedupe_key
    from staged s
    join public.artist_memberships am on am.artist_id = s.artist_id and am.is_active
    join public.artists a on a.id = am.artist_id and a.is_active
    where crm_private.telegram_notification_recipient_eligible(am.profile_id, s.artist_id, a.workspace_id)
  ), due as (
    select t.* from targeted t
    where not exists (select 1 from public.notifications n where n.dedupe_key = t.dedupe_key)
      -- The final reminder replaces, never follows, an unsent first one; the
      -- claim applies the same rule to a first reminder still queued.
      and not (t.stage = '6h' and exists (
        select 1 from public.notifications n
        where n.dedupe_key = replace(t.dedupe_key, ':6h:', ':24h:')))
    order by t.waiting_since, t.entity_id, t.profile_id
    limit p_limit
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, workspace_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select d.profile_id, d.artist_id, d.workspace_id, 'client.reply_overdue',
      left(
        case
          when d.lang = 'ru' and d.stage = '24h' then 'Ждёт ответа больше суток: '
          when d.lang = 'ru' then 'Ждёт ответа ' || d.hours || ' ч: '
          when d.stage = '24h' then 'Waiting over a day for your reply: '
          else 'Waiting ' || d.hours || ' h for your reply: '
        end || coalesce(nullif(btrim(d.who), ''), '—'), 200),
      left(
        case when d.channel_label = 'enquiry'
          then (case when d.lang = 'ru' then 'Новая заявка без ответа' else 'New enquiry, not answered yet' end)
          else d.channel_label end
        || case
             when crm_private.telegram_card_value(d.excerpt, 300) is not null
               then E'\n«' || crm_private.telegram_card_value(d.excerpt, 300) || '»'
             when d.has_media
               then E'\n' || case when d.lang = 'ru' then '[вложение]' else '[attachment]' end
             else ''
           end, 2000),
      d.entity_type, d.entity_id, 'high', 'delivered', d.dedupe_key, v_now, v_now
    from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;
  return v_created;
end;
$$;

revoke all on function public.service_sweep_unanswered_client_reminders(integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.service_sweep_unanswered_client_reminders(integer, timestamptz)
  to service_role;

comment on function public.service_sweep_unanswered_client_reminders(integer, timestamptz) is
  'Backend-only. Personal Telegram reminders for clients waiting on a reply: one at 6 h, one final at 24 h per inbound message, none older than 72 h, none 22:00-08:00 Europe/London. The Telegram claim rechecks each reminder against the live CRM before sending.';
