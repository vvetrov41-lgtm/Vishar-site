-- 0072_communications_inbox.sql
--
-- The CRM-facing half of the communications domain: a bounded inbox
-- projection, the operator actions that turn an unknown sender into a known
-- one, and the provenance an Instagram-sourced enquiry carries afterwards.
--
-- The rule this migration exists to enforce is that an inbound direct message
-- is not an enquiry. Instagram traffic includes reactions, greetings, spam and
-- ordinary chat with existing clients, so automatically minting a tattoo
-- enquiry from every DM would fill the CRM pipeline with noise and destroy the
-- meaning of the enquiry funnel. An unknown sender therefore stays an
-- `unmatched` conversation until an operator decides what it is.
--
-- Automatic linking is deliberately narrow. The only identifier trusted to
-- link on its own is the provider participant id, which is why a returning
-- sender lands back in their existing conversation with its existing client
-- link. Name or handle similarity is offered to the operator as a suggestion
-- in the interface and is never applied as an authoritative action here.
--
-- Forward-only. No provider call, no credential, no cron change, no deployment
-- and no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. Enquiry provenance
--
-- Attribution lives in typed columns rather than in the free-text `source`
-- field. A foreign key to the conversation cannot be forged by a browser, and
-- it keeps the Meta ad -> DM -> enquiry -> project funnel joinable later
-- without building a separate analytics store now.
-- ---------------------------------------------------------------------------

alter table public.enquiries
  add column if not exists communication_conversation_id uuid
    references public.communication_conversations(id) on delete set null;

alter table public.enquiries
  add column if not exists communication_channel public.communication_channel;

alter table public.enquiries
  add column if not exists created_from_communication boolean not null default false;

do $$ begin
  alter table public.enquiries
    add constraint enquiries_communication_provenance_consistent
    check (
      (created_from_communication and communication_channel is not null)
      or (not created_from_communication
          and communication_channel is null
          and communication_conversation_id is null)
    );
exception when duplicate_object then null; end $$;

comment on column public.enquiries.communication_conversation_id is
  'The communication conversation this enquiry was created from. Written only by create_enquiry_from_communication; browsers cannot set it.';
comment on column public.enquiries.created_from_communication is
  'True when the enquiry originated in a messaging conversation rather than the booking form or manual intake.';

create index if not exists enquiries_communication_conversation_idx
  on public.enquiries (communication_conversation_id)
  where communication_conversation_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Client reachability
--
-- A client the CRM only knows through a messaging conversation has no enquiry
-- and no project yet, so the existing reachability rules would hide the record
-- that was just created. A linked conversation is an artist-scoped
-- relationship in exactly the same sense, and is added as one. The scope does
-- not widen: an artist still sees only clients their own records reach.
-- ---------------------------------------------------------------------------

create or replace function public.can_access_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.client_id = p_client_id
        and public.can_access_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.projects p
      where p.client_id = p_client_id
        and public.can_access_artist(p.artist_id)
    )
    or exists (
      select 1
      from public.communication_conversations c
      where c.client_id = p_client_id
        and public.can_access_artist(c.artist_id)
    );
$$;

create or replace function public.can_manage_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    crm_private.is_service_backend()
    or exists (
      select 1
      from public.enquiries e
      where e.client_id = p_client_id
        and public.can_manage_artist(e.artist_id)
    )
    or exists (
      select 1
      from public.projects p
      where p.client_id = p_client_id
        and public.can_manage_artist(p.artist_id)
    )
    or exists (
      select 1
      from public.communication_conversations c
      where c.client_id = p_client_id
        and public.can_manage_artist(c.artist_id)
    );
$$;

