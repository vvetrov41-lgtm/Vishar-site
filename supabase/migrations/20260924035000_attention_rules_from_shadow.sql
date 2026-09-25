-- 20260924035000_attention_rules_from_shadow.sql
--
-- Phase 2b: two attention rules corrected from production shadow evidence.
--
-- After 18 hourly shadow runs over 32 live clients, 26 waiting_on and 23
-- stage disagreements with the AI brief traced to two rule errors, not to the
-- model:
--
-- 1. An operator clearing a reply item in Today was read as "no reply
--    needed", so nobody was waiting. The acknowledgement contract (0286)
--    says the operator dealt with it, typically by replying in the provider
--    app. It is now `reply_state = handled`: the studio's turn, taken at the
--    moment it was handled, so the client is waiting and follow-up timers
--    run from then. An explicit no_reply_needed mark keeps its meaning.
-- 2. An enquiry still marked `new` after the studio engaged with it (an
--    outbound message, or clearing its Today item) was staged new_enquiry.
--    It is now gathering_information, as the browser Today already assumed.
--
-- Also: a Gmail reply acknowledgement is keyed by the client id (as
-- acknowledge_attention_item and the browser key it), not by a Gmail thread
-- context, so Gmail acknowledgements were never matched before.
--
-- Shadow mode only: nothing an operator sees changes.

drop function crm_private.client_attention(uuid, uuid, timestamptz);
drop function crm_private.attention_comm_facts(uuid, uuid);

create function crm_private.attention_comm_facts(p_artist_id uuid, p_client_id uuid)
returns table (
  last_inbound_at timestamptz,
  last_inbound_source text,
  last_outbound_at timestamptz,
  last_speaker text,
  reply_state text,
  reply_state_source text,
  response_debt_candidate boolean,
  handled_at timestamptz
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
      -- Submitting an enquiry asks for a response only while it is still
      -- new. Any operator workflow move on it (reviewing, converted, ...)
      -- has answered that submission, as the existing actionability rule
      -- already assumes.
      and (t.source <> 'enquiry' or exists (
        select 1 from public.enquiries e where e.id = t.source_id and e.status = 'new'))
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
  ack_rows as (
    -- An operator who cleared this client's reply item handled the version
    -- they SAW: `observed_at` is the source version the item showed. A newer
    -- inbound after that version is not covered, however late the click was.
    select a.observed_at, a.acknowledged_at
    from public.attention_acknowledgements a
    where a.artist_id = p_artist_id
      and (
        (a.item_kind = 'conversation_reply' and exists (
          select 1 from public.communication_conversations c
          where c.id = a.entity_id and c.artist_id = p_artist_id and c.client_id = p_client_id))
        -- A Gmail reply item is keyed by the client (acknowledge_attention_item).
        or (a.item_kind = 'gmail_reply' and a.entity_id = p_client_id)
        or (a.item_kind = 'new_enquiry' and exists (
          select 1 from public.enquiries e
          where e.id = a.entity_id and e.artist_id = p_artist_id and e.client_id = p_client_id))
      )
  ),
  ack as (
    select max(r.observed_at) as at from ack_rows r
  ),
  -- When the latest inbound was handled: the click of an acknowledgement that
  -- covers it, the earliest such click, never an unrelated newer one.
  handled as (
    select min(r.acknowledged_at) as at from ack_rows r, inbound
    where r.observed_at >= inbound.occurred_at
  ),
  facts as (
    select
      (select occurred_at from inbound) as last_inbound_at,
      (select source from inbound) as last_inbound_source,
      (select at from outbound) as last_outbound_at,
      (select reply_state from mark) as mark_state,
      (select source from mark) as mark_source,
      (select at from ack) as ack_at,
      (select at from handled) as ack_clicked_at
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
      -- Clearing a reply item in Today means the operator dealt with it,
      -- usually by answering in the provider app: the studio took its turn.
      -- It is not a claim that nothing was owed.
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'handled'
      else 'unknown'
    end,
    case
      when f.mark_state is not null then f.mark_source
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'operator_ack'
      else null
    end,
    f.last_inbound_at is not null
      and (f.last_outbound_at is null or f.last_inbound_at > f.last_outbound_at),
    case
      when f.mark_state is null and f.ack_at is not null and f.last_inbound_at is not null
           and f.ack_at >= f.last_inbound_at
        then greatest(f.ack_clicked_at, f.last_inbound_at)
    end
  from facts f;
$$;

create or replace function crm_private.attention_stage_facts(p_artist_id uuid, p_client_id uuid)
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
    select e.id, e.status::text as status, e.created_at
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
      exists (select 1 from projects) as has_open_project,
      -- A new enquiry the studio has already engaged with: an outbound
      -- message, or an operator clearing its Today item, after it arrived.
      exists (
        select 1 from enquiry en
        where en.status = 'new' and (
          exists (select 1 from crm_private.client_timeline_items(p_artist_id, p_client_id) t
                  where t.direction = 'outbound' and t.occurred_at >= en.created_at)
          -- This enquiry's own Today item, or a reply item for this client,
          -- cleared after the enquiry arrived. A sibling enquiry's item does
          -- not engage this one.
          or exists (select 1 from public.attention_acknowledgements a
                     where a.artist_id = p_artist_id and a.acknowledged_at >= en.created_at
                       and ((a.item_kind = 'new_enquiry' and a.entity_id = en.id)
                            or (a.item_kind = 'conversation_reply' and a.entity_id in (
                                  select c.id from public.communication_conversations c
                                  where c.artist_id = p_artist_id and c.client_id = p_client_id))
                            or (a.item_kind = 'gmail_reply' and a.entity_id = p_client_id))))
      ) as enquiry_engaged
  )
  select
    case
      when f.future_tattoo then 'booked'
      when f.recent_completed then 'aftercare'
      when f.deposit_state = 'requested' then 'deposit_pending'
      when f.deposit_state = 'paid' then 'scheduling'
      when f.future_consultation then 'awaiting_artist_review'
      when f.enquiry_status = 'new' and f.enquiry_engaged then 'gathering_information'
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
    'handled_at', c.handled_at,
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
      c.response_debt_candidate and c.reply_state not in ('no_reply_needed', 'handled'))),
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
       -- A handled message counts as the studio's turn, taken when it was handled.
       crm_private.attention_sla(
         case when c.reply_state = 'handled' then 'studio' else c.last_speaker end,
         c.reply_state, c.last_inbound_at,
         case when c.reply_state = 'handled' then greatest(c.last_outbound_at, c.handled_at) else c.last_outbound_at end,
         s.workflow_stage, coalesce(p_now, clock_timestamp())) l;
$$;

revoke all on function crm_private.attention_comm_facts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.attention_stage_facts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.client_attention(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
