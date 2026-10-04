-- 20261004120000_reply_semantics_followup.sql
--
-- Follow-up to 20261004090000_canonical_enquiry_reply_evidence. Four places
-- still disagreed with the canonical "the artist answered" semantics:
--
-- 1. A manual enquiry whose conversation happened where the CRM cannot see
--    it (Kara Dimma, ENQ-2026-0061: created in the CRM with preferred contact
--    Instagram on 2026-09-29, before Instagram ingestion started on
--    2026-09-30) had no way to be recorded as answered. The operator can now
--    say so explicitly (set_enquiry_reply_outside_crm). It is an attestation:
--    the enquiry is answered, no reply time is claimed, and it never leaves
--    analytics.
-- 2. The Gmail first-reply lookup read one page. A reply time from Gmail is
--    now only used once a complete lookup of the enquiry window has run:
--    before that, or when the window held more mail than one bounded run can
--    page through, the enquiry is answered but its first reply time is
--    unknown. Every recent enquiry with an address gets one lookup, so a
--    later SENT mail recorded from the newest-mail page can no longer stand
--    in for an earlier one.
-- 3. crm_private.outbound_message_marks_enquiry_reviewing moved an enquiry to
--    reviewing on any non-automated outbound row, queued and failed
--    included, and the Gmail variant fired on the newest-message record (a
--    scheduled message included). Both now wait for a message the provider
--    accepted.
-- 4. crm_private.attention_comm_facts counted queued and failed studio
--    messages as the studio's turn (SLA, follow-up, waiting-on). Only
--    provider-accepted messages count now.

-- ---------------------------------------------------------------------------
-- 1. Operator attestation of a reply sent outside the CRM's sight
-- ---------------------------------------------------------------------------

create table crm_private.enquiry_reply_attestations (
  enquiry_id uuid primary key references public.enquiries(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'instagram', 'email', 'phone', 'in_person', 'other')),
  attested_by uuid references public.profiles(id) on delete set null,
  attested_at timestamptz not null default clock_timestamp()
);

alter table crm_private.enquiry_reply_attestations enable row level security;
revoke all on crm_private.enquiry_reply_attestations
  from public, anon, authenticated, service_role;

comment on table crm_private.enquiry_reply_attestations is
  'An operator stated the client was already answered on a channel the CRM could not see. Answered, without a reply time.';

