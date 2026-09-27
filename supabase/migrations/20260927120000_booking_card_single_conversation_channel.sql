-- Booking cards go to exactly one channel: the one the client actually talks
-- to the studio in.
--
-- Before: one canonical card fanned out to Email and WhatsApp whenever both
-- channels were enabled and the client had both contact details.
-- After:  canonical card -> resolve the conversation channel -> at most one
-- delivery. Contact details alone never select a channel.
--
-- Channel evidence is real CRM conversation history for this client with this
-- artist, newest first ("latest conversation channel wins"):
--   WhatsApp/Instagram  linked conversation messages that are inbound, or
--                        outbound by a person (CRM or provider app).
--                        Automated messages (booking cards, reminders) never
--                        count, so a card cannot select its own channel.
--   Email               a CRM email to the client that was actually sent by a
--                        person or the assistant (not system mail such as
--                        deposit requests), a recorded Gmail message excerpt,
--                        a Gmail metadata snapshot, or a Gmail thread with the
--                        client first observed by the CRM.
-- The client's form answer "preferred contact" is a stated preference, not a
-- conversation, and is deliberately not evidence.
--
-- No evidence -> no delivery ("no conversation channel yet"). Latest evidence
-- on a channel cards cannot use (Instagram) -> no delivery, no fallback. The
-- decision is recorded per card revision without any message content.
--
-- Also fixes the Gmail transport for booking card email: the outbox target
-- resolver only knew enquiry mail and deposit mail, so a card email (which
-- may have no enquiry) failed every attempt with gmail_rpc_failed.

-- ---------------------------------------------------------------------------
-- 1. Channel decision audit, one row per card revision
-- ---------------------------------------------------------------------------

create table crm_private.booking_card_channel_decisions (
  booking_card_id uuid primary key
    references crm_private.booking_cards(id) on delete restrict,
  channel text
    check (channel is null or channel in ('email', 'whatsapp', 'instagram')),
  outcome text not null
    check (outcome in (
      'selected',
      'no_conversation_channel',
      'conversation_channel_unsupported',
      'conversation_channel_disabled',
      'conversation_channel_unreachable',
      'delivery_unavailable'
    )),
  evidence_source text
    check (evidence_source is null or evidence_source in (
      'whatsapp_message',
      'instagram_message',
      'email_sent',
      'gmail_message',
      'gmail_thread',
      'gmail_metadata'
    )),
  -- communication_conversations.id for WhatsApp/Instagram, the Gmail thread
  -- context for Gmail threads. Identifiers only, never message content.
  evidence_conversation_id uuid,
  -- communication_messages.id, email_messages.id or the Gmail excerpt id.
  evidence_message_id uuid,
  evidence_at timestamptz,
  decided_at timestamptz not null default now(),
  constraint booking_card_channel_decision_shape check (
    (outcome = 'no_conversation_channel'
      and channel is null and evidence_source is null and evidence_at is null)
    or (outcome <> 'no_conversation_channel'
      and channel is not null and evidence_source is not null and evidence_at is not null)
  ),
  constraint booking_card_channel_decision_supported check (
    outcome not in ('selected', 'delivery_unavailable') or channel in ('email', 'whatsapp')
  )
);

alter table crm_private.booking_card_channel_decisions enable row level security;
revoke all on crm_private.booking_card_channel_decisions
  from public, anon, authenticated, service_role;

comment on table crm_private.booking_card_channel_decisions is
  'Which single channel a booking card revision uses and why: the newest real conversation evidence (source, conversation/message ids, timestamp). Holds no message content.';

create index if not exists booking_cards_client_current_idx
  on crm_private.booking_cards (client_id, artist_id)
  where superseded_at is null;

-- ---------------------------------------------------------------------------
-- 2. Newest conversation evidence for a client with an artist
-- ---------------------------------------------------------------------------

