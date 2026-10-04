-- What an inbound message asks of the studio, and what the operator can say
-- about a conversation the CRM cannot answer for.
--
-- 1. One server-side actionability rule. A reaction, an unsupported provider
--    event, an edit or a revoke is stored as history but asks nothing of the
--    studio. Every other inbound type (text, image, audio, video, document,
--    and any type this CRM does not know yet) is actionable: unknown types
--    fail open so a new provider format can never hide a real client.
-- 2. A conversation waits on the studio when its newest actionable inbound
--    is newer than the studio's newest provider-accepted reply. Today, the
--    Telegram reminders, the client attention facts and the Inbox all read
--    crm_private.conversation_awaiting_reply_since(), not the newest row.
-- 3. Two reversible operator states, neither of which deletes history:
--    * not_crm (communication_conversations.not_crm_at/_by): a personal,
--      non-business conversation. It stays hidden until the operator clears
--      it, and stops applying the moment the conversation is linked to a
--      client: a linked client's messages are never hidden by it.
--    * handled outside the CRM: the existing version-scoped Today
--      acknowledgement (attention_acknowledgements, kind conversation_reply,
--      observed_at = the actionable inbound it covers). A newer actionable
--      inbound is not covered and returns to Today. It can now be undone.
-- 4. Archive no longer hides a new actionable inbound: it reopens the
--    conversation, unless the operator marked the unlinked conversation
--    not_crm.
-- 5. Exact WhatsApp linking also runs from the client side: a client whose
--    phone becomes the unique exact E.164 match for an unlinked WhatsApp
--    conversation in that artist's scope is linked to it. Ambiguous or
--    cross-artist matches stay unlinked (fail closed). No fuzzy matching.
-- 6. Backfill of derived state only: exact client links, and reopening an
--    archived conversation whose actionable inbound is newer than its last
--    recorded archive event and still unanswered. Nothing is marked not_crm.

-- ---------------------------------------------------------------------------
-- 1. Actionability
-- ---------------------------------------------------------------------------