revoke all on function public.can_access_client(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_client(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_access_client(uuid) to authenticated;
grant execute on function public.can_manage_client(uuid) to authenticated;

-- A client belongs to a conversation's artist scope only when that artist's
-- own records reach it. This is stricter than `can_manage_client`, which is
-- satisfied by any artist the operator manages, and it is what stops a
-- Kristina client from being attached to a Vladimir conversation.
create or replace function crm_private.client_in_artist_scope(
  p_client_id uuid,
  p_artist_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from public.enquiries e
    where e.client_id = p_client_id and e.artist_id = p_artist_id
  ) or exists (
    select 1 from public.projects p
    where p.client_id = p_client_id and p.artist_id = p_artist_id
  ) or exists (
    select 1 from public.communication_conversations c
    where c.client_id = p_client_id and c.artist_id = p_artist_id
  );
$$;

revoke all on function crm_private.client_in_artist_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_in_artist_scope(uuid, uuid) is
  'True when the named artist''s own records already reach this client. Used to refuse cross-artist conversation linking.';

-- ---------------------------------------------------------------------------
-- 3. Inbox projection
--
-- One bounded, keyset-paginated query serves the whole inbox. It returns the
-- fields the list actually renders and nothing else: no provider metadata, no
-- credential, and no message history.
-- ---------------------------------------------------------------------------

create or replace function public.list_communication_conversations(
  p_channel text default null,
  p_link_state text default null,
  p_limit integer default 30,
  p_before timestamptz default null
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
  latest_message_type text
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
  select
    c.id,
    c.artist_id,
    c.channel,
    c.link_state,
    c.state,
    c.client_id,
    cl.full_name,
    c.enquiry_id,
    c.external_username,
    c.external_display_label,
    c.last_message_at,
    c.last_inbound_at,
    c.operator_read_at,
    (
      c.last_inbound_at is not null
      and (c.operator_read_at is null or c.operator_read_at < c.last_inbound_at)
    ) as has_unread,
    -- A short preview only. The full conversation is loaded on demand so the
    -- inbox never pulls message history for every row.
    left(latest.body, 160) as latest_preview,
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
  where public.can_access_artist(c.artist_id)
    and (v_channel is null or c.channel = v_channel)
    and (v_link_state is null or c.link_state = v_link_state)
    and (p_before is null or c.last_message_at < p_before)
  order by c.last_message_at desc nulls last, c.id desc
  limit v_limit;
end;
$$;

revoke all on function public.list_communication_conversations(text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.list_communication_conversations(text, text, integer, timestamptz)
  to authenticated;

comment on function public.list_communication_conversations(text, text, integer, timestamptz) is
  'Bounded artist-scoped inbox projection with keyset pagination. Returns no provider metadata and no message history.';

-- ---------------------------------------------------------------------------
-- 4. Operator actions
-- ---------------------------------------------------------------------------

create or replace function public.mark_communication_conversation_read(
  p_conversation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');

  update public.communication_conversations c
  set operator_read_at = greatest(
        coalesce(c.operator_read_at, '-infinity'::timestamptz),
        coalesce(c.last_message_at, now())
      ),
      updated_at = now()
  where c.id = v_conversation.id;

  return jsonb_build_object('conversation_id', v_conversation.id);
end;
$$;

revoke all on function public.mark_communication_conversation_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_communication_conversation_read(uuid)
  to authenticated;

create or replace function public.set_communication_conversation_state(
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
  v_state public.communication_conversation_state;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;
  if p_state is null or p_state not in ('open', 'archived') then
    raise exception 'a supported conversation state is required' using errcode = '22023';
  end if;
  v_state := p_state::public.communication_conversation_state;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');
  perform crm_private.require_active_artist(v_conversation.artist_id);

  update public.communication_conversations c
  set state = v_state,
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'communication.state_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_conversation.client_id,
    v_conversation.enquiry_id,
    null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
      'conversation', v_conversation.id,
      'state', v_state
    )
  );

  return jsonb_build_object('conversation_id', v_conversation.id, 'state', v_state);
end;
$$;

revoke all on function public.set_communication_conversation_state(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_communication_conversation_state(uuid, text)
  to authenticated;

comment on function public.set_communication_conversation_state(uuid, text) is
  'Artist-scoped open/archive control for one conversation. Archiving stops outbound queueing without deleting history.';

-- Link an existing client. The artist comes from the stored conversation, and
-- the client must already be inside that artist's own scope, so an operator
-- who manages both artists still cannot attach one artist's client to the
-- other artist's conversation.
create or replace function public.link_communication_conversation_client(
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
  v_client public.clients%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;
  if p_client_id is null then
    raise exception 'a client id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_conversation.artist_id);
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');

  select cl.* into v_client
  from public.clients cl
  where cl.id = p_client_id
    and cl.archived_at is null;
  if not found then
    raise exception 'active client was not found' using errcode = '23503';
  end if;

  if not crm_private.client_in_artist_scope(p_client_id, v_conversation.artist_id) then
    raise exception 'that client is not in this artist scope' using errcode = '42501';
  end if;

  if v_conversation.client_id is not null and v_conversation.client_id <> p_client_id then
    raise exception 'this conversation is already linked to a different client'
      using errcode = '23514';
  end if;

  update public.communication_conversations c
  set client_id = p_client_id,
      link_state = 'linked'::public.communication_link_state,
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'communication.client_linked',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    p_client_id,
    v_conversation.enquiry_id,
    null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
      'conversation', v_conversation.id
    )
  );

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'client_id', p_client_id,
    'link_state', 'linked'
  );
end;
$$;

revoke all on function public.link_communication_conversation_client(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.link_communication_conversation_client(uuid, uuid)
  to authenticated;

comment on function public.link_communication_conversation_client(uuid, uuid) is
  'Operator action linking an unmatched conversation to an existing client in the same artist scope. Cross-artist linking is refused.';

-- Create a client from an unmatched conversation. Contact details are typed by
-- the operator, because a direct message carries no verified email or phone
-- and inventing one would corrupt client matching for every later enquiry.
create or replace function public.create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_instagram text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_full_name text;
  v_email text;
  v_phone text;
  v_instagram text;
  v_client_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_conversation.artist_id);
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');

  if v_conversation.client_id is not null then
    raise exception 'this conversation is already linked to a client'
      using errcode = '23514';
  end if;

  v_full_name := left(btrim(coalesce(p_full_name, '')), 160);
  if v_full_name = '' then
    raise exception 'a client name is required' using errcode = '22023';
  end if;

  v_email := left(nullif(btrim(coalesce(p_email, '')), ''), 320);
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address is not valid' using errcode = '22023';
  end if;

  v_phone := left(nullif(btrim(coalesce(p_phone, '')), ''), 80);
  v_instagram := left(nullif(btrim(coalesce(p_instagram, '')), ''), 80);

  -- The handle the provider reported is a better default than nothing, but it
  -- is only a default: the operator's own value always wins.
  if v_instagram is null
     and v_conversation.channel = 'instagram'::public.communication_channel
     and v_conversation.external_username is not null then
    v_instagram := '@' || v_conversation.external_username;
  end if;

  insert into public.clients (full_name, email, phone, instagram)
  values (v_full_name, v_email, v_phone, v_instagram)
  returning id into v_client_id;

  update public.communication_conversations c
  set client_id = v_client_id,
      link_state = 'linked'::public.communication_link_state,
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'communication.client_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_client_id,
    null, null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
      'conversation', v_conversation.id
    )
  );

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'client_id', v_client_id,
    'link_state', 'linked'
  );