create function public.set_enquiry_reply_outside_crm(
  p_enquiry_id uuid,
  p_channel text,
  p_answered boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry record;
  v_actor text := case when public.is_owner() then 'owner' else 'staff' end;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select e.id, e.artist_id, e.client_id into v_enquiry
  from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage_enquiries');

  if coalesce(p_answered, true) then
    if p_channel is null or p_channel not in ('whatsapp', 'instagram', 'email', 'phone', 'in_person', 'other') then
      raise exception 'invalid reply channel' using errcode = '22023';
    end if;
    insert into crm_private.enquiry_reply_attestations (enquiry_id, artist_id, channel, attested_by)
    values (v_enquiry.id, v_enquiry.artist_id, p_channel, auth.uid())
    on conflict (enquiry_id) do update
    set channel = excluded.channel, attested_by = excluded.attested_by,
        attested_at = crm_private.enquiry_reply_attestations.attested_at;
    perform crm_private.log_activity(
      'enquiry.reply_attested', v_actor, auth.uid(), v_enquiry.client_id, v_enquiry.id,
      null, null, null, null, null, null, jsonb_build_object('channel', p_channel));
  else
    delete from crm_private.enquiry_reply_attestations where enquiry_id = v_enquiry.id;
    if found then
      perform crm_private.log_activity(
        'enquiry.reply_attestation_removed', v_actor, auth.uid(), v_enquiry.client_id, v_enquiry.id,
        null, null, null, null, null, null, '{}'::jsonb);
    end if;
  end if;

  return jsonb_build_object(
    'enquiry_id', v_enquiry.id,
    'answered_outside_crm', coalesce(p_answered, true),
    'channel', case when coalesce(p_answered, true) then p_channel end);
end;
$$;

revoke all on function public.set_enquiry_reply_outside_crm(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_enquiry_reply_outside_crm(uuid, text, boolean) to authenticated;

comment on function public.set_enquiry_reply_outside_crm(uuid, text, boolean) is
  'Operator (manage_enquiries): the client of this enquiry was already answered on a channel the CRM could not see, or undo that statement. Never changes communication history or analytics inclusion.';


-- ---------------------------------------------------------------------------
-- 2. Gmail: a reply time only from a complete lookup of the enquiry window
-- ---------------------------------------------------------------------------

alter table crm_private.gmail_enquiry_reply_checks
  add column complete boolean not null default true;

comment on column crm_private.gmail_enquiry_reply_checks.complete is
  'True when the lookup read every SENT message of the enquiry window up to checked_at, so the oldest it found is the first Gmail reply. False when the window held more mail than one bounded run could page through: answered, time unknown.';

create function public.service_record_gmail_enquiry_reply_check(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_first_sent_at timestamptz,
  p_complete boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry record;
  v_complete boolean := coalesce(p_complete, false);
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply recording is backend-only' using errcode = '42501';
  end if;
  select e.id, e.client_id, e.created_at into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id and e.artist_id = p_artist_id;
  if not found then
    raise exception 'Gmail reply target is unavailable' using errcode = '22023';
  end if;
  if p_first_sent_at is not null and p_first_sent_at > now() + interval '5 minutes' then
    raise exception 'invalid Gmail reply time' using errcode = '22023';
  end if;

  -- Only the oldest message of a complete lookup is a first-reply time.
  if p_first_sent_at is not null and v_complete then
    perform crm_private.note_gmail_client_outbound(p_artist_id, v_enquiry.client_id, p_first_sent_at);
  end if;
  insert into crm_private.gmail_enquiry_reply_checks (enquiry_id, artist_id, checked_at, found, complete)
  values (p_enquiry_id, p_artist_id, now(), p_first_sent_at is not null, v_complete)
  on conflict (enquiry_id) do update
  set checked_at = excluded.checked_at,
      found = crm_private.gmail_enquiry_reply_checks.found or excluded.found,
      -- A complete lookup that found the first reply stays the answer.
      complete = excluded.complete
        or (crm_private.gmail_enquiry_reply_checks.complete and crm_private.gmail_enquiry_reply_checks.found);
end;
$$;

revoke all on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz, boolean) to service_role;

comment on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz, boolean) is
  'Backend-only: the oldest SENT Gmail message to the client in the enquiry window (or none), and whether the lookup read the whole window.';

-- The earlier Worker build sends three arguments and always read one page,
-- so its answer is never treated as complete.
create or replace function public.service_record_gmail_enquiry_reply_check(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_first_sent_at timestamptz
)
returns void
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.service_record_gmail_enquiry_reply_check(p_artist_id, p_enquiry_id, p_first_sent_at, false);
$$;

revoke all on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz) to service_role;

-- Lookups made by the one-page build are not proof of the earliest reply.
-- Derived state only: they are looked up again.
delete from crm_private.gmail_enquiry_reply_checks;

