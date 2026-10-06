-- A confirmed booking is evidence the studio dealt with the client.
--
-- Production after rc1025: Mark Abramov and Bradley Vines showed in Today as
-- "client_message_unanswered", each for a WhatsApp message from September.
-- Both already had a confirmed consultation for the same enquiry, and both
-- messages predate 2026-09-28 19:09, when the CRM began capturing replies the
-- artist sends from the phone (provider_app echoes). Before that moment the
-- CRM cannot see a phone reply at all, so "no reply visible" is not evidence
-- that nothing was answered. (Mark's "I'll write if anything" came 19 s after
-- his consultation was confirmed; Bradley's message 10 days after his.)
--
-- Canonical rule, crm_private.inbound_message_handled_by_booking(message):
-- the client's actionable inbound is handled when the same client has a
-- confirmed, not cancelled appointment for the same enquiry (directly or
-- through that enquiry's project; any of the client's appointments with this
-- artist when the conversation names no enquiry), and either
--   (a) the appointment was confirmed at or after the message, or
--   (b) the message predates the studio's outbound capture on that artist's
--       channel (no phone reply could have been seen), whenever the
--       appointment was confirmed.
-- A newer message on a captured channel after the confirmation still waits
-- (neither (a) nor (b)). A cancelled appointment, another client's, or one
-- for another enquiry proves nothing. A channel that never captured studio
-- replies gets no (b): absence of capture is not evidence.
--
-- crm_private.conversation_awaiting_reply_since applies the rule, so Today,
-- the unknown-sender count, Telegram reminders and the Inbox projection agree;
-- crm_private.attention_comm_facts applies the same rule to the client facts.

create index if not exists communication_messages_provider_app_capture_idx
  on public.communication_messages (artist_id, channel, created_at)
  where origin = 'provider_app';

-- When the CRM began seeing the replies this artist sends from the provider
-- app on this channel. Null when it never has.
create function crm_private.studio_outbound_capture_started_at(
  p_artist_id uuid,
  p_channel public.communication_channel
)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select min(m.created_at)
  from public.communication_messages m
  where m.artist_id = p_artist_id and m.channel = p_channel and m.origin = 'provider_app';
$$;

-- When an appointment became confirmed: the audit trail, or its creation
-- when the trail is silent (never later than the real confirmation).
create function crm_private.appointment_confirmed_at(p_session_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(
    (select min(l.occurred_at) from public.activity_log l
     where l.session_id = p_session_id
       and ((l.event_type = 'appointment.status_changed' and l.metadata ->> 'to_status' = 'confirmed')
            or (l.event_type = 'appointment.scheduled' and l.metadata ->> 'status' = 'confirmed'))),
    (select s.created_at from public.sessions s where s.id = p_session_id));
$$;

-- The canonical booking evidence for one inbound message: the time the
-- studio is shown to have dealt with it, or null.
create function crm_private.inbound_message_handled_by_booking(p_message_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with msg as (
    select m.id, c.artist_id, c.client_id, c.enquiry_id, c.channel,
           coalesce(m.provider_timestamp, m.created_at) as at
    from public.communication_messages m
    join public.communication_conversations c on c.id = m.conversation_id
    where m.id = p_message_id and m.direction = 'inbound' and c.client_id is not null
  ), evidence as (
    select crm_private.appointment_confirmed_at(s.id) as confirmed_at, msg.at,
           crm_private.studio_outbound_capture_started_at(msg.artist_id, msg.channel) as capture_at
    from msg
    join public.sessions s
      on s.artist_id = msg.artist_id and s.client_id = msg.client_id
    where s.status = 'confirmed' and s.cancelled_at is null
      and (msg.enquiry_id is null
           or s.enquiry_id = msg.enquiry_id
           or exists (select 1 from public.projects p where p.id = s.project_id and p.enquiry_id = msg.enquiry_id))
  )
  select min(case
    when e.confirmed_at >= e.at then e.confirmed_at
    when e.capture_at is not null and e.at < e.capture_at then greatest(e.confirmed_at, e.at)
  end)
  from evidence e;
$$;

revoke all on function crm_private.studio_outbound_capture_started_at(uuid, public.communication_channel)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.appointment_confirmed_at(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.inbound_message_handled_by_booking(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.inbound_message_handled_by_booking(uuid) is
  'When a confirmed, live appointment of the same client and enquiry shows the studio dealt with this inbound message: confirmed at or after it, or the message predates the studio''s outbound capture on that channel. Null otherwise.';

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
  'The newest actionable inbound time while it is newer than the studio''s newest provider-accepted turn and no confirmed booking shows it was dealt with; null when nothing waits on the studio.';

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
      -- A studio message counts as the studio's turn only once the provider
      -- accepted it: queued and failed sends never reached the client.
      and (t.source <> 'communication' or t.direction <> 'outbound' or exists (
        select 1 from public.communication_messages m
        where m.id = t.source_id
          and m.status in ('sent'::public.communication_status,
                           'delivered'::public.communication_status,
                           'read'::public.communication_status)))
      -- A reaction, edit, revoke or unsupported event asks nothing of the
      -- studio (crm_private.communication_event_is_actionable).
      and (t.source <> 'communication' or t.direction <> 'inbound' or exists (
        select 1 from public.communication_messages m
        where m.id = t.source_id
          and crm_private.communication_event_is_actionable(m.message_type)))
      -- Submitting an enquiry asks for a response only while it is still
      -- new. Any operator workflow move on it (reviewing, converted, ...)
      -- has answered that submission, as the existing actionability rule
      -- already assumes.
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
  -- A confirmed booking of the same client and enquiry that shows the studio
  -- dealt with the latest message (crm_private.inbound_message_handled_by_booking).
  booked as (
    select crm_private.inbound_message_handled_by_booking(inbound.source_id) as at
    from inbound where inbound.source = 'communication'
  ),
  facts as (
    select
      (select at from booked) as booked_at,
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
      when f.booked_at is not null then 'handled'
      else 'unknown'
    end,
    case
      when f.mark_state is not null then f.mark_source
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at >= f.last_inbound_at
        then 'operator_ack'
      when f.booked_at is not null then 'booking_evidence'
      else null
    end,
    f.last_inbound_at is not null
      and (f.last_outbound_at is null or f.last_inbound_at > f.last_outbound_at),
    case
      when f.mark_state is null and f.ack_at is not null and f.last_inbound_at is not null
           and f.ack_at >= f.last_inbound_at
        then greatest(f.ack_clicked_at, f.last_inbound_at)
      when f.mark_state is null and f.booked_at is not null then f.booked_at
    end
  from facts f;
$$;

revoke all on function crm_private.attention_comm_facts(uuid, uuid)
  from public, anon, authenticated, service_role;