create or replace function crm_private.booking_card_conversation_evidence(
  p_client_id uuid,
  p_artist_id uuid
)
returns table (
  channel text,
  evidence_source text,
  evidence_conversation_id uuid,
  evidence_message_id uuid,
  evidence_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select ev.channel, ev.evidence_source, ev.evidence_conversation_id,
         ev.evidence_message_id, ev.evidence_at
  from (
    select c.channel::text as channel,
           c.channel::text || '_message' as evidence_source,
           c.id as evidence_conversation_id,
           m.id as evidence_message_id,
           coalesce(m.provider_timestamp, m.sent_at, m.created_at) as evidence_at
    from public.communication_messages m
    join public.communication_conversations c on c.id = m.conversation_id
    where c.client_id = p_client_id
      and c.artist_id = p_artist_id
      and c.link_state = 'linked'::public.communication_link_state
      and m.channel = c.channel
      and (
        m.direction = 'inbound'::public.communication_direction
        or (
          m.direction = 'outbound'::public.communication_direction
          and m.origin in (
            'crm'::public.communication_origin,
            'provider_app'::public.communication_origin
          )
          and m.status <> 'failed'::public.communication_status
        )
      )

    union all

    select 'email', 'email_sent', e.gmail_thread_context_id, e.id, e.sent_at
    from public.email_messages e
    where e.client_id = p_client_id
      and e.artist_id = p_artist_id
      and e.status = 'sent'::public.email_message_status
      and e.booking_card_id is null
      and coalesce(e.created_by_kind, '') <> 'system'

    union all

    select 'email', 'gmail_message', null::uuid, x.id, x.occurred_at
    from crm_private.gmail_client_ai_excerpts x
    where x.client_id = p_client_id
      and x.artist_id = p_artist_id

    union all

    -- A thread's updated_at moves whenever the CRM re-reads it, so the first
    -- observation is the only timestamp that is not inflated by reading.
    select 'email', 'gmail_thread', g.id, null::uuid, g.created_at
    from crm_private.gmail_thread_contexts g
    where g.client_id = p_client_id
      and g.artist_id = p_artist_id

    union all

    select 'email', 'gmail_metadata', null::uuid, null::uuid, s.last_message_at
    from public.gmail_client_metadata_snapshots s
    where s.client_id = p_client_id
      and s.artist_id = p_artist_id
  ) ev
  where ev.evidence_at is not null
  order by ev.evidence_at desc,
           ev.evidence_source,
           ev.evidence_message_id nulls last,
           ev.evidence_conversation_id nulls last
  limit 1;
$$;

revoke all on function crm_private.booking_card_conversation_evidence(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Channel resolution: evidence -> one channel or an explicit block reason
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_booking_card_channel(
  p_client_id uuid,
  p_artist_id uuid
)
returns table (
  channel text,
  outcome text,
  evidence_source text,
  evidence_conversation_id uuid,
  evidence_message_id uuid,
  evidence_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_evidence record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client public.clients%rowtype;
  v_conversation public.communication_conversations%rowtype;
  v_phone text;
begin
  select * into v_evidence
  from crm_private.booking_card_conversation_evidence(p_client_id, p_artist_id);

  if not found then
    return query select null::text, 'no_conversation_channel'::text,
      null::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  channel := v_evidence.channel;
  evidence_source := v_evidence.evidence_source;
  evidence_conversation_id := v_evidence.evidence_conversation_id;
  evidence_message_id := v_evidence.evidence_message_id;
  evidence_at := v_evidence.evidence_at;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = p_artist_id;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
    and c.archived_at is null;

  if v_evidence.channel = 'whatsapp' then
    if not coalesce(v_settings.whatsapp_enabled, false) then
      outcome := 'conversation_channel_disabled';
    else
      select c.* into v_conversation
      from public.communication_conversations c
      where c.id = v_evidence.evidence_conversation_id;

      v_phone := crm_private.normalize_whatsapp_phone(v_client.phone);

      -- The card must reach the same WhatsApp contact the conversation is
      -- with, never another number that merely sits on the client record.
      if v_client.id is null
         or v_phone is null
         or v_phone !~ '^\+[0-9]{6,20}$'
         or v_conversation.id is null
         or v_conversation.state <> 'open'::public.communication_conversation_state
         or v_conversation.external_contact_id is distinct from substring(v_phone from 2)
         or crm_private.client_send_block_reason(
           p_client_id,
           'whatsapp'::public.message_template_channel,
           'service'::public.message_classification
         ) is not null then
        outcome := 'conversation_channel_unreachable';
      else
        outcome := 'selected';
      end if;
    end if;
  elsif v_evidence.channel = 'email' then
    if not coalesce(v_settings.email_enabled, false) then
      outcome := 'conversation_channel_disabled';
    elsif v_client.id is null
       or nullif(lower(btrim(coalesce(v_client.email, ''))), '') is null
       or crm_private.client_send_block_reason(
         p_client_id,
         'email'::public.message_template_channel,
         'service'::public.message_classification
       ) is not null then
      outcome := 'conversation_channel_unreachable';
    else
      outcome := 'selected';
    end if;
  else
    -- Instagram (or any future channel without a booking card transport).
    outcome := 'conversation_channel_unsupported';
  end if;

  return next;
end;
$$;

revoke all on function crm_private.resolve_booking_card_channel(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. A card never gets a delivery in a second channel
-- ---------------------------------------------------------------------------

create or replace function crm_private.guard_booking_card_single_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = new.booking_card_id
      and d.channel <> new.channel
  ) then
    raise exception 'booking card already has a delivery in another channel'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from crm_private.booking_card_channel_decisions x
    where x.booking_card_id = new.booking_card_id
      and (x.outcome <> 'selected' or x.channel is distinct from new.channel::text)
  ) then
    raise exception 'booking card delivery does not match its channel decision'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_booking_card_single_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_card_deliveries_single_channel
  on crm_private.booking_card_deliveries;
create trigger booking_card_deliveries_single_channel
before insert on crm_private.booking_card_deliveries
for each row execute function crm_private.guard_booking_card_single_delivery();

comment on table crm_private.booking_card_deliveries is
  'Delivery state of a booking card in its one resolved conversation channel. Cards created before 2026-09-27 may carry an Email and a WhatsApp row.';

-- ---------------------------------------------------------------------------
-- 5. Dispatch: resolve, record, queue exactly one channel
-- ---------------------------------------------------------------------------

create or replace function crm_private.dispatch_booking_card_once(p_booking_card_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_choice record;
  v_confirm_token text;
  v_reschedule_token text;
  v_message_id uuid;
  v_error_constraint text;
  v_error_table text;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null
  for update;

  if not found then
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id;

  if not found
     or (not v_settings.email_enabled and not v_settings.whatsapp_enabled)
     or (
       v_settings.appointment_start_from is not null
       and v_card.start_at < v_settings.appointment_start_from
     ) then
    return;
  end if;

  -- The channel of a card is fixed by its first delivery. Retries and later
  -- conversations never add a sibling channel.
  if exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = v_card.id
  ) then
    return;
  end if;

  select * into v_choice
  from crm_private.resolve_booking_card_channel(v_card.client_id, v_card.artist_id);

  insert into crm_private.booking_card_channel_decisions (
    booking_card_id,
    channel,
    outcome,
    evidence_source,
    evidence_conversation_id,
    evidence_message_id,
    evidence_at,
    decided_at
  ) values (
    v_card.id,
    v_choice.channel,
    v_choice.outcome,
    v_choice.evidence_source,
    v_choice.evidence_conversation_id,
    v_choice.evidence_message_id,
    v_choice.evidence_at,
    now()
  )
  on conflict (booking_card_id) do update
  set channel = excluded.channel,
      outcome = excluded.outcome,
      evidence_source = excluded.evidence_source,
      evidence_conversation_id = excluded.evidence_conversation_id,
      evidence_message_id = excluded.evidence_message_id,
      evidence_at = excluded.evidence_at,
      decided_at = excluded.decided_at;

  if v_choice.outcome <> 'selected' then
    return;
  end if;

  begin
    select
      max(a.raw_token) filter (
        where a.action = 'confirm_attendance'::public.appointment_client_action
      ),
      max(a.raw_token) filter (
        where a.action = 'request_reschedule'::public.appointment_client_action
      )
    into v_confirm_token, v_reschedule_token
    from crm_private.issue_booking_card_client_actions(v_card.id) a;

    if v_confirm_token is null
       or v_reschedule_token is null
       or v_confirm_token !~ '^[0-9a-f]{64}$'
       or v_reschedule_token !~ '^[0-9a-f]{64}$'
       or v_confirm_token = v_reschedule_token then
      raise exception 'booking card action issuance failed'
        using errcode = '23514';
    end if;

    if v_choice.channel = 'email' then
      v_message_id := crm_private.queue_booking_card_email(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    else
      v_message_id := crm_private.queue_booking_card_whatsapp(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    end if;

    if v_message_id is null then
      -- Rolls back the token pair and any partial message with it.
      raise exception 'booking card channel is unavailable'
        using errcode = '23514';
    end if;
  exception when others then
    get stacked diagnostics v_error_constraint = constraint_name,
                            v_error_table = table_name;
    raise warning 'booking card queue failed, channel=% sqlstate=% constraint=% table=%',
      v_choice.channel, sqlstate,
      coalesce(v_error_constraint, '-'), coalesce(v_error_table, '-');

    update crm_private.booking_card_channel_decisions x
    set outcome = 'delivery_unavailable',
        decided_at = now()
    where x.booking_card_id = v_card.id;
  end;
end;
$$;

revoke all on function crm_private.dispatch_booking_card_once(uuid)
  from public, anon, authenticated, service_role;

-- Queuing a WhatsApp card links its conversation, which would re-enter
-- dispatch through the conversation trigger below. A transaction-local flag
-- keeps dispatch single-entry.
create or replace function crm_private.dispatch_booking_card(p_booking_card_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if coalesce(current_setting('vishar.booking_card_dispatch', true), '') = 'on' then
    return;
  end if;

  perform set_config('vishar.booking_card_dispatch', 'on', true);
  begin
    perform crm_private.dispatch_booking_card_once(p_booking_card_id);
  exception when others then
    perform set_config('vishar.booking_card_dispatch', 'off', true);
    raise;
  end;
  perform set_config('vishar.booking_card_dispatch', 'off', true);
end;
$$;

revoke all on function crm_private.dispatch_booking_card(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. A card waiting for a conversation goes out once one appears
-- ---------------------------------------------------------------------------

create or replace function crm_private.dispatch_waiting_booking_cards(
  p_client_id uuid,
  p_artist_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card_id uuid;
begin
  if p_client_id is null
     or coalesce(current_setting('vishar.booking_card_dispatch', true), '') = 'on' then
    return;
  end if;

  for v_card_id in
    select b.id
    from crm_private.booking_cards b
    where b.client_id = p_client_id
      and (p_artist_id is null or b.artist_id = p_artist_id)
      and b.superseded_at is null
      and b.start_at > now()
      and not exists (
        select 1
        from crm_private.booking_card_deliveries d
        where d.booking_card_id = b.id
      )
    order by b.start_at, b.id
    limit 20
  loop
    perform crm_private.dispatch_booking_card(v_card_id);
  end loop;
end;
$$;

revoke all on function crm_private.dispatch_waiting_booking_cards(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.dispatch_waiting_booking_cards_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_artist_id uuid;
begin
  if tg_table_name = 'communication_messages' then
    select c.client_id, c.artist_id into v_client_id, v_artist_id
    from public.communication_conversations c
    where c.id = new.conversation_id
      and c.link_state = 'linked'::public.communication_link_state;
  else
    v_client_id := new.client_id;
    v_artist_id := new.artist_id;
  end if;

  begin
    perform crm_private.dispatch_waiting_booking_cards(v_client_id, v_artist_id);
  exception when others then
    -- Recording a client's message must never fail because of a card.
    raise warning 'waiting booking card dispatch failed, sqlstate=%', sqlstate;
  end;
  return null;
end;
$$;

revoke all on function crm_private.dispatch_waiting_booking_cards_from_evidence()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_dispatch_waiting_booking_cards
  on public.communication_messages;
create trigger communication_messages_dispatch_waiting_booking_cards
after insert on public.communication_messages
for each row
when (
  new.direction = 'inbound'::public.communication_direction
  or new.origin in ('crm'::public.communication_origin, 'provider_app'::public.communication_origin)
)
execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

drop trigger if exists communication_conversations_dispatch_waiting_booking_cards
  on public.communication_conversations;
create trigger communication_conversations_dispatch_waiting_booking_cards
after update of client_id, link_state on public.communication_conversations
for each row
when (
  new.link_state = 'linked'::public.communication_link_state
  and new.client_id is not null
  and (old.client_id is distinct from new.client_id or old.link_state is distinct from new.link_state)
)
execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

drop trigger if exists email_messages_dispatch_waiting_booking_cards
  on public.email_messages;
create trigger email_messages_dispatch_waiting_booking_cards
after update of status on public.email_messages
for each row
when (
  new.status = 'sent'::public.email_message_status
  and old.status is distinct from new.status
  and new.booking_card_id is null
  and coalesce(new.created_by_kind, '') <> 'system'
)
execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

drop trigger if exists gmail_thread_contexts_dispatch_waiting_booking_cards
  on crm_private.gmail_thread_contexts;
create trigger gmail_thread_contexts_dispatch_waiting_booking_cards
after insert on crm_private.gmail_thread_contexts
for each row execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

drop trigger if exists gmail_client_ai_excerpts_dispatch_waiting_booking_cards
  on crm_private.gmail_client_ai_excerpts;
create trigger gmail_client_ai_excerpts_dispatch_waiting_booking_cards
after insert on crm_private.gmail_client_ai_excerpts
for each row execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

drop trigger if exists gmail_client_metadata_snapshots_dispatch_waiting_booking_cards
  on public.gmail_client_metadata_snapshots;
create trigger gmail_client_metadata_snapshots_dispatch_waiting_booking_cards
after insert or update of last_message_at on public.gmail_client_metadata_snapshots
for each row
when (new.last_message_at is not null)
execute function crm_private.dispatch_waiting_booking_cards_from_evidence();

-- ---------------------------------------------------------------------------
-- 7. Gmail: resolve booking card email, close its job on supersession
-- ---------------------------------------------------------------------------

create or replace function public.service_resolve_gmail_outbox_target(
  p_outbox_id uuid,
  p_worker_id text
)
returns table(
  outbox_id uuid,
  email_message_id uuid,
  artist_id uuid,
  enquiry_id uuid,
  client_id uuid,
  client_email text,
  integration_key text,
  mailbox_email text,
  configuration jsonb,
  delivery_allowed boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_job public.integration_outbox%rowtype;
  v_message public.email_messages%rowtype;
  v_client_email text;
  v_card_current boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail outbox target resolution is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  select o.* into v_job from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status and o.leased_by = p_worker_id
    and o.lease_expires_at > now();
  if not found then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  select m.* into v_message from public.email_messages m
  where m.id = v_job.email_message_id and m.status = 'approved'::public.email_message_status
    and m.artist_id = v_job.artist_id and m.client_id = v_job.client_id
    and m.enquiry_id is not distinct from v_job.enquiry_id
    and m.project_id is not distinct from v_job.project_id
    and m.sent_at is null and m.provider_message_id is null;
  if not found then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;
  select lower(btrim(c.email)) into v_client_email from public.clients c
  where c.id = v_job.client_id;
  if nullif(v_client_email, '') is null
     or v_client_email is distinct from lower(btrim(v_message.to_email)) then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  if v_message.booking_card_id is not null then
    -- Booking card mail is system mail for a session, often without an
    -- enquiry. Its authority is the card and its single Email delivery.
    if v_message.payment_request_id is not null
       or v_message.gmail_thread_context_id is not null
       or v_message.automation_job_id is not null
       or v_message.created_by_kind is distinct from 'system'
       or coalesce(v_message.template_key, '') not in ('booking_card_tattoo', 'booking_card_consultation')
       or v_job.dedupe_key is distinct from 'email:booking_card:' || v_message.booking_card_id::text
       or crm_private.client_send_block_reason(
         v_job.client_id,
         'email'::public.message_template_channel,
         'service'::public.message_classification
       ) is not null then
      raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
    end if;

    select b.superseded_at is null into v_card_current
    from crm_private.booking_cards b
    join crm_private.booking_card_deliveries d
      on d.booking_card_id = b.id
     and d.channel = 'email'::public.message_template_channel
     and d.email_message_id = v_message.id
    where b.id = v_message.booking_card_id
      and b.artist_id = v_job.artist_id
      and b.client_id = v_job.client_id
      and b.enquiry_id is not distinct from v_job.enquiry_id
      and b.project_id is not distinct from v_job.project_id
      and b.session_id is not distinct from v_job.session_id;
    if not found then
      raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
    end if;

    return query
    select v_job.id, v_message.id, v_job.artist_id, v_job.enquiry_id, v_job.client_id,
      v_client_email, i.integration_key, lower(btrim(i.external_account_label)), i.configuration,
      coalesce(v_card_current, false)
    from public.artist_integrations i
    join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
    where i.artist_id = v_job.artist_id and i.integration_type = 'email'::public.artist_integration_type
      and i.provider = 'google' and i.is_enabled
      and nullif(btrim(i.external_account_label), '') is not null;
    if not found then
      raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
    end if;
    return;
  end if;

  if v_message.payment_request_id is null then
    -- Existing enquiry/GPT routing remains authoritative for non-payment mail.
    return query
    select v_job.id, v_message.id, t.artist_id, t.enquiry_id, t.client_id,
      t.client_email, t.integration_key, t.mailbox_email, t.configuration, true
    from public.service_resolve_gmail_target(v_job.artist_id, v_job.enquiry_id, v_job.client_id) t;
    return;
  end if;

  if v_job.enquiry_id is not null or v_message.gmail_thread_context_id is not null
     or v_message.created_by_kind is distinct from 'system' or v_message.automation_job_id is not null
     or coalesce(v_message.template_key, '') not in ('deposit_request', 'deposit_confirmation')
     or not exists (
       select 1 from public.payment_requests r
       join public.projects p on p.id = r.project_id
       where r.id = v_message.payment_request_id and r.purpose = 'deposit'
         and r.artist_id = v_job.artist_id and r.client_id = v_job.client_id
         and r.project_id = v_job.project_id
         and r.session_id is not distinct from v_job.session_id
         and p.artist_id = r.artist_id and p.client_id = r.client_id
     )
     or crm_private.client_send_block_reason(v_job.client_id, 'email', 'service') is not null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select v_job.id, v_message.id, v_job.artist_id, v_job.enquiry_id, v_job.client_id,
    v_client_email, i.integration_key, lower(btrim(i.external_account_label)), i.configuration,
    not crm_private.gmail_deposit_email_obsolete(v_message.id)
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.artist_id = v_job.artist_id and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google' and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null;
  if not found then
    raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
  end if;
end;
$function$;

revoke all on function public.service_resolve_gmail_outbox_target(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_gmail_outbox_target(uuid, text)
  to service_role;

-- A superseded card's Email job is closed at once instead of being retried
-- against a cancelled message until it dies of attempts.
create or replace function crm_private.close_superseded_booking_card_email_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if old.superseded_at is null and new.superseded_at is not null then
    update public.integration_outbox o
    set status = 'dead'::public.outbox_status,
        last_error_code = 'booking_card_superseded',
        leased_by = null,
        leased_at = null,
        lease_expires_at = null,
        updated_at = now()
    where o.kind = 'approved_email'::public.outbox_kind
      and o.dedupe_key = 'email:booking_card:' || new.id::text
      and o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status);
  end if;
  return new;
end;
$$;

revoke all on function crm_private.close_superseded_booking_card_email_job()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_cards_close_superseded_email_job
  on crm_private.booking_cards;
create trigger booking_cards_close_superseded_email_job
after update of superseded_at on crm_private.booking_cards
for each row execute function crm_private.close_superseded_booking_card_email_job();

-- ---------------------------------------------------------------------------
-- 8. CRM status: which channel the card uses, or why it has none
-- ---------------------------------------------------------------------------

create or replace function public.get_session_booking_card_status(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_start_at timestamptz;
  v_finance boolean;
  v_facts record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_card crm_private.booking_cards%rowtype;
  v_deliveries jsonb;
  v_channels_on boolean;
  v_in_window boolean;
  v_channel record;
  v_channel_decided_at timestamptz;
begin
  if p_session_id is null then
    raise exception 'a session id is required' using errcode = '22023';
  end if;

  select s.artist_id, s.client_id, s.start_at into v_artist_id, v_client_id, v_start_at
  from public.sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'view_sessions');
  v_finance := public.can_view_artist_finance(v_artist_id);

  select * into v_facts from crm_private.booking_card_eligibility(p_session_id);

  select * into v_settings
  from crm_private.booking_card_artist_settings bs
  where bs.artist_id = v_artist_id;

  v_channels_on := found and (v_settings.email_enabled or v_settings.whatsapp_enabled);
  v_in_window := v_settings.appointment_start_from is null
    or v_start_at >= v_settings.appointment_start_from;

  select * into v_card
  from crm_private.booking_cards b
  where b.session_id = p_session_id
    and b.superseded_at is null
  order by b.created_at desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', d.channel,
      'status', d.status,
      'skip_reason', d.skip_reason,
      'queued_at', d.queued_at,
      'sent_at', d.sent_at,
      'failed_at', d.failed_at
    ) order by d.channel), '[]'::jsonb)
    into v_deliveries
  from crm_private.booking_card_deliveries d
  where v_card.id is not null
    and d.booking_card_id = v_card.id;

  -- The recorded decision of the current card wins; before a card exists the
  -- same resolver previews what would happen now.
  select x.channel, x.outcome, x.evidence_source, x.evidence_at, x.decided_at
    into v_channel
  from crm_private.booking_card_channel_decisions x
  where v_card.id is not null
    and x.booking_card_id = v_card.id;

  if found then
    v_channel_decided_at := v_channel.decided_at;
  else
    select r.channel, r.outcome, r.evidence_source, r.evidence_at
      into v_channel
    from crm_private.resolve_booking_card_channel(v_client_id, v_artist_id) r;
  end if;

  return jsonb_build_object(
    'session_id', p_session_id,
    'eligible', coalesce(v_facts.eligible, false),
    'reason', v_facts.reason,
    'card_kind', v_facts.card_kind,
    'currency', v_facts.currency,
    'session_price', case when v_finance then v_facts.session_price end,
    'deposit_paid', case when v_finance then v_facts.deposit_paid end,
    'remaining_balance', case when v_finance then v_facts.remaining_balance end,
    'deposit_source', case when v_finance then v_facts.deposit_source end,
    'email_enabled', coalesce(v_settings.email_enabled, false),
    'whatsapp_enabled', coalesce(v_settings.whatsapp_enabled, false),
    'channels_enabled', coalesce(v_channels_on, false),
    'in_rollout_window', coalesce(v_in_window, false),
    'rollout_starts_at', v_settings.appointment_start_from,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'revision', v_card.revision,
      'created_at', v_card.created_at,
      'card_kind', v_card.card_kind
    ) end,
    'channel', v_channel.channel,
    'channel_outcome', v_channel.outcome,
    'channel_evidence_source', v_channel.evidence_source,
    'channel_evidence_at', v_channel.evidence_at,
    'channel_decided_at', v_channel_decided_at,
    'deliveries', v_deliveries
  );
end;
$$;

revoke all on function public.get_session_booking_card_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_session_booking_card_status(uuid) to authenticated;