end;
$$;

revoke all on function public.create_client_from_communication(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_client_from_communication(uuid, text, text, text, text)
  to authenticated;

comment on function public.create_client_from_communication(uuid, text, text, text, text) is
  'Operator action creating a client record from an unmatched conversation and linking it. Contact details are supplied by the operator, never inferred from the provider.';

-- Promote a real enquiry out of a conversation.
--
-- This reuses `create_manual_enquiry` rather than reimplementing the client
-- matching, reference numbering, idempotency and privacy rules that intake
-- already owns. The conversation supplies the artist, so a browser still
-- cannot choose which artist receives the enquiry.
create or replace function public.create_enquiry_from_communication(
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
  v_result jsonb;
  v_enquiry_id uuid;
  v_client_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_conversation.artist_id);
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');

  -- Intake re-checks the role, the artist and the privacy acknowledgement.
  v_result := public.create_manual_enquiry(
    p_idempotency_key,
    v_conversation.artist_id,
    p_client,
    p_enquiry,
    p_privacy_acknowledged
  );

  v_enquiry_id := (v_result ->> 'enquiry_id')::uuid;
  v_client_id := (v_result ->> 'client_id')::uuid;

  -- Intake matches clients on email and phone. If it resolved a different
  -- person from the one this conversation is already linked to, that is a
  -- genuine identity conflict and must be resolved by a human rather than
  -- silently repointing either record.
  if v_conversation.client_id is not null and v_conversation.client_id <> v_client_id then
    raise exception 'the enquiry details match a different client than this conversation'
      using errcode = '23514';
  end if;

  update public.enquiries e
  set communication_conversation_id = v_conversation.id,
      communication_channel = v_conversation.channel,
      created_from_communication = true
  where e.id = v_enquiry_id;

  update public.communication_conversations c
  set client_id = v_client_id,
      link_state = 'linked'::public.communication_link_state,
      enquiry_id = coalesce(c.enquiry_id, v_enquiry_id),
      updated_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'communication.enquiry_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_client_id,
    v_enquiry_id,
    null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
      'conversation', v_conversation.id
    )
  );

  return v_result
    || jsonb_build_object(
      'conversation_id', v_conversation.id,
      'channel', v_conversation.channel,
      'created_from_communication', true
    );
end;
$$;

revoke all on function public.create_enquiry_from_communication(uuid, uuid, jsonb, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_enquiry_from_communication(uuid, uuid, jsonb, jsonb, boolean)
  to authenticated;

comment on function public.create_enquiry_from_communication(uuid, uuid, jsonb, jsonb, boolean) is
  'Operator action promoting a conversation to a CRM enquiry through the existing manual intake rules. The artist comes from the conversation and the enquiry keeps typed channel provenance.';
