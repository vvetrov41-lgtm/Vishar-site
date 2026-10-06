-- A confirmed booking outweighs the classifier's reading of a message.
--
-- Production readback after rc1028: Mark Abramov left Today, but his client
-- attention still said studio_reply_owed. The bounded reply classifier had
-- marked his 2026-09-14 "I'll write if anything" reply_required on
-- 2026-10-04, and in crm_private.attention_comm_facts any reply mark took
-- precedence over everything else, including the booking evidence of
-- 20261006120000 and over the operator's own Today acknowledgement. The
-- classifier reads only the text; an acknowledgement is the operator's
-- statement and a confirmed consultation for the same enquiry is a business
-- fact. Precedence is now:
-- operator mark > Today acknowledgement > booking evidence > classifier
-- reply_required. A classifier no_reply_needed already agrees and stands.

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
      -- An operator's mark always stands. A classifier's reply_required,
      -- read from the text alone, does not outweigh the operator clearing the
      -- Today item for that message, nor a confirmed booking of the same
      -- client and enquiry (20261006130000).
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
