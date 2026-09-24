-- 20260924030000_attention_engine_shadow.sql
--
-- Phase 2 of the CRM AI architecture: a deterministic attention layer, in
-- SHADOW MODE. Nothing an operator sees changes in this migration.
--
-- WHY
--
-- The model currently decides `stage` and `waiting_on`, facts the CRM already
-- knows, and gets them wrong (audit H3). Leads go cold with no event that
-- would re-evaluate them (H5). This layer derives those facts from
-- authoritative rows and from time, so they are exact and change as the clock
-- moves.
--
-- SHAPE
--
-- Small composable functions, each testable alone, assembled by one bounded
-- projection (`crm_private.client_attention`):
--
--   attention_comm_facts     who spoke last, when, and whether a reply is owed
--   attention_stage_facts    workflow stage from enquiries, projects, sessions
--   attention_sla            pure: SLA state from those facts and a clock
--   attention_allowed_actions pure: which recommendation types are valid now
--   attention_conflicts      contradictory authoritative state, as codes
--
-- LAST SPEAKER IS NOT AN OBLIGATION
--
-- `last_speaker = client` is a timestamp fact. Whether that message needs an
-- answer is semantic ("thanks, see you then" does not). The layer exposes
-- `response_debt_candidate` and a separate `reply_state`, which only an
-- explicit mark can set: an operator acknowledgement, or (Phase 3) a narrow
-- classifier writing `crm_private.client_reply_marks`. Without a mark the
-- state is `unknown`, never assumed.
--
-- SHADOW EVIDENCE
--
-- `crm_private.attention_shadow_report()` compares the derived facts with the
-- current AI brief and records aggregate disagreement counts (no names, no
-- text) at most once an hour in `crm_private.attention_shadow_runs`.

-- ---------------------------------------------------------------------------
-- Explicit reply marks
-- ---------------------------------------------------------------------------

create table crm_private.client_reply_marks (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- The inbound message time the mark answers. A newer inbound makes it moot.
  message_at timestamptz not null,
  reply_state text not null check (reply_state in ('reply_required', 'no_reply_needed')),
  source text not null check (source in ('operator', 'classifier')),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp()
);

create index client_reply_marks_client_idx
  on crm_private.client_reply_marks (artist_id, client_id, message_at desc, created_at desc);

revoke all on crm_private.client_reply_marks from public, anon, authenticated, service_role;

comment on table crm_private.client_reply_marks is
  'Explicit semantic marks on whether the latest client message needs a reply. Set only by an operator or a bounded classifier; absence means unknown.';

-- ---------------------------------------------------------------------------
-- 1. Communication facts
-- ---------------------------------------------------------------------------

