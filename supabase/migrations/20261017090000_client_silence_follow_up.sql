-- Client silence: one follow-up per conversation cycle, decided by people.
--
-- Production on 2026-10-17: 25 of 36 Today items were "client went quiet"
-- (Vladimir only) and none could be dismissed. Of those, 7 had no studio
-- message at all (the clock started when the operator cleared a reply or
-- enquiry item) and 3 started from a reaction the artist put on the client's
-- closing line. specs/client-silence-follow-up has the analysis.
--
-- 1. The studio's turn is a person's message: provider-accepted, from the CRM
--    or the provider app, an actionable type. Reactions, automations (booking
--    cards) and system email are not a turn and never start the clock.
-- 2. A studio reaction after the client's newest message still means "seen,
--    nothing owed" (20261004190000), unless that message asks something:
--    it contains a question mark, or the reply classifier marked it
--    reply_required. The classifier can only keep an item open, never hide
--    one. Today's reply row and the client attention facts apply the same
--    rule.
-- 3. Clearing a reply or enquiry item in Today still answers the client's
--    message, but it no longer starts "waiting on the client": that needs a
--    real studio message.
-- 4. A cycle is (artist, client, time of the studio's last message). The
--    7-day and 21-day items share one acknowledgement keyed by that time:
--    "not now" (resurface_at) and "don't remind" (resurface_at null) cover the
--    whole cycle and stop applying as soon as either side writes again.
-- 5. A manual follow-up wins: an open one hides the automatic item, and one
--    completed or cancelled during the cycle closes that cycle. Follow-ups
--    reach the client through client_id, enquiry or project.
-- 6. A proposed appointment (its own Today row) or a paid deposit means the
--    studio is not chasing the client, so no silence item either.
-- 7. get_waiting_on_clients_count gives Statistics the same number as the
--    Today block, from the same function.
--
-- Nothing sends a message, closes an enquiry or touches a booking. Every
-- replaced function is checked against the definition measured on production
-- on 2026-10-17 and the migration fails closed on drift.

do $guard$
declare
  v_expected constant jsonb := jsonb_build_object(
    'crm_private.pulse_items(uuid,boolean,boolean,timestamp with time zone)', '72f481bf32c80e8429ef64c01aeeb768',
    'crm_private.pulse_attention_batch(uuid,timestamp with time zone)', '13f168a6803d2636db3cfb4f26023fda',
    'crm_private.attention_comm_facts(uuid,uuid)', '9023b6ecdd5b056ed00f33751a9ad905',
    'crm_private.client_attention(uuid,uuid,timestamp with time zone)', '1ba2634232a9399a4551be79c1061dc4',
    'crm_private.pulse_client_attention(uuid,uuid,timestamp with time zone)', 'c7fe9cbc53c5a8e953403e32540e4c06',
    'crm_private.conversation_awaiting_reply_since(uuid)', '6d832b1a1a38fd75f82bdc1e36d6ee14',
    'crm_private.conversation_last_studio_reply_at(uuid)', 'c226995d392466d97d4fcdca3306c542',
    'acknowledge_attention_item(uuid,text,uuid,timestamp with time zone)', '6e86e53d4994289c63d01079aa1ea76d',
    'clear_attention_acknowledgement(uuid,text,uuid)', '5873015bbb87730e88e53ff9323cc304'
  );
  v_key text;
  v_actual text;
begin
  for v_key in select jsonb_object_keys(v_expected) loop
    select md5(p.prosrc) into v_actual from pg_proc p where p.oid = v_key::regprocedure;
    if v_actual is distinct from v_expected ->> v_key then
      raise exception 'client silence: % drifted since the 2026-10-17 baseline (md5 %)', v_key, v_actual;
    end if;
  end loop;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 1. A studio reaction that acknowledges the client's message
-- ---------------------------------------------------------------------------

-- When the studio acknowledged this inbound with a reaction, or null when it
-- did not or when the message asks something a reaction cannot answer. The
-- CRM does not store which emoji or which message a reaction points at, so
-- only order and the inbound itself are used.
create function crm_private.studio_reaction_acknowledged_at(p_inbound_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select min(coalesce(r.sent_at, r.provider_timestamp, r.created_at))
  from public.communication_messages i
  join public.communication_conversations c
    on c.id = i.conversation_id and c.artist_id = i.artist_id
  join public.communication_messages r
    on r.conversation_id = i.conversation_id and r.artist_id = i.artist_id
  where i.id = p_inbound_id
    and i.direction = 'inbound'
    and r.direction = 'outbound'
    and r.message_type = 'reaction'
    and r.origin in ('crm', 'provider_app')
    and r.status in ('sent', 'delivered', 'read')
    and coalesce(r.sent_at, r.provider_timestamp, r.created_at) > coalesce(i.provider_timestamp, i.created_at)
    -- A question stays open whatever the reaction.
    and coalesce(i.body, '') !~ '[?？]'
    -- The classifier may keep it open; it never closes it on its own. A mark
    -- names the exact inbound it classified (service_record_client_reply_state
    -- stores its time), so a mark on a later message elsewhere does not
    -- reopen this one.
    and not exists (
      select 1 from crm_private.client_reply_marks m
      where c.client_id is not null
        and m.artist_id = c.artist_id
        and m.client_id = c.client_id
        and m.message_at = coalesce(i.provider_timestamp, i.created_at)
        and m.reply_state = 'reply_required');
$$;

revoke all on function crm_private.studio_reaction_acknowledged_at(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.studio_reaction_acknowledged_at(uuid) is
  'When a studio reaction after this inbound acknowledged it. Null without a reaction, when the message contains a question mark, or when it is marked reply_required.';

-- The studio's newest message in the conversation: a person's actionable
-- message the provider accepted. A reaction is no longer a reply on its own;
-- conversation_awaiting_reply_since decides what a reaction acknowledges.
create or replace function crm_private.conversation_last_studio_reply_at(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select max(coalesce(m.sent_at, m.provider_timestamp, m.created_at))
  from public.communication_messages m
  where m.conversation_id = p_conversation_id
    and m.direction = 'outbound'
    and m.origin in ('crm', 'provider_app')
    and m.status in ('sent', 'delivered', 'read')
    and crm_private.communication_event_is_actionable(m.message_type);
$$;

revoke all on function crm_private.conversation_last_studio_reply_at(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.conversation_last_studio_reply_at(uuid) is
  'The studio''s newest provider-accepted message from the CRM or the provider app. Reactions, edits, revokes, unsupported echoes, automations, queued and failed sends are not a message.';

create or replace function crm_private.conversation_awaiting_reply_since(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when x.inbound_at is not null
     and x.inbound_at > coalesce(crm_private.conversation_last_studio_reply_at(p_conversation_id), '-infinity'::timestamptz)
     and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
     and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
    then x.inbound_at
  end
  from (
    select m.id as inbound_id, coalesce(m.provider_timestamp, m.created_at) as inbound_at
    from public.communication_messages m
    where m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
    limit 1
  ) x;
$$;

revoke all on function crm_private.conversation_awaiting_reply_since(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.conversation_awaiting_reply_since(uuid) is
  'The newest actionable inbound time while no studio message, confirmed booking or acknowledging reaction (crm_private.studio_reaction_acknowledged_at) answered it; null when nothing waits on the studio.';

-- ---------------------------------------------------------------------------
-- 2. Client communication facts
-- ---------------------------------------------------------------------------

create or replace function crm_private.attention_comm_facts(p_artist_id uuid, p_client_id uuid)
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
    select t.source, t.source_id, t.direction, t.occurred_at
    from crm_private.client_timeline_items(p_artist_id, p_client_id) t
    where t.direction in ('inbound', 'outbound')
      and t.source in ('communication', 'email', 'gmail', 'enquiry')
      and t.occurred_at is not null
      -- The studio's turn is a person's message the provider accepted: not a
      -- reaction, an automation (booking card), a queued or a failed send.
      and (t.source <> 'communication' or t.direction <> 'outbound' or exists (
        select 1 from public.communication_messages m
        where m.id = t.source_id
          and m.origin in ('crm'::public.communication_origin, 'provider_app'::public.communication_origin)
          and m.status in ('sent'::public.communication_status,
                           'delivered'::public.communication_status,
                           'read'::public.communication_status)
          and crm_private.communication_event_is_actionable(m.message_type)))
      -- System email (lifecycle reminders) is not the studio answering.
      and (t.source <> 'email' or exists (
        select 1 from public.email_messages x
        where x.id = t.source_id and x.created_by_kind is distinct from 'system'))
      -- A reaction, edit, revoke or unsupported event asks nothing of the
      -- studio (crm_private.communication_event_is_actionable).
      and (t.source <> 'communication' or t.direction <> 'inbound' or exists (
        select 1 from public.communication_messages m
        where m.id = t.source_id
          and crm_private.communication_event_is_actionable(m.message_type)))
      -- Submitting an enquiry asks for a response only while it is still new.
      and (t.source <> 'enquiry' or exists (
        select 1 from public.enquiries e where e.id = t.source_id and e.status = 'new'))
  ),
  inbound as (
    select i.occurred_at, i.source, i.source_id from items i where i.direction = 'inbound'
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
    select a.observed_at, a.acknowledged_at
    from public.attention_acknowledgements a
    where a.artist_id = p_artist_id
      and (
        (a.item_kind = 'conversation_reply' and exists (
          select 1 from public.communication_conversations c
          where c.id = a.entity_id and c.artist_id = p_artist_id and c.client_id = p_client_id))
        or (a.item_kind = 'gmail_reply' and a.entity_id = p_client_id)
        or (a.item_kind = 'new_enquiry' and exists (
          select 1 from public.enquiries e
          where e.id = a.entity_id and e.artist_id = p_artist_id and e.client_id = p_client_id))
      )
  ),
  ack as (
    select max(r.observed_at) as at from ack_rows r
  ),
  handled as (
    select min(r.acknowledged_at) as at from ack_rows r, inbound
    where r.observed_at >= inbound.occurred_at
  ),
  booked as (
    select crm_private.inbound_message_handled_by_booking(inbound.source_id) as at
    from inbound where inbound.source = 'communication'
  ),
  reacted as (
    select crm_private.studio_reaction_acknowledged_at(inbound.source_id) as at
    from inbound where inbound.source = 'communication'
  ),
  facts as (
    select
      (select at from booked) as booked_at,
      (select at from reacted) as reacted_at,
      (select occurred_at from inbound) as last_inbound_at,
      (select source from inbound) as last_inbound_source,
      (select at from outbound) as last_outbound_at,
      -- Operator mark > Today acknowledgement > booking evidence > classifier
      -- reply_required (20261006130000).
      (select m.reply_state from mark m
       where m.source = 'operator' or m.reply_state <> 'reply_required'
          or ((select at from booked) is null
              and not coalesce((select at from ack) >= (select occurred_at from inbound), false))) as mark_state,
      (select m.source from mark m
       where m.source = 'operator' or m.reply_state <> 'reply_required'
          or ((select at from booked) is null
              and not coalesce((select at from ack) >= (select occurred_at from inbound), false))) as mark_source,
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
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'handled'
      when f.booked_at is not null then 'handled'
      when f.reacted_at is not null then 'handled'
      else 'unknown'
    end,
    case
      when f.mark_state is not null then f.mark_source
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'operator_ack'
      when f.booked_at is not null then 'booking_evidence'
      when f.reacted_at is not null then 'studio_reaction'
      else null
    end,
    f.last_inbound_at is not null
      and (f.last_outbound_at is null or f.last_inbound_at > f.last_outbound_at),
    case
      when f.mark_state is null and f.ack_at is not null and f.last_inbound_at is not null
           and f.ack_at >= f.last_inbound_at
        then greatest(f.ack_clicked_at, f.last_inbound_at)
      when f.mark_state is null and f.booked_at is not null then f.booked_at
      when f.mark_state is null and f.reacted_at is not null then f.reacted_at
    end
  from facts f;
$$;

revoke all on function crm_private.attention_comm_facts(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Waiting on the client starts only from a studio message
-- ---------------------------------------------------------------------------
--
-- A handled client message (acknowledged, booked or reacted to) owes nothing,
-- but without a studio message after it nobody is waiting on the client
-- either. 'handled' is passed to attention_sla as the speaker, which is
-- neither 'client' nor 'studio': nothing pending.

create or replace function crm_private.client_attention(p_artist_id uuid, p_client_id uuid, p_now timestamptz default null)
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
    'confirm_booking_ready', r.ready,
    'sla_state', l.sla_state,
    'sla_reason', l.sla_reason,
    'waiting_on_candidate', l.waiting_on_candidate,
    'age_hours', l.age_hours,
    'allowed_actions', to_jsonb(crm_private.attention_allowed_actions(
      s.workflow_stage, s.deposit_state, s.has_future_tattoo_session, s.has_future_consultation,
      c.response_debt_candidate and c.reply_state not in ('no_reply_needed', 'handled'),
      r.ready)),
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
       (select crm_private.attention_confirm_booking_ready(p_artist_id, p_client_id) as ready) r,
       crm_private.attention_sla(
         case when c.reply_state = 'handled' and c.last_speaker = 'client' then 'handled' else c.last_speaker end,
         c.reply_state, c.last_inbound_at, c.last_outbound_at,
         case when exists (
                select 1 from public.sessions fs
                where fs.artist_id = p_artist_id and fs.client_id = p_client_id
                  and fs.status = 'confirmed' and fs.cancelled_at is null
                  and fs.end_at >= coalesce(p_now, clock_timestamp()))
              and s.workflow_stage not in ('booked', 'aftercare', 'dormant')
           then 'booked' else s.workflow_stage end,
         coalesce(p_now, clock_timestamp())) l;
$$;

revoke all on function crm_private.client_attention(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function crm_private.pulse_client_attention(
  p_artist_id uuid,
  p_client_id uuid,
  p_now timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'client_id', p_client_id,
    'last_outbound_at', c.last_outbound_at,
    'workflow_stage', s.workflow_stage,
    'sla_state', l.sla_state,
    'sla_reason', l.sla_reason,
    'conflicts', to_jsonb(crm_private.pulse_conflicts(p_artist_id, p_client_id))
  )
  from crm_private.attention_comm_facts(p_artist_id, p_client_id) c,
       crm_private.attention_stage_facts(p_artist_id, p_client_id) s,
       crm_private.attention_sla(
         case when c.reply_state = 'handled' and c.last_speaker = 'client' then 'handled' else c.last_speaker end,
         c.reply_state,
         c.last_inbound_at,
         c.last_outbound_at,
         case
           when exists (
             select 1
             from public.sessions fs
             where fs.artist_id = p_artist_id
               and fs.client_id = p_client_id
               and fs.status = 'confirmed'
               and fs.cancelled_at is null
               and fs.end_at >= coalesce(p_now, clock_timestamp())
           )
             and s.workflow_stage not in ('booked', 'aftercare', 'dormant')
             then 'booked'
           else s.workflow_stage
         end,
         coalesce(p_now, clock_timestamp())
       ) l;
$$;

revoke all on function crm_private.pulse_client_attention(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- The artist-scoped batch Today uses: the same rules as attention_comm_facts.
create or replace function crm_private.pulse_attention_batch(p_artist_id uuid, p_now timestamptz default null)
returns table(client_id uuid, a jsonb)
language sql stable security definer
set search_path = pg_catalog, public, crm_private
as $batch$
with active as materialized (
  select client_id from crm_private.pulse_active_clients(p_artist_id)
), items as materialized (
  select v.client_id, 'communication'::text source, m.id source_id, m.direction::text direction,
    coalesce(m.provider_timestamp,m.created_at) occurred_at
  from public.communication_messages m
  join public.communication_conversations v on v.id=m.conversation_id and v.artist_id=m.artist_id
  join active ac on ac.client_id=v.client_id
  where m.artist_id=p_artist_id
    and ((m.direction='outbound' and m.status in ('sent','delivered','read')
          and m.origin in ('crm','provider_app')
          and crm_private.communication_event_is_actionable(m.message_type))
      or (m.direction='inbound' and crm_private.communication_event_is_actionable(m.message_type)))
  union all
  select x.client_id,'email',x.id,'outbound',x.sent_at
  from public.email_messages x join active ac on ac.client_id=x.client_id
  where x.artist_id=p_artist_id and x.status='sent' and x.sent_at is not null
    and x.created_by_kind is distinct from 'system'
  union all
  select g.client_id,'gmail',g.id,g.direction,g.occurred_at
  from crm_private.gmail_client_ai_excerpts g join active ac on ac.client_id=g.client_id
  where g.artist_id=p_artist_id and g.direction in ('inbound','outbound') and g.occurred_at is not null
  union all
  select e.client_id,'enquiry',e.id,'inbound',e.created_at
  from public.enquiries e join active ac on ac.client_id=e.client_id
  where e.artist_id=p_artist_id and e.archived_at is null and e.status='new'
), inbound as materialized (
  select distinct on (client_id) client_id,occurred_at,source,source_id
  from items where direction='inbound' and occurred_at is not null
  order by client_id,occurred_at desc
), outbound as (
  select client_id,max(occurred_at) at from items where direction='outbound' group by client_id
), marks as (
  select distinct on (m.client_id) m.client_id,m.reply_state,m.source
  from crm_private.client_reply_marks m join inbound i on i.client_id=m.client_id
  where m.artist_id=p_artist_id and m.message_at>=i.occurred_at
  order by m.client_id,m.created_at desc
), ack_rows as materialized (
  select c.client_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a
  join public.communication_conversations c on c.id=a.entity_id and c.artist_id=a.artist_id
  where a.artist_id=p_artist_id and a.item_kind='conversation_reply'
  union all
  select a.entity_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a where a.artist_id=p_artist_id and a.item_kind='gmail_reply'
  union all
  select e.client_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a join public.enquiries e on e.id=a.entity_id and e.artist_id=a.artist_id
  where a.artist_id=p_artist_id and a.item_kind='new_enquiry'
), ack as (
  select r.client_id,max(r.observed_at) at,
    min(r.acknowledged_at) filter(where r.observed_at>=i.occurred_at) clicked_at
  from ack_rows r left join inbound i on i.client_id=r.client_id group by r.client_id
), booked as materialized (
  select i.client_id,crm_private.inbound_message_handled_by_booking(i.source_id) at
  from inbound i where i.source='communication'
), reacted as materialized (
  select i.client_id,crm_private.studio_reaction_acknowledged_at(i.source_id) at
  from inbound i where i.source='communication'
), facts as materialized (
  select ac.client_id,i.occurred_at last_inbound_at,i.source last_inbound_source,
    o.at last_outbound_at,b.at booked_at,rx.at reacted_at,a.at ack_at,a.clicked_at ack_clicked_at,
    case when m.source='operator' or m.reply_state<>'reply_required'
      or (b.at is null and not coalesce(a.at>=i.occurred_at,false)) then m.reply_state end mark_state
  from active ac left join inbound i using(client_id) left join outbound o using(client_id)
  left join marks m using(client_id) left join ack a using(client_id) left join booked b using(client_id)
  left join reacted rx using(client_id)
), comm as materialized (
  select f.*,
    case when f.last_inbound_at is null and f.last_outbound_at is null then 'none'
      when f.last_outbound_at is null or f.last_inbound_at>f.last_outbound_at then 'client' else 'studio' end last_speaker,
    case when f.mark_state is not null then f.mark_state
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at>=f.last_inbound_at then 'handled'
      when f.booked_at is not null then 'handled'
      when f.reacted_at is not null then 'handled' else 'unknown' end reply_state
  from facts f
), stages as materialized (
  select ac.client_id,s.workflow_stage from active ac
  cross join lateral crm_private.attention_stage_facts(p_artist_id,ac.client_id) s
), confirmed as (
  select distinct s.client_id from public.sessions s
  where s.artist_id=p_artist_id and s.status='confirmed' and s.cancelled_at is null
    and s.end_at>=coalesce(p_now,clock_timestamp())
)
select c.client_id,jsonb_build_object(
  'client_id',c.client_id,'last_outbound_at',c.last_outbound_at,'workflow_stage',s.workflow_stage,
  'sla_state',l.sla_state,'sla_reason',l.sla_reason,
  'conflicts',to_jsonb(crm_private.pulse_conflicts(p_artist_id,c.client_id))
) a
from comm c join stages s using(client_id) left join confirmed cf using(client_id)
cross join lateral crm_private.attention_sla(
  case when c.reply_state='handled' and c.last_speaker='client' then 'handled' else c.last_speaker end,
  c.reply_state,c.last_inbound_at,c.last_outbound_at,
  case when cf.client_id is not null and s.workflow_stage not in ('booked','aftercare','dormant') then 'booked' else s.workflow_stage end,
  coalesce(p_now,clock_timestamp())
) l;
$batch$;

revoke all on function crm_private.pulse_attention_batch(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The operator's decision about one silence cycle
-- ---------------------------------------------------------------------------

alter table public.attention_acknowledgements
  add column resurface_at timestamptz;

alter table public.attention_acknowledgements
  drop constraint attention_acknowledgements_kind_allowed,
  add constraint attention_acknowledgements_kind_allowed check (
    item_kind in ('conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding', 'client_silence')),
  add constraint attention_acknowledgements_resurface_client_silence check (
    resurface_at is null or item_kind = 'client_silence');

comment on column public.attention_acknowledgements.resurface_at is
  'client_silence only: the item returns at this time ("not now"). Null means it stays hidden for the acknowledged cycle ("don''t remind").';

-- The current silence cycle for a client: the studio's last message while the
-- client has not written since. Null when there is no cycle.
create function crm_private.client_silence_cycle_at(p_artist_id uuid, p_client_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select f.last_outbound_at
  from crm_private.attention_comm_facts(p_artist_id, p_client_id) f
  where f.last_speaker = 'studio';
$$;

revoke all on function crm_private.client_silence_cycle_at(uuid, uuid)
  from public, anon, authenticated, service_role;

-- One implementation for "handled" (the existing acknowledgement, unchanged
-- signature) and "not now" (snooze_attention_item below).
create function crm_private.record_attention_acknowledgement(
  p_artist_id uuid,
  p_item_kind text,
  p_entity_id uuid,
  p_observed_at timestamptz,
  p_resurface_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_source_at timestamptz;
  v_actor_kind text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_artist_id is null or p_item_kind is null or p_entity_id is null or p_observed_at is null then
    raise exception 'artist, kind, entity and observed time are required' using errcode = '22023';
  end if;
  if p_item_kind not in (
    'conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding', 'client_silence'
  ) then
    raise exception 'attention item kind is not dismissible' using errcode = '22023';
  end if;
  if p_observed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'attention item time cannot be in the future' using errcode = '22023';
  end if;
  if p_resurface_at is not null and p_item_kind <> 'client_silence' then
    raise exception 'only a client silence item can return later' using errcode = '22023';
  end if;
  if p_resurface_at is not null
     and (p_resurface_at <= clock_timestamp() or p_resurface_at > clock_timestamp() + interval '366 days') then
    raise exception 'an item can return between now and one year ahead' using errcode = '22023';
  end if;
  perform crm_private.require_artist_access(p_artist_id, 'manage_notifications');
  case p_item_kind
    when 'conversation_reply' then
      select c.client_id, c.enquiry_id, c.last_inbound_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.communication_conversations c
      where c.id = p_entity_id and c.artist_id = p_artist_id;
    when 'gmail_reply' then
      select c.id, null::uuid, p_observed_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.clients c
      join public.artists a on a.workspace_id = c.workspace_id
      where c.id = p_entity_id and a.id = p_artist_id and c.archived_at is null;
    when 'new_enquiry' then
      select e.client_id, e.id, e.created_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.enquiries e
      where e.id = p_entity_id and e.artist_id = p_artist_id and e.archived_at is null;
    when 'deposit_outstanding' then
      select p.client_id, p.enquiry_id, p.id, p.updated_at
        into v_client_id, v_enquiry_id, v_project_id, v_source_at
      from public.projects p
      where p.id = p_entity_id and p.artist_id = p_artist_id and p.archived_at is null;
    when 'client_silence' then
      select c.id, null::uuid, crm_private.client_silence_cycle_at(p_artist_id, c.id)
        into v_client_id, v_enquiry_id, v_source_at
      from public.clients c
      join public.artists a on a.workspace_id = c.workspace_id
      where c.id = p_entity_id and a.id = p_artist_id and c.archived_at is null;
  end case;
  if v_source_at is null then
    raise exception 'attention item does not exist in this artist scope' using errcode = 'P0002';
  end if;
  -- A stale screen may acknowledge the version it actually showed, but it may
  -- not claim to have handled source activity that had not happened yet.
  if p_observed_at > v_source_at + interval '5 minutes'
     and p_item_kind <> 'gmail_reply' then
    raise exception 'attention item version is newer than its source' using errcode = '22023';
  end if;
  insert into public.attention_acknowledgements (
    artist_id, item_kind, entity_id, observed_at, acknowledged_at, acknowledged_by, resurface_at
  ) values (
    p_artist_id, p_item_kind, p_entity_id, p_observed_at, clock_timestamp(), auth.uid(), p_resurface_at
  )
  on conflict (artist_id, item_kind, entity_id) do update
  set observed_at = greatest(public.attention_acknowledgements.observed_at, excluded.observed_at),
      -- A decision about an older version never overrides one about a newer.
      resurface_at = case
        when excluded.observed_at >= public.attention_acknowledgements.observed_at then excluded.resurface_at
        else public.attention_acknowledgements.resurface_at
      end,
      acknowledged_at = clock_timestamp(),
      acknowledged_by = auth.uid();
  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    p_artist_id,
    case when p_resurface_at is null then 'attention.dismissed' else 'attention.snoozed' end,
    v_actor_kind,
    auth.uid(),
    v_client_id,
    v_enquiry_id,
    v_project_id,
    null,
    null,
    jsonb_strip_nulls(jsonb_build_object('kind', p_item_kind, 'resurface_at', p_resurface_at))
  );
  return jsonb_strip_nulls(jsonb_build_object(
    'artist_id', p_artist_id,
    'item_kind', p_item_kind,
    'entity_id', p_entity_id,
    'observed_at', p_observed_at,
    'resurface_at', p_resurface_at,
    'acknowledged', true
  ));
end;
$$;

revoke all on function crm_private.record_attention_acknowledgement(uuid, text, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.acknowledge_attention_item(
  p_artist_id uuid,
  p_item_kind text,
  p_entity_id uuid,
  p_observed_at timestamptz
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.record_attention_acknowledgement(p_artist_id, p_item_kind, p_entity_id, p_observed_at, null);
$$;

comment on function public.acknowledge_attention_item(uuid,text,uuid,timestamptz) is
  'Acknowledges one exact dismissible Today item version after validating artist scope and source ownership. For client_silence it means "don''t remind" for that cycle. It changes no enquiry, conversation, project, appointment or payment state.';

-- "Not now": the client silence item returns at p_resurface_at, unless either
-- side writes first (a new cycle).
create function public.snooze_attention_item(
  p_artist_id uuid,
  p_item_kind text,
  p_entity_id uuid,
  p_observed_at timestamptz,
  p_resurface_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_resurface_at is null then
    raise exception 'a return time is required' using errcode = '22023';
  end if;
  return crm_private.record_attention_acknowledgement(
    p_artist_id, p_item_kind, p_entity_id, p_observed_at, p_resurface_at);
end;
$$;

revoke all on function public.snooze_attention_item(uuid, text, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.snooze_attention_item(uuid, text, uuid, timestamptz, timestamptz)
  to authenticated;

comment on function public.snooze_attention_item(uuid, text, uuid, timestamptz, timestamptz) is
  'Hides one client_silence Today item until p_resurface_at (at most a year). A new message from either side starts a new cycle the snooze does not cover. Changes no business record.';

create or replace function public.clear_attention_acknowledgement(
  p_artist_id uuid,
  p_item_kind text,
  p_entity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_artist_id is null or p_item_kind is null or p_entity_id is null then
    raise exception 'artist, kind and entity are required' using errcode = '22023';
  end if;
  if p_item_kind not in ('conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding', 'client_silence') then
    raise exception 'attention item kind is not dismissible' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'manage_notifications');

  delete from public.attention_acknowledgements a
  where a.artist_id = p_artist_id and a.item_kind = p_item_kind and a.entity_id = p_entity_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    perform crm_private.log_artist_activity(
      p_artist_id,
      'attention.restored',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      case when p_item_kind = 'client_silence' then p_entity_id end, null, null, null, null,
      jsonb_build_object('kind', p_item_kind)
    );
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id, 'item_kind', p_item_kind, 'entity_id', p_entity_id,
    'cleared', v_deleted > 0
  );
end;
$$;

revoke all on function public.clear_attention_acknowledgement(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.clear_attention_acknowledgement(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What the operator sees about a silent client
-- ---------------------------------------------------------------------------

-- Where the cycle's studio message was sent and how it began, for the Today
-- row. CRM only: Telegram /today never receives it.
create function crm_private.client_silence_context(p_artist_id uuid, p_client_id uuid, p_cycle_at timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'conversation_id', lt.conversation_id,
    'channel', lt.channel,
    'message_type', lt.message_type,
    'preview', case when lt.message_type in ('text', 'email') then left(btrim(lt.body), 80) end,
    'client_reacted', exists (
      select 1
      from public.communication_messages m
      join public.communication_conversations v on v.id = m.conversation_id and v.artist_id = m.artist_id
      where v.client_id = p_client_id and m.artist_id = p_artist_id
        and m.direction = 'inbound' and m.message_type = 'reaction'
        and coalesce(m.provider_timestamp, m.created_at) > p_cycle_at)
  )
  from (select 1) one
  left join lateral (
    select x.conversation_id, x.channel, x.message_type, x.body
    from (
      select m.conversation_id, m.channel::text as channel, m.message_type, m.body,
             coalesce(m.provider_timestamp, m.created_at) as at, m.id::text as id
      from public.communication_messages m
      join public.communication_conversations v on v.id = m.conversation_id and v.artist_id = m.artist_id
      where v.client_id = p_client_id and m.artist_id = p_artist_id
        and m.direction = 'outbound'
        and m.origin in ('crm', 'provider_app')
        and m.status in ('sent', 'delivered', 'read')
        and crm_private.communication_event_is_actionable(m.message_type)
      union all
      select null::uuid, 'email', 'email', e.subject, e.sent_at, e.id::text
      from public.email_messages e
      where e.client_id = p_client_id and e.artist_id = p_artist_id
        and e.status = 'sent' and e.sent_at is not null
        and e.created_by_kind is distinct from 'system'
      -- Mail the artist sent from Gmail, which pulse_attention_batch also
      -- counts as the studio's turn.
      union all
      select null::uuid, 'email', 'email', g.subject, g.occurred_at, g.id::text
      from crm_private.gmail_client_ai_excerpts g
      where g.client_id = p_client_id and g.artist_id = p_artist_id
        and g.direction = 'outbound' and g.occurred_at is not null
    ) x
    order by x.at desc, x.id desc
    limit 1
  ) lt on true;
$$;

revoke all on function crm_private.client_silence_context(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function crm_private.pulse_items(
  p_artist_id uuid,
  p_include_finance boolean,
  p_include_integrations boolean,
  p_now timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at, a.resurface_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as materialized (
    select * from crm_private.pulse_attention_batch(p_artist_id, (select t from now_))
  ),
  live_sessions as (
    select s.* from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null
      and s.status in ('draft', 'proposed', 'confirmed')
  ),
  conv as (
    select c.*, crm_private.conversation_awaiting_reply_since(c.id) as awaiting_since
    from public.communication_conversations c
    where c.artist_id = p_artist_id and c.state = 'open'
  ),
  -- Email grouped the way the Inbox groups it: one row per real conversation.
  email_threads as (
    select
      case when m.enquiry_id is not null then 'enquiry-' || m.enquiry_id
           when m.client_id is not null then 'client-' || m.client_id
           else 'message-' || m.id end as thread_key,
      m.*
    from public.email_messages m
    where m.artist_id = p_artist_id
  ),
  email_thread_state as (
    select t.thread_key,
      bool_or(t.status = 'failed') as send_failed,
      bool_or(t.status = 'draft' and t.created_by_kind = 'human') as awaiting_approval,
      max(t.created_at) as last_activity_at,
      (array_agg(t.subject order by t.created_at desc, t.id desc))[1] as subject,
      (array_agg(t.client_id order by t.created_at desc, t.id desc))[1] as client_id,
      (array_agg(t.to_email order by t.created_at desc, t.id desc))[1] as to_email
    from email_threads t
    where t.thread_key not like 'message-%'
    group by t.thread_key
  ),
  -- Manual follow-ups by the client they concern: directly, or through the
  -- enquiry or project they were created on.
  client_follow_ups as (
    select coalesce(f.client_id, e.client_id, p.client_id) as client_id, f.status,
           coalesce(f.completed_at, f.cancelled_at) as closed_at
    from public.follow_ups f
    left join public.enquiries e on e.id = f.enquiry_id
    left join public.projects p on p.id = f.project_id
    where f.artist_id = p_artist_id
  ),
  raw as (
    -- A client asking to move a booked time.
    select 'reschedule_requested'::text as kind, 'reschedule-' || s.id as key, s.client_id,
           null::text as subject, '/appointments/' || s.id as href, s.start_at as at, null::text as detail,
           'client_asked_to_reschedule'::text as reason, null::jsonb as ack
    from live_sessions s
    where s.client_response = 'reschedule_requested' and s.start_at >= (select t from now_)

    union all
    -- Linked conversation whose newest actionable inbound the studio has
    -- not answered (crm_private.conversation_awaiting_reply_since).
    select 'reply', 'reply-' || c.id, c.client_id,
           coalesce(c.external_display_label, c.external_username),
           '/inbox/' || c.id, c.awaiting_since, c.channel::text,
           'client_message_unanswered',
           jsonb_build_object('kind', 'conversation_reply', 'entity_id', c.id, 'observed_at', c.awaiting_since)
    from conv c
    where c.awaiting_since is not null
      and (c.client_id is not null or c.enquiry_id is not null)

    union all
    -- A known client whose newest Gmail message is inbound.
    select 'reply', 'gmail-' || g.client_id, g.client_id, null,
           '/inbox/email/client-' || g.client_id, g.last_message_at, left(g.subject, 120),
           'client_email_unanswered',
           case when g.last_message_at is not null then
             jsonb_build_object('kind', 'gmail_reply', 'entity_id', g.client_id, 'observed_at', g.last_message_at)
           end
    from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id and g.direction = 'inbound'

    union all
    -- Email the CRM failed to send or a person drafted and nobody approved.
    select case when e.send_failed then 'email_send_failed' else 'email_draft_to_approve' end,
           'email-' || e.thread_key, e.client_id, left(e.to_email, 120),
           '/inbox/email/' || e.thread_key, e.last_activity_at, left(e.subject, 120),
           case when e.send_failed then 'email_not_delivered' else 'email_awaiting_approval' end, null
    from email_thread_state e
    where e.send_failed or e.awaiting_approval

    union all
    -- Contradictory authoritative facts (Phase 2 detectors).
    select 'conflict', 'conflict-' || at.client_id || '-' || code, at.client_id, null,
           '/clients/' || at.client_id, null, code, code, null
    from att at, jsonb_array_elements_text(at.a -> 'conflicts') code
    where code <> 'ai_brief_stale'

    union all
    -- Money that landed and only needs agreeing with.
    select 'payment_to_confirm', 'payment-' || r.id, pr.client_id, null, '/payments', r.occurred_at,
           r.amount::text || ' ' || r.currency, 'payment_received_unconfirmed', null
    from public.payment_reconciliation_candidates r
    join public.payment_requests pr
      on pr.id = coalesce(r.matched_payment_request_id, r.suggested_payment_request_id)
    where p_include_finance and r.artist_id = p_artist_id
      and r.provider = 'monzo_easy_bank_transfer'
      and r.status in ('matched', 'candidate')
      and not exists (select 1 from public.payment_transactions t
                      where t.provider = r.provider and t.provider_transaction_id = r.provider_transaction_id
                        and t.status = 'succeeded')

    union all
    -- A proposed appointment nobody confirmed.
    select 'unconfirmed_appointment', 'unconfirmed-' || s.id, s.client_id, null, '/appointments/' || s.id,
           s.start_at, null, 'appointment_not_confirmed', null
    from live_sessions s
    where s.status in ('draft', 'proposed') and s.start_at >= (select t from now_)

    union all
    -- A booked session whose deposit is outstanding. A merely requested
    -- deposit waits until the session is within the week ahead.
    select 'deposit_outstanding', 'deposit-' || p.id, p.client_id, null, '/projects/' || p.id, nxt.start_at,
           p.deposit_status::text, 'deposit_not_received_for_booking',
           jsonb_build_object('kind', 'deposit_outstanding', 'entity_id', p.id, 'observed_at', p.updated_at)
    from public.projects p
    join lateral (
      select min(s.start_at) as start_at from live_sessions s
      where s.project_id = p.id and s.start_at >= (select t from now_)
    ) nxt on nxt.start_at is not null
    where p.artist_id = p_artist_id
      and p.deposit_status not in ('paid', 'not_required')
      and (p.deposit_status <> 'requested' or nxt.start_at < (select t from now_) + interval '8 days')

    union all
    -- A new enquiry the artist has not answered yet. A person's unsent draft
    -- or a failed send for it is already its own item above.
    select 'new_enquiry', 'enquiry-' || e.id, e.client_id, null, '/enquiries/' || e.id, e.created_at,
           e.project_type, 'new_enquiry_untouched',
           jsonb_build_object('kind', 'new_enquiry', 'entity_id', e.id, 'observed_at', e.created_at)
    from public.enquiries e
    where e.artist_id = p_artist_id and e.archived_at is null and e.status = 'new'
      and e.intake_state = 'complete'
      and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
      and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
      and not crm_private.enquiry_has_artist_reply(e.id, (select t from now_))
      and not exists (select 1 from email_threads m
                      where m.thread_key in ('enquiry-' || e.id, 'client-' || e.client_id)
                        and m.created_at >= e.created_at
                        and ((m.status = 'draft' and m.created_by_kind = 'human') or m.status = 'failed'))

    union all
    -- Messages from somebody the CRM cannot name yet, as one row. Deciding
    -- who they are is Inbox work; Today only says how many wait. A
    -- personal (not_crm) conversation and one handled outside the CRM for
    -- its current actionable inbound do not count.
    select 'unmatched_inbound', 'unmatched-inbound', null, null, '/inbox?view=unmatched',
           max(c.awaiting_since), count(*)::text, 'unknown_sender_unanswered', null
    from conv c
    where c.client_id is null and c.enquiry_id is null
      and c.awaiting_since is not null
      and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id)
      and not exists (select 1 from acks k
                      where k.item_kind = 'conversation_reply' and k.entity_id = c.id
                        and k.observed_at >= c.awaiting_since)
    having count(*) > 0

    union all
    -- Operator follow-ups past due.
    select 'overdue_follow_up', 'follow-up-' || f.id, f.client_id, left(f.subject, 120),
           case when f.enquiry_id is not null then '/enquiries/' || f.enquiry_id
                when f.project_id is not null then '/projects/' || f.project_id
                when f.client_id is not null then '/clients/' || f.client_id end,
           f.due_at, null, 'follow_up_overdue', null
    from public.follow_ups f
    where f.artist_id = p_artist_id and f.status = 'open' and f.due_at < (select t from now_)

    union all
    -- The studio's last message is unanswered: one item per cycle. The 7-day
    -- and 21-day kinds share the acknowledgement keyed by the cycle, so a
    -- decision taken on day 7 still holds on day 21.
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason',
           jsonb_build_object('kind', 'client_silence', 'entity_id', at.client_id,
                              'observed_at', (at.a ->> 'last_outbound_at')::timestamptz)
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')
      and at.a ->> 'last_outbound_at' is not null
      -- A manual follow-up: open, or completed/cancelled during this cycle.
      and not exists (
        select 1 from client_follow_ups f
        where f.client_id = at.client_id
          and (f.status = 'open' or f.closed_at >= (at.a ->> 'last_outbound_at')::timestamptz))
      -- A proposed appointment already has its own row.
      and not exists (
        select 1 from live_sessions s
        where s.client_id = at.client_id and s.status in ('draft', 'proposed')
          and s.start_at >= (select t from now_))
      -- A paid deposit: the next step is the studio's.
      and not exists (
        select 1 from public.projects p
        where p.artist_id = p_artist_id and p.client_id = at.client_id and p.archived_at is null
          and p.status in ('draft', 'active', 'on_hold') and p.deposit_status = 'paid')

    union all
    -- Integration failures, grouped: the detail belongs on the integrations screen.
    select 'integration_failure', 'integration-failures', null, null, '/integrations', null,
           count(*)::text, 'integration_jobs_failed', null
    from public.integration_outbox o
    where p_include_integrations and o.artist_id = p_artist_id and o.status in ('failed', 'dead')
    having count(*) > 0
  ),
  visible as (
    select r.* from raw r
    where r.ack is null
       or not exists (select 1 from acks k
                      where k.item_kind = r.ack ->> 'kind'
                        and k.entity_id = (r.ack ->> 'entity_id')::uuid
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz
                        -- "Not now" covers the cycle until its time comes.
                        and (k.resurface_at is null or k.resurface_at > (select t from now_)))
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state,
      case when r.kind in ('client_follow_up_due', 'client_cold')
        then crm_private.client_silence_context(p_artist_id, r.client_id, r.at) end as context
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', case
      when r.context ->> 'conversation_id' is not null then '/inbox/' || (r.context ->> 'conversation_id')
      when r.context ->> 'channel' = 'email' then '/inbox/email/client-' || r.client_id
      else r.href end,
    'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'context', r.context,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$function$;

revoke all on function crm_private.pulse_items(uuid, boolean, boolean, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The Statistics counter: the Today block's number
-- ---------------------------------------------------------------------------

create function public.get_waiting_on_clients_count(p_artist_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_total integer := 0;
  v_count integer;
  v_artists jsonb := '[]'::jsonb;
  v_artist record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  end if;

  -- Today renders the server pulse only while it is enabled. Without it the
  -- browser fallback has no silence rows, so there is no number to give.
  if not coalesce((select c.today_pulse from crm_private.crm_agent_config c where c.singleton), false) then
    return jsonb_build_object('status', 'unavailable', 'reason', 'pulse_disabled');
  end if;

  for v_artist in
    select a.id from public.artists a
    where a.is_active and (p_artist_id is null or a.id = p_artist_id)
      and crm_private.has_artist_capability(a.id, 'view_clients')
    order by a.display_name, a.id
  loop
    select count(*) into v_count
    from jsonb_array_elements(crm_private.pulse_items(v_artist.id, false, false)) i
    where i ->> 'section' = 'waiting_on_clients';
    v_total := v_total + v_count;
    v_artists := v_artists || jsonb_build_array(jsonb_build_object('artist_id', v_artist.id, 'count', v_count));
  end loop;

  return jsonb_build_object(
    'status', 'ok',
    'generated_at', clock_timestamp(),
    'count', v_total,
    'artists', v_artists
  );
end;
$$;

revoke all on function public.get_waiting_on_clients_count(uuid) from public, anon, service_role;
grant execute on function public.get_waiting_on_clients_count(uuid) to authenticated;

comment on function public.get_waiting_on_clients_count(uuid) is
  'How many clients the Today block "waiting on the client" shows to the signed-in operator, from the same pulse_items rules. status unavailable when the server pulse is off.';
