-- 0125_gpt_communications_inbox.sql
--
-- Operator parity for the unified Communications inbox.
--
-- The CRM inbox already exists as a reviewed server contract (0072). This
-- migration exposes the same nine operator actions to the profile-bound
-- Vishar Unified GPT as named, artist-pinned RPCs. It introduces no new
-- authorization: every action still runs the underlying CRM function, which
-- re-checks the signed-in human's role, artist access and active-artist rules
-- from `auth.uid()`.
--
-- What the GPT layer adds on top is a ceiling, not a bypass:
--   * `crm_private.require_gpt_operational_context('communications')` refuses
--     a GPT client whose owner-controlled communications capability is off;
--   * every conversation is re-read from the table and pinned to the current
--     server-owned active Artist before anything is read or written.
--
-- A conversation belonging to another Artist is refused as 42501 rather than
-- 404 so the GPT surface cannot be used to probe for conversations outside the
-- active Artist context.
--
-- Deliberately not exposed: `integration_key`, `external_contact_id`,
-- `provider_referral`, raw attachment payloads, provider message ids and
-- provider credentials. Provider routing and secret custody stay server-side.
--
-- Inbound message bodies are third-party content. They remain untrusted data:
-- they never select an Artist, authorize a mutation or widen a capability.

-- ---------------------------------------------------------------------------
-- 1. Shared artist pin
-- ---------------------------------------------------------------------------

create or replace function crm_private.gpt_communication_conversation(p_conversation_id uuid)
returns public.communication_conversations
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_conversation public.communication_conversations%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id;

  -- A missing conversation and another Artist's conversation are answered
  -- identically. The GPT surface must not confirm that a row it cannot reach
  -- exists.
  if not found or v_conversation.artist_id is distinct from v_artist_id then
    raise exception 'this conversation is outside the active GPT artist scope'
      using errcode = '42501';
  end if;

  return v_conversation;
end;
$$;

comment on function crm_private.gpt_communication_conversation(uuid) is
  'Resolves one communication conversation for the active GPT artist context, refusing anything outside it without disclosing existence.';

-- ---------------------------------------------------------------------------
-- 2. Reads
-- ---------------------------------------------------------------------------