create function crm_private.communication_event_is_actionable(p_message_type text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(p_message_type, '') not in ('reaction', 'unsupported', 'edit', 'revoke');
$$;

revoke all on function crm_private.communication_event_is_actionable(text)
  from public, anon, authenticated, service_role;

comment on function crm_private.communication_event_is_actionable(text) is
  'True when an inbound message of this type asks something of the studio. Reaction, unsupported, edit and revoke do not; every other type, including unknown ones, does.';

-- ---------------------------------------------------------------------------
-- 2. Waiting on the studio
-- ---------------------------------------------------------------------------

create function crm_private.conversation_last_actionable_inbound_at(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select max(coalesce(m.provider_timestamp, m.created_at))
  from public.communication_messages m
  where m.conversation_id = p_conversation_id
    and m.direction = 'inbound'
    and crm_private.communication_event_is_actionable(m.message_type);
$$;

-- The studio's turn: a message the provider accepted, sent from the CRM or by
-- hand from the provider app. A queued or failed send never reached the
-- client, an automated message is not the studio answering, and an edit or
-- revoke of an earlier message is not a new reply. A reaction is.
create function crm_private.conversation_last_studio_reply_at(p_conversation_id uuid)
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
    and m.message_type not in ('edit', 'revoke');
$$;

create function crm_private.conversation_awaiting_reply_since(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when x.inbound_at is not null
     and x.inbound_at > coalesce(x.reply_at, '-infinity'::timestamptz)
    then x.inbound_at
  end
  from (
    select crm_private.conversation_last_actionable_inbound_at(p_conversation_id) as inbound_at,
           crm_private.conversation_last_studio_reply_at(p_conversation_id) as reply_at
  ) x;
$$;

revoke all on function crm_private.conversation_last_actionable_inbound_at(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.conversation_last_studio_reply_at(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.conversation_awaiting_reply_since(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.conversation_awaiting_reply_since(uuid) is
  'The newest actionable inbound time while it is newer than the studio''s newest provider-accepted reply; null when nothing waits on the studio.';

-- ---------------------------------------------------------------------------
-- 3. not_crm: a personal conversation, reversible
-- ---------------------------------------------------------------------------

alter table public.communication_conversations
  add column not_crm_at timestamptz,
  add column not_crm_by uuid references public.profiles(id) on delete set null,
  add constraint communication_conversations_not_crm_by_requires_at
    check (not_crm_by is null or not_crm_at is not null);

comment on column public.communication_conversations.not_crm_at is
  'Operator marked this conversation personal / not CRM work. Hides it from Today and the unknown-sender queue only while it is not linked to a client. History is untouched.';

-- True when the operator's personal mark applies: only to a conversation the
-- CRM cannot name. Linking a client makes it inert without erasing it.
create function crm_private.conversation_hidden_as_not_crm(
  p_not_crm_at timestamptz,
  p_client_id uuid,
  p_enquiry_id uuid
)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_not_crm_at is not null and p_client_id is null and p_enquiry_id is null;
$$;

revoke all on function crm_private.conversation_hidden_as_not_crm(timestamptz, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.set_conversation_not_crm(
  p_conversation_id uuid,
  p_not_crm boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  if p_conversation_id is null or p_not_crm is null then
    raise exception 'a conversation and a decision are required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');
  perform crm_private.require_active_artist(v_conversation.artist_id);

  if p_not_crm and (v_conversation.client_id is not null or v_conversation.enquiry_id is not null) then
    raise exception 'a conversation linked to a client cannot be marked personal'
      using errcode = '23514';
  end if;

  update public.communication_conversations c
  set not_crm_at = case when p_not_crm then coalesce(c.not_crm_at, clock_timestamp()) end,
      not_crm_by = case when p_not_crm then coalesce(c.not_crm_by, auth.uid()) end,
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    case when p_not_crm then 'communication.not_crm_marked' else 'communication.not_crm_cleared' end,
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_conversation.client_id,
    v_conversation.enquiry_id,
    null, null, null,
    jsonb_build_object('channel', v_conversation.channel, 'conversation', v_conversation.id)
  );

  return jsonb_build_object('conversation_id', v_conversation.id, 'not_crm', p_not_crm);
end;
$$;

revoke all on function public.set_conversation_not_crm(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_conversation_not_crm(uuid, boolean) to authenticated;

comment on function public.set_conversation_not_crm(uuid, boolean) is
  'Marks or clears an unlinked conversation as personal / not CRM work. Reversible; deletes no message.';

-- ---------------------------------------------------------------------------
-- 4. Handled outside the CRM: undo for the existing acknowledgement
-- ---------------------------------------------------------------------------

create function public.clear_attention_acknowledgement(
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
  if p_item_kind not in ('conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding') then
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
      null, null, null, null, null,
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

comment on function public.clear_attention_acknowledgement(uuid, text, uuid) is
  'Undoes an operator acknowledgement ("handled outside the CRM"): the Today item returns if its source still waits. Changes no business record.';

-- What the conversation screen needs to offer those two actions.
create function public.get_conversation_attention(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_since timestamptz;
  v_ack public.attention_acknowledgements%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;
  perform crm_private.require_role('owner', 'booking_manager', 'read_only');

  select c.* into v_conversation from public.communication_conversations c where c.id = p_conversation_id;
  if not found or not public.can_access_artist(v_conversation.artist_id) then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  v_since := crm_private.conversation_awaiting_reply_since(v_conversation.id);
  select a.* into v_ack from public.attention_acknowledgements a
  where a.artist_id = v_conversation.artist_id and a.item_kind = 'conversation_reply'
    and a.entity_id = v_conversation.id;

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'artist_id', v_conversation.artist_id,
    'awaiting_reply_since', v_since,
    'not_crm_at', v_conversation.not_crm_at,
    'handled_outside_crm_at',
      case when v_since is not null and v_ack.observed_at >= v_since then v_ack.acknowledged_at end,
    'needs_reply',
      v_conversation.state = 'open' and v_since is not null
      and not crm_private.conversation_hidden_as_not_crm(
        v_conversation.not_crm_at, v_conversation.client_id, v_conversation.enquiry_id)
      and not coalesce(v_ack.observed_at >= v_since, false)
  );
end;
$$;

revoke all on function public.get_conversation_attention(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_conversation_attention(uuid) to authenticated;

comment on function public.get_conversation_attention(uuid) is
  'Whether a conversation waits on the studio, since when, and the operator states (not_crm, handled outside the CRM) that apply to it.';

-- ---------------------------------------------------------------------------
-- 5. Archive does not hide a new actionable inbound
-- ---------------------------------------------------------------------------

create function crm_private.reopen_conversation_on_actionable_inbound()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.direction <> 'inbound' or not crm_private.communication_event_is_actionable(new.message_type) then
    return null;
  end if;

  update public.communication_conversations c
  set state = 'open', updated_at = now()
  where c.id = new.conversation_id
    and c.state = 'archived'
    and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id);
  return null;
end;
$$;

revoke all on function crm_private.reopen_conversation_on_actionable_inbound()
  from public, anon, authenticated, service_role;

create trigger communication_messages_reopen_on_actionable_inbound
after insert on public.communication_messages
for each row execute function crm_private.reopen_conversation_on_actionable_inbound();

-- ---------------------------------------------------------------------------
-- 6. Exact WhatsApp linking from the client side
-- ---------------------------------------------------------------------------

create function crm_private.link_whatsapp_conversations_for_client(p_client_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_phone text;
  v_count integer := 0;
begin
  select crm_private.normalize_whatsapp_phone(cl.phone) into v_phone
  from public.clients cl
  where cl.id = p_client_id and cl.archived_at is null;
  if v_phone is null then
    return 0;
  end if;

  with targets as (
    select c.id, c.artist_id
    from public.communication_conversations c
    where c.client_id is null
      and c.channel = 'whatsapp'
      and crm_private.normalize_whatsapp_phone('+' || c.external_contact_id) = v_phone
      -- Unique exact match inside this conversation's artist scope, or nothing.
      and crm_private.unique_whatsapp_client_match(c.artist_id, c.external_contact_id) = p_client_id
  ), linked as (
    update public.communication_conversations c
    set client_id = p_client_id,
        link_state = 'linked',
        enquiry_id = coalesce(c.enquiry_id, (
          select e.id from public.enquiries e
          where e.artist_id = t.artist_id and e.client_id = p_client_id and e.archived_at is null
          order by e.updated_at desc, e.created_at desc, e.id desc
          limit 1)),
        updated_at = now()
    from targets t
    where c.id = t.id and c.client_id is null
    returning c.id
  )
  select count(*)::integer into v_count from linked;
  return v_count;
end;
$$;

revoke all on function crm_private.link_whatsapp_conversations_for_client(uuid)
  from public, anon, authenticated, service_role;

-- Linking is derived state. A failure here must never fail the client or
-- enquiry write that triggered it; the conversation simply stays unlinked.
create function crm_private.link_whatsapp_conversations_after_client_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
begin
  if tg_table_name = 'clients' then
    v_client_id := new.id;
  else
    v_client_id := (to_jsonb(new) ->> 'client_id')::uuid;
  end if;
  if v_client_id is not null then
    begin
      perform crm_private.link_whatsapp_conversations_for_client(v_client_id);
    exception when others then
      raise warning 'whatsapp client relink skipped, sqlstate=%', sqlstate;
    end;
  end if;
  return null;
end;
$$;

revoke all on function crm_private.link_whatsapp_conversations_after_client_change()
  from public, anon, authenticated, service_role;

create trigger clients_link_whatsapp_conversations
after insert or update of phone, archived_at on public.clients
for each row execute function crm_private.link_whatsapp_conversations_after_client_change();

-- A new client is outside every artist scope until its first enquiry or
-- project exists, so the same link is retried when one appears.
create trigger enquiries_link_whatsapp_conversations
after insert or update of client_id, artist_id on public.enquiries
for each row execute function crm_private.link_whatsapp_conversations_after_client_change();

create trigger projects_link_whatsapp_conversations
after insert or update of client_id, artist_id on public.projects
for each row execute function crm_private.link_whatsapp_conversations_after_client_change();

-- ---------------------------------------------------------------------------
-- 7. Inbox projection carries the server's answer
-- ---------------------------------------------------------------------------
-- Same projection as 0072 plus the waiting state, the operator states and an
-- optional needs-reply filter, so the browser stops deciding from the newest
-- row (a reaction or an edit made a conversation look answered or waiting).

drop function public.list_communication_conversations(text, text, integer, timestamptz);

create function public.list_communication_conversations(
  p_channel text default null,
  p_link_state text default null,
  p_limit integer default 30,
  p_before timestamptz default null,
  p_needs_reply boolean default null
)
returns table (
  id uuid,
  artist_id uuid,
  channel public.communication_channel,
  link_state public.communication_link_state,
  state public.communication_conversation_state,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  external_username text,
  external_display_label text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  operator_read_at timestamptz,
  has_unread boolean,
  latest_preview text,
  latest_direction public.communication_direction,
  latest_message_type text,
  awaiting_reply_since timestamptz,
  needs_reply boolean,
  not_crm_at timestamptz,
  handled_outside_crm_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_limit integer;
  v_channel public.communication_channel;
  v_link_state public.communication_link_state;
begin
  perform crm_private.require_role('owner', 'booking_manager', 'read_only');

  v_limit := coalesce(p_limit, 30);
  if v_limit < 1 or v_limit > 100 then
    raise exception 'the page size must be between 1 and 100' using errcode = '22023';
  end if;

  if p_channel is not null then
    if p_channel not in ('whatsapp', 'instagram') then
      raise exception 'a supported channel is required' using errcode = '22023';
    end if;
    v_channel := p_channel::public.communication_channel;
  end if;

  if p_link_state is not null then
    if p_link_state not in ('unmatched', 'linked') then
      raise exception 'a supported link state is required' using errcode = '22023';
    end if;
    v_link_state := p_link_state::public.communication_link_state;
  end if;

  return query
  with base as (
    select c.*, crm_private.conversation_awaiting_reply_since(c.id) as since
    from public.communication_conversations c
    where public.can_access_artist(c.artist_id)
      and (v_channel is null or c.channel = v_channel)
      and (v_link_state is null or c.link_state = v_link_state)
      and (p_before is null or c.last_message_at < p_before)
  ), judged as (
    select b.*, k.observed_at as ack_observed_at, k.acknowledged_at as ack_at,
      (b.state = 'open' and b.since is not null
        and not crm_private.conversation_hidden_as_not_crm(b.not_crm_at, b.client_id, b.enquiry_id)
        and not coalesce(k.observed_at >= b.since, false)) as needs
    from base b
    left join public.attention_acknowledgements k
      on k.artist_id = b.artist_id and k.item_kind = 'conversation_reply' and k.entity_id = b.id
  )
  select
    j.id,
    j.artist_id,
    j.channel,
    j.link_state,
    j.state,
    j.client_id,
    cl.full_name,
    j.enquiry_id,
    j.external_username,
    j.external_display_label,
    j.last_message_at,
    j.last_inbound_at,
    j.operator_read_at,
    (
      j.last_inbound_at is not null
      and (j.operator_read_at is null or j.operator_read_at < j.last_inbound_at)
    ) as has_unread,
    left(latest.body, 160) as latest_preview,
    latest.direction,
    latest.message_type,
    j.since,
    j.needs,
    j.not_crm_at,
    case when j.since is not null and j.ack_observed_at >= j.since then j.ack_at end
  from judged j
  left join public.clients cl on cl.id = j.client_id
  left join lateral (
    select m.body, m.direction, m.message_type
    from public.communication_messages m
    where m.conversation_id = j.id
    order by m.created_at desc, m.id desc
    limit 1
  ) as latest on true
  where p_needs_reply is null or j.needs = p_needs_reply
  order by j.last_message_at desc nulls last, j.id desc
  limit v_limit;
end;
$$;

revoke all on function public.list_communication_conversations(text, text, integer, timestamptz, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.list_communication_conversations(text, text, integer, timestamptz, boolean)
  to authenticated;

comment on function public.list_communication_conversations(text, text, integer, timestamptz, boolean) is
  'Bounded artist-scoped inbox projection with keyset pagination and the server''s needs-reply answer. Returns no provider metadata and no message history.';

-- ---------------------------------------------------------------------------
-- 8. Today, Telegram reminders and client attention read the same rule
-- ---------------------------------------------------------------------------

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
as $$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as (
    select ac.client_id, crm_private.client_attention(p_artist_id, ac.client_id, (select t from now_)) as a
    from crm_private.pulse_active_clients(p_artist_id) ac
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
    -- The studio spoke last and the client went quiet (Phase 2 SLA).
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason', null
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')

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
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz)
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', r.href, 'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$$;

revoke all on function crm_private.pulse_items(uuid, boolean, boolean, timestamptz) from public, anon, authenticated, service_role;

create or replace function crm_private.unanswered_waiting_since(p_entity_type text, p_artist_id uuid, p_entity_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case p_entity_type
    when 'conversation' then (
      select w.since
      from public.communication_conversations c
      cross join lateral (select crm_private.conversation_awaiting_reply_since(c.id) as since) w
      where c.id = p_entity_id
        and c.artist_id = p_artist_id
        and c.state = 'open'
        and w.since is not null
        and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id)
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = c.artist_id and k.item_kind = 'conversation_reply'
            and k.entity_id = c.id and k.observed_at >= w.since))
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
      -- A website enquiry the artist has not answered (same rule as Today).
      select e.created_at
      from public.enquiries e
      where e.id = p_entity_id
        and e.artist_id = p_artist_id
        and e.archived_at is null and e.status = 'new' and e.intake_state = 'complete'
        and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
        and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
        and not crm_private.enquiry_has_artist_reply(e.id)
        and not exists (
          select 1 from public.email_messages m
          where m.artist_id = e.artist_id
            and (m.enquiry_id = e.id or m.client_id = e.client_id)
            and m.created_at >= e.created_at
            and ((m.status = 'draft' and m.created_by_kind = 'human') or m.status = 'failed'))
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = e.artist_id and k.item_kind = 'new_enquiry'
            and k.entity_id = e.id and k.observed_at >= e.created_at))
  end;
$$;

revoke all on function crm_private.unanswered_waiting_since(text, uuid, uuid)
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
           crm_private.conversation_last_actionable_inbound_at(c.id) as observed_at,
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
        and crm_private.communication_event_is_actionable(m.message_type)
      order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
      limit 1
    ) latest on true
    where c.state = 'open'
      and c.last_inbound_at > v_now - interval '72 hours'
      and crm_private.conversation_last_actionable_inbound_at(c.id)
          between v_now - interval '72 hours' and v_now - interval '6 hours'
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
-- 9. Backfill of derived state
-- ---------------------------------------------------------------------------

-- Exact links the conversation-side trigger missed because the client's
-- phone was added or normalised after the conversation last changed.
do $$
declare
  v_client record;
begin
  for v_client in
    select distinct m.client_id
    from public.communication_conversations c
    cross join lateral (
      select crm_private.unique_whatsapp_client_match(c.artist_id, c.external_contact_id) as client_id
    ) m
    where c.client_id is null and c.channel = 'whatsapp' and m.client_id is not null
  loop
    perform crm_private.link_whatsapp_conversations_for_client(v_client.client_id);
  end loop;
end;
$$;

-- An archived conversation whose newest actionable inbound arrived after its
-- last recorded archive event and is still unanswered was hidden by archive
-- alone. Without a recorded archive event there is no evidence of order, and
-- the conversation is left to the operator.
with archived as (
  select (l.metadata ->> 'conversation')::uuid as conversation_id, max(l.occurred_at) as archived_at
  from public.activity_log l
  where l.event_type = 'communication.state_changed' and l.metadata ->> 'state' = 'archived'
    and l.metadata ->> 'conversation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  group by 1
)
update public.communication_conversations c
set state = 'open', updated_at = now()
from archived a
where c.id = a.conversation_id
  and c.state = 'archived'
  and crm_private.conversation_awaiting_reply_since(c.id) > a.archived_at
  and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id);
