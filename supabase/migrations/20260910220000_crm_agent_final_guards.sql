-- Final corrective guards for the CRM AI Five Pillars branch.
--
-- This migration closes three review findings without changing the canonical
-- source-of-truth model:
--   1. any source event that invalidates a recommendation supersedes it
--      immediately, before the replacement model call finishes;
--   2. the Telegram notification lease refuses a client-AI push whose source
--      watermark no longer matches the live CRM;
--   3. Gmail excerpts use the provider timestamp and a first observation is a
--      baseline, not a newly-arrived message;
--   4. project/session event fingerprints are timezone-independent.

-- ---------------------------------------------------------------------------
-- 1. Timezone-independent canonical event fingerprints.
-- ---------------------------------------------------------------------------

create or replace function crm_private.project_ai_fingerprint(p public.projects)
returns text
language sql
stable
set search_path = pg_catalog, extensions
set "TimeZone" = 'UTC'
as $$
  select left(encode(extensions.digest(convert_to(
    coalesce(p.status::text, '') || '|' ||
    coalesce(p.deposit_status::text, '') || '|' ||
    coalesce(p.deposit_amount::text, '') || '|' ||
    coalesce(p.estimate_total::text, '') || '|' ||
    coalesce(p.estimated_sessions::text, '') || '|' ||
    coalesce(p.estimated_hours::text, '') || '|' ||
    coalesce(p.hourly_rate::text, '') || '|' ||
    coalesce(p.currency, '') || '|' ||
    coalesce(p.archived_at::text, ''), 'UTF8'), 'sha256'), 'hex'), 16);
$$;

create or replace function crm_private.session_ai_fingerprint(s public.sessions)
returns text
language sql
stable
set search_path = pg_catalog, extensions
set "TimeZone" = 'UTC'
as $$
  select left(encode(extensions.digest(convert_to(
    coalesce(s.status::text, '') || '|' ||
    coalesce(s.start_at::text, '') || '|' ||
    coalesce(s.end_at::text, '') || '|' ||
    coalesce(s.payment_status::text, '') || '|' ||
    coalesce(s.price::text, '') || '|' ||
    coalesce(s.cancelled_at::text, ''), 'UTF8'), 'sha256'), 'hex'), 16);
$$;

revoke all on function
  crm_private.project_ai_fingerprint(public.projects),
  crm_private.session_ai_fingerprint(public.sessions)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A source event invalidates the old recommendation immediately.
--
-- Previously schedule_client_ai_refresh only queued the replacement. That left
-- the old action open while the model was running, so an already-queued push
-- could still be leased during that window. Superseding here is safe because
-- derived rows are not part of the watermark and the existing status trigger
-- withdraws any not-yet-claimed notification for that action.
-- ---------------------------------------------------------------------------