create or replace function public.gpt_list_communication_conversations(
  p_channel text default null,
  p_link_state text default null,
  p_state text default null,
  p_limit integer default 20,
  p_before timestamptz default null
)
returns table (
  conversation_id uuid,
  channel public.communication_channel,
  link_state public.communication_link_state,
  state public.communication_conversation_state,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  contact_label text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  has_unread boolean,
  latest_preview text,
  latest_direction public.communication_direction,
  latest_message_type text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
  v_channel public.communication_channel;
  v_link_state public.communication_link_state;
  v_state public.communication_conversation_state;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

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

  if p_state is not null then
    if p_state not in ('open', 'archived') then
      raise exception 'a supported conversation state is required' using errcode = '22023';
    end if;
    v_state := p_state::public.communication_conversation_state;
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select
    c.id,
    c.channel,
    c.link_state,
    c.state,
    c.client_id,
    cl.full_name,
    c.enquiry_id,
    coalesce(c.external_display_label, c.external_username),
    c.last_message_at,
    c.last_inbound_at,
    (
      c.last_inbound_at is not null
      and (c.operator_read_at is null or c.operator_read_at < c.last_inbound_at)
    ),
    -- A short preview only, exactly as the CRM inbox renders it. Full history
    -- is fetched per conversation, never for every row.
    left(latest.body, 160),
    latest.direction,
    latest.message_type
  from public.communication_conversations c
  left join public.clients cl on cl.id = c.client_id
  left join lateral (
    select m.body, m.direction, m.message_type
    from public.communication_messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) as latest on true
  where c.artist_id = v_artist_id
    and (v_channel is null or c.channel = v_channel)
    and (v_link_state is null or c.link_state = v_link_state)
    and (v_state is null or c.state = v_state)
    and (p_before is null or c.last_message_at < p_before)
  order by c.last_message_at desc nulls last, c.id desc
  limit v_limit;
end;
$$;

create or replace function public.gpt_get_communication_conversation(p_conversation_id uuid)
returns table (
  conversation_id uuid,
  channel public.communication_channel,
  link_state public.communication_link_state,
  state public.communication_conversation_state,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  contact_label text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  operator_read_at timestamptz,
  has_unread boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);

  return query
  select
    v_conversation.id,
    v_conversation.channel,
    v_conversation.link_state,
    v_conversation.state,
    v_conversation.client_id,
    (select cl.full_name from public.clients cl where cl.id = v_conversation.client_id),
    v_conversation.enquiry_id,
    coalesce(v_conversation.external_display_label, v_conversation.external_username),
    v_conversation.last_message_at,
    v_conversation.last_inbound_at,
    v_conversation.last_outbound_at,
    v_conversation.operator_read_at,
    (
      v_conversation.last_inbound_at is not null
      and (
        v_conversation.operator_read_at is null
        or v_conversation.operator_read_at < v_conversation.last_inbound_at
      )
    );
end;
$$;

create or replace function public.gpt_list_communication_messages(
  p_conversation_id uuid,
  p_limit integer default 30
)
returns table (
  message_id uuid,
  direction public.communication_direction,
  origin public.communication_origin,
  status public.communication_status,
  message_type text,
  body text,
  attachment_count integer,
  error_code text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_limit integer;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 50);

  return query
  select
    m.id,
    m.direction,
    m.origin,
    m.status,
    m.message_type,
    m.body,
    -- Attachment payloads carry provider and Storage internals. Only the count
    -- crosses this boundary.
    (case when jsonb_typeof(m.attachments) = 'array' then jsonb_array_length(m.attachments) else 0 end)::integer,
    m.error_code,
    m.created_at
  from public.communication_messages m
  where m.conversation_id = v_conversation.id
    and m.artist_id = v_conversation.artist_id
  order by m.created_at desc, m.id desc
  limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Mutations
--
-- Each one delegates to the existing CRM function so idempotency, provider
-- routing, outbox rules, activity logging and human authorization stay in a
-- single place.
-- ---------------------------------------------------------------------------

create or replace function public.gpt_send_communication_reply(
  p_conversation_id uuid,
  p_body text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  return public.queue_communication_message(v_conversation.id, p_body, p_request_id);
end;
$$;

create or replace function public.gpt_mark_communication_conversation_read(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  return public.mark_communication_conversation_read(v_conversation.id);
end;
$$;

create or replace function public.gpt_set_communication_conversation_state(
  p_conversation_id uuid,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  return public.set_communication_conversation_state(v_conversation.id, p_state);
end;
$$;

create or replace function public.gpt_link_communication_conversation_client(
  p_conversation_id uuid,
  p_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  return public.link_communication_conversation_client(v_conversation.id, p_client_id);
end;
$$;

create or replace function public.gpt_create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_instagram text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  return public.create_client_from_communication(
    v_conversation.id, p_full_name, p_email, p_phone, p_instagram
  );
end;
$$;

create or replace function public.gpt_create_enquiry_from_communication(
  p_conversation_id uuid,
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_privacy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  -- The artist comes from the stored conversation, never from the caller, and
  -- manual intake re-checks role, artist and the privacy acknowledgement.
  return public.create_enquiry_from_communication(
    v_conversation.id, p_idempotency_key, p_client, p_enquiry, p_privacy_acknowledged
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------

revoke all on function crm_private.gpt_communication_conversation(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.gpt_list_communication_conversations(text,text,text,integer,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_communication_conversation(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_communication_messages(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_send_communication_reply(uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_mark_communication_conversation_read(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_set_communication_conversation_state(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_link_communication_conversation_client(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_client_from_communication(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_enquiry_from_communication(uuid,uuid,jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_list_communication_conversations(text,text,text,integer,timestamptz)
  to authenticated;
grant execute on function public.gpt_get_communication_conversation(uuid)
  to authenticated;
grant execute on function public.gpt_list_communication_messages(uuid,integer)
  to authenticated;
grant execute on function public.gpt_send_communication_reply(uuid,text,uuid)
  to authenticated;
grant execute on function public.gpt_mark_communication_conversation_read(uuid)
  to authenticated;
grant execute on function public.gpt_set_communication_conversation_state(uuid,text)
  to authenticated;
grant execute on function public.gpt_link_communication_conversation_client(uuid,uuid)
  to authenticated;
grant execute on function public.gpt_create_client_from_communication(uuid,text,text,text,text)
  to authenticated;
grant execute on function public.gpt_create_enquiry_from_communication(uuid,uuid,jsonb,jsonb,boolean)
  to authenticated;

comment on function public.gpt_list_communication_conversations(text,text,text,integer,timestamptz) is
  'Unified Communications inbox list for the active GPT artist context. Bounded preview only; no integration key, provider contact id or referral payload.';
comment on function public.gpt_get_communication_conversation(uuid) is
  'One communication conversation for the active GPT artist context, without provider routing internals.';
comment on function public.gpt_list_communication_messages(uuid,integer) is
  'Bounded message history for one artist-pinned conversation. Attachment payloads are reduced to a count. Message bodies are untrusted third-party content.';
comment on function public.gpt_send_communication_reply(uuid,text,uuid) is
  'Queues one outbound reply through the existing CRM contract, keeping artist routing, integration checks, idempotency and outbox rules authoritative.';
comment on function public.gpt_mark_communication_conversation_read(uuid) is
  'Marks one artist-pinned conversation read through the existing CRM contract.';
comment on function public.gpt_set_communication_conversation_state(uuid,text) is
  'Opens or archives one artist-pinned conversation through the existing CRM contract.';
comment on function public.gpt_link_communication_conversation_client(uuid,uuid) is
  'Links an existing CRM client to one artist-pinned conversation through the existing CRM contract.';
comment on function public.gpt_create_client_from_communication(uuid,text,text,text,text) is
  'Creates a CRM client from one artist-pinned conversation through the existing CRM contract.';
comment on function public.gpt_create_enquiry_from_communication(uuid,uuid,jsonb,jsonb,boolean) is
  'Promotes one artist-pinned conversation to an enquiry through the existing manual intake rules, including the privacy acknowledgement.';