-- Every recent enquiry with an address is looked up once; a lookup that
-- found nothing is repeated while the window is open.
create or replace function public.service_list_gmail_reply_candidates(
  p_artist_id uuid,
  p_limit integer default 3
)
returns table (
  enquiry_id uuid,
  client_email text,
  created_at timestamptz,
  closed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply candidates are backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or coalesce(p_limit, 0) < 1 or p_limit > 10 then
    raise exception 'invalid Gmail reply candidate request' using errcode = '22023';
  end if;

  return query
  select e.id, lower(btrim(c.email)), e.created_at, w.closed_at
  from public.enquiries e
  join public.clients c on c.id = e.client_id and c.archived_at is null
  cross join lateral crm_private.enquiry_reply_window(e.id) w
  left join crm_private.gmail_enquiry_reply_checks k on k.enquiry_id = e.id
  where e.artist_id = p_artist_id
    and e.archived_at is null and e.intake_state = 'complete'
    and e.created_at >= now() - interval '30 days'
    and nullif(btrim(coalesce(c.email, '')), '') is not null
    and (k.enquiry_id is null or (not k.found and k.checked_at < now() - interval '6 hours'))
  order by k.checked_at nulls first, e.created_at desc, e.id
  limit p_limit;
end;
$$;

revoke all on function public.service_list_gmail_reply_candidates(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_gmail_reply_candidates(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The predicate: new attestations, and Gmail completeness for the time
-- ---------------------------------------------------------------------------

create or replace function crm_private.enquiry_reply_attestation(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns table (
  attested_at timestamptz,
  attestation_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with w as (select * from crm_private.enquiry_reply_window(p_enquiry_id)),
  facts as (
    -- The operator cleared this client's reply item or this enquiry's item.
    select a.acknowledged_at as at, 'today_item_handled'::text as source, false as enquiry_scoped
    from w
    join public.attention_acknowledgements a on a.artist_id = w.artist_id
    where (a.item_kind = 'new_enquiry' and a.entity_id = w.enquiry_id)
       or (a.item_kind = 'gmail_reply' and a.entity_id = w.client_id)
       or (a.item_kind = 'conversation_reply' and exists (
             select 1 from public.communication_conversations c
             where c.id = a.entity_id and c.artist_id = w.artist_id
               and (c.client_id = w.client_id or c.enquiry_id = w.enquiry_id)))

    union all
    -- The operator said the studio is now waiting for the client.
    select l.occurred_at, 'operator_waiting_for_client', true
    from w
    join public.activity_log l on l.enquiry_id = w.enquiry_id
    where l.event_type = 'enquiry.status_changed'
      and l.metadata ->> 'to_status' = 'waiting_for_client'
      and l.actor_kind in ('owner', 'staff')

    union all
    -- The operator booked an appointment for this enquiry or this client.
    select l.occurred_at, 'operator_booked_appointment', l.enquiry_id is not distinct from w.enquiry_id
    from w
    join public.activity_log l
      on l.enquiry_id = w.enquiry_id
      or (l.client_id = w.client_id and l.artist_id = w.artist_id)
    where l.event_type = 'appointment.scheduled'
      and l.actor_kind in ('owner', 'staff')

    union all
    -- The operator recorded a reply the CRM could not see.
    select r.attested_at, 'operator_recorded_reply', true
    from w
    join crm_private.enquiry_reply_attestations r
      on r.enquiry_id = w.enquiry_id and r.artist_id = w.artist_id

    union all
    -- Gmail holds SENT mail in the window, more than one run could page.
    select k.checked_at, 'gmail_sent_time_unknown', true
    from w
    join crm_private.gmail_enquiry_reply_checks k
      on k.enquiry_id = w.enquiry_id and k.artist_id = w.artist_id
    where k.found and not k.complete
  )
  select f.at, f.source
  from facts f, w
  where (f.at >= w.opened_at or f.source = 'operator_recorded_reply')
    and (f.enquiry_scoped or w.closed_at is null or f.at < w.closed_at)
    and (p_as_of is null or f.at <= p_as_of)
  order by f.at, f.source
  limit 1;
$$;

revoke all on function crm_private.enquiry_reply_attestation(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function crm_private.enquiry_reply_state(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns table (
  answered boolean,
  first_reply_at timestamptz,
  first_reply_source text,
  attested_at timestamptz,
  attestation_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with gmail as (
    -- Gmail could hold an earlier reply until a complete lookup of this
    -- enquiry's window has run, when the artist has a mailbox and the client
    -- an address.
    select exists (
      select 1
      from public.enquiries e
      join public.clients c on c.id = e.client_id
      where e.id = p_enquiry_id
        and nullif(btrim(coalesce(c.email, '')), '') is not null
        and exists (
          select 1 from public.artist_integrations i
          where i.artist_id = e.artist_id
            and i.integration_type = 'email'::public.artist_integration_type
            and i.provider = 'google' and i.is_enabled)
        and not exists (
          select 1 from crm_private.gmail_enquiry_reply_checks k
          where k.enquiry_id = e.id and k.complete
            and (p_as_of is null or k.checked_at <= p_as_of))
    ) as pending
  )
  select fr.replied_at is not null or att.attested_at is not null,
         case
           -- An operator already attested an earlier, unseen reply.
           when att.attested_at is not null and att.attested_at < fr.replied_at then null
           -- Gmail may still hold an earlier one.
           when (select pending from gmail) then null
           else fr.replied_at
         end,
         fr.evidence_source,
         att.attested_at,
         att.attestation_source
  from (select 1) one
  left join lateral crm_private.enquiry_first_artist_reply(p_enquiry_id, p_as_of) fr on true
  left join lateral crm_private.enquiry_reply_attestation(p_enquiry_id, p_as_of) att on true;
$$;

revoke all on function crm_private.enquiry_reply_state(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- The Today item and the reminder use enquiry_has_artist_reply, which reads
-- the attestation function above, so they follow automatically.

-- ---------------------------------------------------------------------------
-- 4. Moving a new enquiry to reviewing waits for a sent message
-- ---------------------------------------------------------------------------

create or replace function crm_private.outbound_message_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conv record;
begin
  -- The artist writing, from the CRM or from the phone app, once the
  -- provider accepted the message. Queued and failed sends never reached the
  -- client; automated reminders are not the artist replying.
  if new.direction <> 'outbound' or new.origin = 'automation'
     or new.status not in ('sent', 'delivered', 'read') then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status in ('sent', 'delivered', 'read') then
    return null;
  end if;
  select c.artist_id, c.client_id into v_conv
  from public.communication_conversations c where c.id = new.conversation_id;
  if found and v_conv.client_id is not null then
    perform crm_private.mark_enquiries_reviewing(
      v_conv.artist_id, v_conv.client_id, 'client_contacted',
      coalesce(new.provider_timestamp, new.sent_at, new.created_at));
  end if;
  return null;
end;
$$;

revoke all on function crm_private.outbound_message_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_mark_enquiry_reviewing on public.communication_messages;
create trigger communication_messages_mark_enquiry_reviewing
  after insert or update of status on public.communication_messages
  for each row execute function crm_private.outbound_message_marks_enquiry_reviewing();

create or replace function crm_private.linked_conversation_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_last_out timestamptz;
begin
  if new.client_id is null or new.client_id is not distinct from old.client_id then
    return null;
  end if;
  select max(coalesce(m.provider_timestamp, m.sent_at, m.created_at)) into v_last_out
  from public.communication_messages m
  where m.conversation_id = new.id and m.direction = 'outbound' and m.origin <> 'automation'
    and m.status in ('sent', 'delivered', 'read');
  if v_last_out is not null then
    perform crm_private.mark_enquiries_reviewing(
      new.artist_id, new.client_id, 'client_contacted', v_last_out);
  end if;
  return null;
end;
$$;

revoke all on function crm_private.linked_conversation_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

-- Gmail: the SENT evidence, not the newest-message record.
drop trigger if exists gmail_client_email_activity_mark_enquiry_reviewing
  on crm_private.gmail_client_email_activity;

create function crm_private.gmail_sent_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.mark_enquiries_reviewing(
    new.artist_id, new.client_id, 'client_contacted', new.sent_at);
  return null;
end;
$$;

revoke all on function crm_private.gmail_sent_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

create trigger gmail_client_outbound_messages_mark_enquiry_reviewing
  after insert on crm_private.gmail_client_outbound_messages
  for each row execute function crm_private.gmail_sent_marks_enquiry_reviewing();

-- ---------------------------------------------------------------------------
-- 5. Attention facts (SLA, follow-up, waiting-on): sent studio messages only
-- ---------------------------------------------------------------------------
-- Unchanged from 20260924035000 except the status filter.

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
    select t.source, t.direction, t.occurred_at
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

revoke all on function crm_private.attention_comm_facts(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The operator can see why an enquiry counts as answered
-- ---------------------------------------------------------------------------

create function public.get_enquiry_reply_state(p_enquiry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_state record;
  v_outside record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select e.artist_id into v_artist_id from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_artist_id, 'view_enquiries');

  select * into v_state from crm_private.enquiry_reply_state(p_enquiry_id);
  select r.channel, r.attested_at into v_outside
  from crm_private.enquiry_reply_attestations r where r.enquiry_id = p_enquiry_id;

  return jsonb_build_object(
    'enquiry_id', p_enquiry_id,
    'answered', coalesce(v_state.answered, false),
    'first_reply_at', v_state.first_reply_at,
    'first_reply_source', v_state.first_reply_source,
    'attestation_source', v_state.attestation_source,
    'outside_crm_channel', v_outside.channel,
    'outside_crm_recorded_at', v_outside.attested_at
  );
end;
$$;

revoke all on function public.get_enquiry_reply_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_enquiry_reply_state(uuid) to authenticated;

comment on function public.get_enquiry_reply_state(uuid) is
  'Operator (view_enquiries): whether this enquiry counts as answered, the first reply time when known, and which evidence decided it. No message content.';