create or replace function crm_private.schedule_client_ai_refresh(
  p_artist_id uuid,
  p_client_id uuid,
  p_source_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_id uuid;
  v_current text;
begin
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return null;
  end if;
  if p_source_event_id is null or p_source_event_id !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    return null;
  end if;

  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    return null;
  end if;

  v_current := crm_private.client_ai_watermark(p_artist_id, p_client_id);

  -- Once the canonical CRM has moved, the old recommendation is historical,
  -- not work waiting for the artist. This update also invokes the existing
  -- notification-withdrawal trigger from 20260910210000.
  update public.client_ai_next_actions a
  set status = 'superseded', updated_at = clock_timestamp()
  where a.artist_id = p_artist_id
    and a.client_id = p_client_id
    and a.status = 'open'
    and a.source_watermark is distinct from v_current;

  insert into public.crm_agent_jobs (
    artist_id, workspace_id, client_id, job_type, source_event_id
  )
  values (p_artist_id, v_workspace, p_client_id, 'refresh_client_ai_state', p_source_event_id)
  on conflict (artist_id, job_type, source_event_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function crm_private.schedule_client_ai_refresh(uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Gmail excerpts: baseline-safe and timestamp-correct.
--
-- The Gmail Worker calls this BEFORE service_observe_gmail_enquiry_ai. That is
-- useful: the current gmail_thread_context still contains the previous provider
-- message id. No context means this is the first observation and therefore only
-- establishes a baseline; the historical message must not be presented to the
-- brief as newly received. A changed provider id means it is genuinely new
-- relative to the observed thread.
-- ---------------------------------------------------------------------------

drop function if exists public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text
);

create function public.service_record_gmail_client_message(
  p_artist_id uuid,
  p_client_id uuid,
  p_enquiry_id uuid,
  p_provider_thread_id text,
  p_provider_message_id text,
  p_direction text,
  p_subject text,
  p_body text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_body text;
  v_id uuid;
  v_previous_message_id text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  if p_provider_thread_id is null or p_provider_thread_id !~ '^[A-Za-z0-9_-]{4,255}$'
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9_-]{1,255}$'
     or p_direction is null or p_direction not in ('inbound', 'outbound')
     or (p_subject is not null and length(p_subject) > 998)
     or p_occurred_at is null
     or p_occurred_at < timestamptz '2000-01-01 00:00:00+00'
     or p_occurred_at > clock_timestamp() + interval '1 day' then
    raise exception 'invalid Gmail excerpt' using errcode = '22023';
  end if;

  v_body := btrim(regexp_replace(
    coalesce(p_body, ''), E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g'));
  if v_body = '' then
    return jsonb_build_object('status', 'ignored');
  end if;
  v_body := left(v_body, 4000);

  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;

  -- Look only at a context already established by an earlier observation.
  -- Because this RPC runs before the observer updates the context, a different
  -- id means a new provider message. No context means historical baseline.
  select g.last_provider_message_id
  into v_previous_message_id
  from crm_private.gmail_thread_contexts g
  where g.artist_id = p_artist_id
    and g.client_id = p_client_id
    and g.provider_thread_id = p_provider_thread_id
  order by g.updated_at desc, g.id desc
  limit 1;

  if not found then
    return jsonb_build_object('status', 'baseline');
  end if;

  if v_previous_message_id is not distinct from p_provider_message_id then
    return jsonb_build_object('status', 'existing');
  end if;

  if p_enquiry_id is not null and not exists (
    select 1 from public.enquiries e
    where e.id = p_enquiry_id
      and e.artist_id = p_artist_id
      and e.client_id = p_client_id
  ) then
    p_enquiry_id := null;
  end if;

  insert into crm_private.gmail_client_ai_excerpts (
    artist_id, workspace_id, client_id, enquiry_id,
    provider_thread_id, provider_message_id, direction, subject,
    body_excerpt, occurred_at
  )
  values (
    p_artist_id, v_workspace, p_client_id, p_enquiry_id,
    p_provider_thread_id, p_provider_message_id, p_direction,
    nullif(left(btrim(coalesce(p_subject, '')), 500), ''),
    v_body, p_occurred_at
  )
  on conflict (artist_id, client_id, provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'existing');
  end if;

  -- Retention is based on when Gmail says the message occurred, not when the
  -- operator happened to open the thread.
  delete from crm_private.gmail_client_ai_excerpts x
  where x.artist_id = p_artist_id
    and x.client_id = p_client_id
    and x.id not in (
      select y.id
      from crm_private.gmail_client_ai_excerpts y
      where y.artist_id = p_artist_id and y.client_id = p_client_id
      order by y.occurred_at desc, y.id desc
      limit 5
    );

  perform crm_private.schedule_client_ai_refresh(
    p_artist_id, p_client_id, 'gmail:' || p_provider_message_id
  );

  return jsonb_build_object('status', 'recorded', 'excerpt_id', v_id);
end;
$$;

revoke all on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text,timestamptz
) to service_role;

comment on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text,timestamptz
) is
  'Records only a Gmail message newer than an already-observed thread baseline. Uses the provider timestamp, stores at most five bounded excerpts, re-derives artist/client scope, and schedules the client-state refresh.';

-- ---------------------------------------------------------------------------
-- 4. Telegram claim-time freshness guard.
--
-- Immediate supersede above closes the normal model-refresh window. This guard
-- is a second line of defence: a client-AI notification is not materialised or
-- leased unless its action is still open AND its source watermark still matches
-- the live CRM at the moment the connector claims it.
-- ---------------------------------------------------------------------------

create function crm_private.client_ai_notification_is_current(n public.notifications)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when n.notification_type <> 'client_ai.next_action' then true
    else exists (
      select 1
      from public.client_ai_next_actions a
      where a.artist_id = n.artist_id
        and a.client_id = n.entity_id
        and a.status = 'open'
        and n.dedupe_key = 'client_ai_next_action:' || a.id::text || ':' || n.recipient_profile_id::text
        and crm_private.client_ai_watermark(a.artist_id, a.client_id)
              is not distinct from a.source_watermark
    )
  end;
$$;

revoke all on function crm_private.client_ai_notification_is_current(public.notifications)
  from public, anon, authenticated, service_role;

create or replace function public.service_claim_telegram_notifications(
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
  entity_id uuid
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
    n.entity_id
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
  'Leases profile Telegram notifications. CRM-AI next-action pushes are eligible only while the recommendation remains open and its watermark matches the live CRM at claim time.';