create function crm_private.attention_comm_facts(p_artist_id uuid, p_client_id uuid)
returns table (
  last_inbound_at timestamptz,
  last_inbound_source text,
  last_outbound_at timestamptz,
  last_speaker text,
  reply_state text,
  reply_state_source text,
  response_debt_candidate boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with items as (
    select t.source, t.direction, t.occurred_at
    from crm_private.client_timeline_items(p_artist_id, p_client_id) t
    where t.direction in ('inbound', 'outbound')
      and t.source in ('communication', 'email', 'gmail', 'enquiry')
      and t.occurred_at is not null
  ),
  inbound as (
    select i.occurred_at, i.source from items i where i.direction = 'inbound'
    order by i.occurred_at desc limit 1
  ),
  outbound as (
    select max(i.occurred_at) as at from items i where i.direction = 'outbound'
  ),
  mark as (
    select m.reply_state, m.source
    from crm_private.client_reply_marks m, inbound
    where m.artist_id = p_artist_id and m.client_id = p_client_id
      and m.message_at >= inbound.occurred_at
    order by m.created_at desc
    limit 1
  ),
  ack as (
    -- An operator who cleared this client's reply item handled the version
    -- they SAW: `observed_at` is the source version the item showed. A newer
    -- inbound after that version is not covered, however late the click was.
    select max(a.observed_at) as at
    from public.attention_acknowledgements a
    where a.artist_id = p_artist_id
      and (
        (a.item_kind = 'conversation_reply' and exists (
          select 1 from public.communication_conversations c
          where c.id = a.entity_id and c.artist_id = p_artist_id and c.client_id = p_client_id))
        or (a.item_kind = 'gmail_reply' and exists (
          select 1 from crm_private.gmail_thread_contexts g
          where g.id = a.entity_id and g.artist_id = p_artist_id and g.client_id = p_client_id))
        or (a.item_kind = 'new_enquiry' and exists (
          select 1 from public.enquiries e
          where e.id = a.entity_id and e.artist_id = p_artist_id and e.client_id = p_client_id))
      )
  ),
  facts as (
    select
      (select occurred_at from inbound) as last_inbound_at,
      (select source from inbound) as last_inbound_source,
      (select at from outbound) as last_outbound_at,
      (select reply_state from mark) as mark_state,
      (select source from mark) as mark_source,
      (select at from ack) as ack_at
  )
  select
    f.last_inbound_at,
    f.last_inbound_source,
    f.last_outbound_at,
    case
      when f.last_inbound_at is null and f.last_outbound_at is null then 'none'
      when f.last_outbound_at is null or f.last_inbound_at > f.last_outbound_at then 'client'
      else 'studio'
    end,
    case
      when f.mark_state is not null then f.mark_state
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'no_reply_needed'
      else 'unknown'
    end,
    case
      when f.mark_state is not null then f.mark_source
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'operator_ack'
      else null
    end,
    f.last_inbound_at is not null
      and (f.last_outbound_at is null or f.last_inbound_at > f.last_outbound_at)
  from facts f;
$$;

-- ---------------------------------------------------------------------------
-- 2. Stage facts
-- ---------------------------------------------------------------------------

create function crm_private.attention_stage_facts(p_artist_id uuid, p_client_id uuid)
returns table (
  workflow_stage text,
  enquiry_status text,
  enquiry_created_at timestamptz,
  deposit_state text,
  has_future_tattoo_session boolean,
  has_future_consultation boolean,
  next_session_at timestamptz,
  has_recent_completed_session boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with enquiry as (
    select e.status::text as status, e.created_at
    from public.enquiries e
    where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
    order by e.updated_at desc, e.created_at desc, e.id desc
    limit 1
  ),
  live_sessions as (
    select s.appointment_type, s.status, s.start_at, s.end_at
    from public.sessions s
    where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
  ),
  projects as (
    select p.deposit_status::text as deposit_status, p.status::text as status
    from public.projects p
    where p.artist_id = p_artist_id and p.client_id = p_client_id and p.archived_at is null
      and p.status in ('draft', 'active', 'on_hold')
  ),
  facts as (
    select
      (select status from enquiry) as enquiry_status,
      (select created_at from enquiry) as enquiry_created_at,
      case
        when exists (select 1 from projects where deposit_status = 'paid') then 'paid'
        when exists (select 1 from projects where deposit_status = 'requested') then 'requested'
        when exists (select 1 from projects where deposit_status = 'not_required') then 'not_required'
        else 'none'
      end as deposit_state,
      exists (select 1 from live_sessions
              where appointment_type in ('tattoo_session', 'touch_up')
                and status in ('proposed', 'confirmed') and end_at >= clock_timestamp()) as future_tattoo,
      exists (select 1 from live_sessions
              where appointment_type in ('in_person_consultation', 'video_consultation')
                and status in ('proposed', 'confirmed') and end_at >= clock_timestamp()) as future_consultation,
      (select min(start_at) from live_sessions
       where status in ('proposed', 'confirmed') and end_at >= clock_timestamp()) as next_session_at,
      exists (select 1 from live_sessions
              where appointment_type in ('tattoo_session', 'touch_up') and status = 'completed'
                and end_at >= clock_timestamp() - interval '60 days') as recent_completed,
      exists (select 1 from projects) as has_open_project
  )
  select
    case
      when f.future_tattoo then 'booked'
      when f.recent_completed then 'aftercare'
      when f.deposit_state = 'requested' then 'deposit_pending'
      when f.deposit_state = 'paid' then 'scheduling'
      when f.future_consultation then 'awaiting_artist_review'
      when f.enquiry_status = 'new' then 'new_enquiry'
      when f.enquiry_status = 'reviewing' then 'awaiting_artist_review'
      when f.enquiry_status = 'waiting_for_client' then 'gathering_information'
      when f.enquiry_status = 'quote_sent' then 'quote_discussion'
      when f.enquiry_status = 'deposit_requested' then 'deposit_pending'
      when f.enquiry_status in ('accepted', 'deposit_paid') then 'scheduling'
      when f.enquiry_status = 'converted' and f.has_open_project then 'scheduling'
      else 'dormant'
    end,
    f.enquiry_status,
    f.enquiry_created_at,
    f.deposit_state,
    f.future_tattoo,
    f.future_consultation,
    f.next_session_at,
    f.recent_completed
  from facts f;
$$;

-- ---------------------------------------------------------------------------
-- 3. SLA (pure)
-- ---------------------------------------------------------------------------

create function crm_private.attention_sla(
  p_last_speaker text,
  p_reply_state text,
  p_last_inbound_at timestamptz,
  p_last_outbound_at timestamptz,
  p_workflow_stage text,
  p_now timestamptz
)
returns table (sla_state text, sla_reason text, waiting_on_candidate text, age_hours integer)
language sql
immutable
set search_path = pg_catalog
as $$
  with a as (
    select
      p_last_speaker = 'client' and coalesce(p_reply_state, 'unknown') <> 'no_reply_needed' as debt,
      p_last_speaker = 'studio'
        and p_workflow_stage not in ('booked', 'aftercare', 'dormant') as awaiting_client,
      extract(epoch from (p_now - p_last_inbound_at)) / 3600 as inbound_hours,
      extract(epoch from (p_now - p_last_outbound_at)) / 3600 as outbound_hours
  )
  select
    case
      when a.debt and a.inbound_hours >= 72 then 'overdue'
      -- A brand-new enquiry is the most perishable debt: overdue at 48 hours.
      when a.debt and p_workflow_stage = 'new_enquiry' and a.inbound_hours >= 48 then 'overdue'
      when a.debt and a.inbound_hours >= 24 then 'due'
      when a.debt then 'ok'
      when a.awaiting_client and a.outbound_hours >= 21 * 24 then 'cold'
      when a.awaiting_client and a.outbound_hours >= 7 * 24 then 'due'
      else 'ok'
    end,
    case
      when a.debt then 'studio_reply_owed'
      when a.awaiting_client and a.outbound_hours >= 21 * 24 then 'client_silent'
      when a.awaiting_client and a.outbound_hours >= 7 * 24 then 'client_follow_up_due'
      when a.awaiting_client then 'waiting_on_client'
      else 'nothing_pending'
    end,
    case when a.debt then 'artist' when a.awaiting_client then 'client' else 'nobody' end,
    greatest(0, floor(case when a.debt then a.inbound_hours
                           when a.awaiting_client then a.outbound_hours
                           else 0 end))::integer
  from a;
$$;

-- ---------------------------------------------------------------------------
-- 4. Allowed recommendation types (pure)
-- ---------------------------------------------------------------------------

create function crm_private.attention_allowed_actions(
  p_workflow_stage text,
  p_deposit_state text,
  p_has_future_tattoo_session boolean,
  p_has_future_consultation boolean,
  p_response_debt boolean
)
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select array_agg(a order by ord)
  from unnest(array[
    'request_information', 'artist_review', 'prepare_quote', 'offer_dates',
    'request_deposit', 'confirm_booking', 'follow_up', 'await_client', 'no_action'
  ]) with ordinality as t(a, ord)
  where not (
    (a = 'request_information' and (p_has_future_tattoo_session or p_has_future_consultation
                                    or p_workflow_stage in ('booked', 'aftercare')))
    or (a = 'request_deposit' and p_deposit_state in ('paid', 'requested', 'not_required'))
    or (a in ('offer_dates', 'confirm_booking') and p_has_future_tattoo_session)
    or (a = 'prepare_quote' and p_workflow_stage in ('booked', 'aftercare', 'deposit_pending', 'scheduling'))
    or (a = 'await_client' and p_response_debt)
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Conflicts between authoritative facts
-- ---------------------------------------------------------------------------

create function crm_private.attention_conflicts(p_artist_id uuid, p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(array_agg(code order by code), '{}'::text[])
  from (
    select 'deposit_paid_without_booking'::text as code
    where exists (
      select 1 from public.projects p
      where p.artist_id = p_artist_id and p.client_id = p_client_id and p.archived_at is null
        and p.deposit_status = 'paid' and p.status in ('draft', 'active')
        and not exists (
          select 1 from public.sessions s
          where s.project_id = p.id and s.cancelled_at is null
            and s.appointment_type in ('tattoo_session', 'touch_up')
            and s.status in ('proposed', 'confirmed', 'completed')))
    union all
    select 'consultation_booked_enquiry_new'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.appointment_type in ('in_person_consultation', 'video_consultation')
        and s.status in ('proposed', 'confirmed'))
      and exists (
      select 1 from public.enquiries e
      where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
        and e.status = 'new')
    union all
    select 'past_session_unresolved'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.status in ('proposed', 'confirmed') and s.end_at < clock_timestamp() - interval '1 day')
    union all
    select 'session_without_project'
    where exists (
      select 1 from public.sessions s
      where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
        and s.appointment_type = 'tattoo_session' and s.project_id is null
        and s.status in ('proposed', 'confirmed', 'completed'))
    union all
    select 'converted_enquiry_without_project'
    where exists (
      select 1 from public.enquiries e
      where e.artist_id = p_artist_id and e.client_id = p_client_id and e.archived_at is null
        and e.status = 'converted')
      and not exists (
      select 1 from public.projects p
      where p.artist_id = p_artist_id and p.client_id = p_client_id and p.archived_at is null)
    union all
    select 'ai_brief_stale'
    where exists (
      select 1 from public.client_ai_state st
      where st.artist_id = p_artist_id and st.client_id = p_client_id
        and st.source_watermark is distinct from crm_private.client_ai_watermark(p_artist_id, p_client_id))
  ) c;
$$;

-- ---------------------------------------------------------------------------
-- 6. The one bounded projection
-- ---------------------------------------------------------------------------

create function crm_private.client_attention(p_artist_id uuid, p_client_id uuid, p_now timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'client_id', p_client_id,
    'last_inbound_at', c.last_inbound_at,
    'last_inbound_source', c.last_inbound_source,
    'last_outbound_at', c.last_outbound_at,
    'last_speaker', c.last_speaker,
    'reply_state', c.reply_state,
    'reply_state_source', c.reply_state_source,
    'response_debt_candidate', c.response_debt_candidate,
    'workflow_stage', s.workflow_stage,
    'enquiry_status', s.enquiry_status,
    'deposit_state', s.deposit_state,
    'has_future_tattoo_session', s.has_future_tattoo_session,
    'has_future_consultation', s.has_future_consultation,
    'next_session_at', s.next_session_at,
    'sla_state', l.sla_state,
    'sla_reason', l.sla_reason,
    'waiting_on_candidate', l.waiting_on_candidate,
    'age_hours', l.age_hours,
    'allowed_actions', to_jsonb(crm_private.attention_allowed_actions(
      s.workflow_stage, s.deposit_state, s.has_future_tattoo_session, s.has_future_consultation,
      c.response_debt_candidate and c.reply_state <> 'no_reply_needed')),
    'conflicts', to_jsonb(crm_private.attention_conflicts(p_artist_id, p_client_id)),
    'has_valid_next_step', (
      s.workflow_stage in ('booked', 'dormant')
      or s.next_session_at is not null
      or exists (select 1 from public.client_ai_next_actions n
                 where n.artist_id = p_artist_id and n.client_id = p_client_id and n.status = 'open')
      or exists (select 1 from public.follow_ups f
                 where f.artist_id = p_artist_id and f.client_id = p_client_id and f.status = 'open')
    )
  )
  from crm_private.attention_comm_facts(p_artist_id, p_client_id) c,
       crm_private.attention_stage_facts(p_artist_id, p_client_id) s,
       crm_private.attention_sla(c.last_speaker, c.reply_state, c.last_inbound_at, c.last_outbound_at,
                                 s.workflow_stage, coalesce(p_now, clock_timestamp())) l;
$$;

revoke all on function crm_private.attention_comm_facts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.attention_stage_facts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.attention_sla(text, text, timestamptz, timestamptz, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function crm_private.attention_allowed_actions(text, text, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function crm_private.attention_conflicts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.client_attention(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Shadow comparison against the current AI brief
-- ---------------------------------------------------------------------------

create table crm_private.attention_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  report jsonb not null
);
create index attention_shadow_runs_created_idx on crm_private.attention_shadow_runs (created_at desc);
revoke all on crm_private.attention_shadow_runs from public, anon, authenticated, service_role;

comment on table crm_private.attention_shadow_runs is
  'Aggregate shadow comparisons of deterministic attention vs the AI brief. Counts and bounded codes only.';

create function crm_private.attention_shadow_report()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with scope as (
    select st.artist_id, st.client_id, st.brief ->> 'stage' as ai_stage,
           st.brief ->> 'waiting_on' as ai_waiting_on,
           crm_private.client_attention(st.artist_id, st.client_id) as a,
           (select n.action_type from public.client_ai_next_actions n
            where n.artist_id = st.artist_id and n.client_id = st.client_id and n.status = 'open'
            order by n.created_at desc limit 1) as ai_action
    from public.client_ai_state st
    join public.clients cl on cl.id = st.client_id and cl.archived_at is null
  ),
  rows as (
    select s.*,
      s.ai_stage is distinct from (s.a ->> 'workflow_stage') as stage_differs,
      s.ai_waiting_on is distinct from (s.a ->> 'waiting_on_candidate') as waiting_differs,
      s.ai_action is not null and not ((s.a -> 'allowed_actions') ? s.ai_action) as action_disallowed
    from scope s
  )
  select jsonb_build_object(
    'clients', count(*),
    'stage_disagreements', count(*) filter (where stage_differs),
    'waiting_on_disagreements', count(*) filter (where waiting_differs),
    'open_ai_actions_disallowed', count(*) filter (where action_disallowed),
    'stage_pairs', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(ai_stage, 'none') || '->' || coalesce(a ->> 'workflow_stage', 'none') as k, count(*) as n
        from rows where stage_differs group by 1) x), '{}'::jsonb),
    'waiting_pairs', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(ai_waiting_on, 'none') || '->' || coalesce(a ->> 'waiting_on_candidate', 'none') as k, count(*) as n
        from rows where waiting_differs group by 1) x), '{}'::jsonb),
    'sla_states', coalesce((select jsonb_object_agg(k, n) from (
        select a ->> 'sla_state' as k, count(*) as n from rows group by 1) x), '{}'::jsonb),
    'conflicts', coalesce((select jsonb_object_agg(k, n) from (
        select c as k, count(*) as n from rows, jsonb_array_elements_text(a -> 'conflicts') c group by 1) x), '{}'::jsonb),
    'without_valid_next_step', count(*) filter (where not (a ->> 'has_valid_next_step')::boolean),
    'reply_states', coalesce((select jsonb_object_agg(k, n) from (
        select a ->> 'reply_state' as k, count(*) as n from rows group by 1) x), '{}'::jsonb)
  )
  from rows;
$$;

revoke all on function crm_private.attention_shadow_report() from public, anon, authenticated, service_role;

-- Records at most one shadow run per hour. Called by the existing CRM agent
-- drain on its five-minute cadence; the throttle lives here, not in the Worker.
create function public.service_record_attention_shadow()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  -- Serialise overlapping ticks so the hourly throttle is atomic.
  perform pg_advisory_xact_lock(hashtext('crm_private.attention_shadow_runs'));

  if exists (select 1 from crm_private.attention_shadow_runs r
             where r.created_at > clock_timestamp() - interval '1 hour') then
    return jsonb_build_object('status', 'throttled');
  end if;

  insert into crm_private.attention_shadow_runs (report)
  values (crm_private.attention_shadow_report())
  returning id into v_id;

  delete from crm_private.attention_shadow_runs r
  where r.created_at < clock_timestamp() - interval '90 days';

  return jsonb_build_object('status', 'recorded', 'id', v_id);
end;
$$;

revoke all on function public.service_record_attention_shadow() from public, anon, authenticated;
grant execute on function public.service_record_attention_shadow() to service_role;
