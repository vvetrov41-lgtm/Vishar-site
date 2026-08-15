-- 0047_whatsapp_conversations.sql
--
-- Durable WhatsApp Business Platform conversations and messages for the two
-- artist-scoped integrations reserved in migration 0046.
--
-- Design notes that are load-bearing:
--
--   * Routing is server-authoritative. A conversation belongs to exactly one
--     artist, and `resolve_outbox_route` is extended so a `whatsapp_message`
--     job resolves the artist's own enabled WhatsApp integration. There is no
--     global WhatsApp route and no cross-artist fallback: a missing Vladimir
--     binding fails closed rather than borrowing Kristina's.
--
--   * No credential is stored here. `integration_key` is the same non-secret
--     server selector used by Telegram and Calendar. The Meta access token,
--     app secret, phone number id and WABA id live only in encrypted
--     Cloudflare Worker configuration.
--
--   * Unlike the Telegram claim, the WhatsApp claim projection does return the
--     message body and the contact's WhatsApp id. That is unavoidable: the
--     trusted backend cannot deliver a message to Meta without them. The
--     boundary is preserved elsewhere instead — the outbox payload carries only
--     an identifier, the activity trail records no contact or body, and the
--     Worker logger allow-list still refuses both.
--
--   * `origin` exists for Meta coexistence. A message the artist typed in the
--     WhatsApp Business App arrives later as an `smb_message_echoes` webhook,
--     and must be attributable in the CRM as an app-sent message rather than a
--     CRM-sent one. `provider_message_id` is unique per artist so an echo of a
--     message the CRM itself sent collides with the original row instead of
--     duplicating it.
--
-- Forward-only. No provider call, no credential, no cron change, no
-- deployment, and no enqueued work.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.whatsapp_message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

-- `contact` is an inbound message from the WhatsApp user. `crm` is an outbound
-- message this CRM queued. `business_app` is an outbound message the artist
-- sent by hand from the WhatsApp Business App, learned through coexistence
-- echoes. `automation` is reserved for a later CRM/GPT-initiated send so that
-- automated traffic stays distinguishable from a human reply.
do $$ begin
  create type public.whatsapp_message_origin as enum (
    'contact', 'crm', 'business_app', 'automation'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.whatsapp_message_status as enum (
    'received', 'queued', 'sent', 'delivered', 'read', 'failed'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_conversations (
  id                uuid primary key default gen_random_uuid(),
  artist_id         uuid not null references public.artists(id) on delete restrict,
  client_id         uuid references public.clients(id) on delete restrict,
  integration_key   text not null,
  contact_wa_id     text not null,
  contact_label     text,
  last_message_at   timestamptz,
  last_inbound_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint whatsapp_conversations_artist_contact_key
    unique (artist_id, contact_wa_id),
  constraint whatsapp_conversations_key_shape
    check (integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  -- Meta reports the WhatsApp user id as digits without a leading plus.
  constraint whatsapp_conversations_contact_shape
    check (contact_wa_id ~ '^[0-9]{6,20}$'),
  constraint whatsapp_conversations_label_length
    check (
      contact_label is null
      or (btrim(contact_label) <> '' and char_length(contact_label) <= 160)
    )
);

comment on table public.whatsapp_conversations is
  'Artist-scoped WhatsApp conversation with one WhatsApp user. Holds no provider credential; integration_key selects the encrypted server-side binding.';
comment on column public.whatsapp_conversations.integration_key is
  'Non-secret server configuration selector. The Meta token, app secret and phone number id live only in encrypted Cloudflare configuration.';
comment on column public.whatsapp_conversations.contact_wa_id is
  'The WhatsApp user identifier reported by Meta. CRM contact data, never written to logs, outbox payloads or the activity trail.';

create unique index if not exists whatsapp_conversations_id_artist_key
  on public.whatsapp_conversations (id, artist_id);

create index if not exists whatsapp_conversations_artist_recent_idx
  on public.whatsapp_conversations (artist_id, last_message_at desc nulls last);

create index if not exists whatsapp_conversations_client_idx
  on public.whatsapp_conversations (client_id)
  where client_id is not null;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_messages (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null,
  artist_id            uuid not null references public.artists(id) on delete restrict,
  direction            public.whatsapp_message_direction not null,
  origin               public.whatsapp_message_origin not null,
  status               public.whatsapp_message_status not null,
  message_type         text not null default 'text',
  body                 text,
  provider_message_id  text,
  provider_timestamp   timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  error_code           text,
  created_by           uuid references public.profiles(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint whatsapp_messages_conversation_artist_fkey
    foreign key (conversation_id, artist_id)
    references public.whatsapp_conversations(id, artist_id)
    on delete restrict,

  -- One provider message maps to at most one stored row per artist. This is the
  -- deduplication boundary for repeated webhook deliveries and for a
  -- coexistence echo of a message the CRM itself sent.
  constraint whatsapp_messages_provider_id_key
    unique (artist_id, provider_message_id),

  constraint whatsapp_messages_type_shape
    check (message_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint whatsapp_messages_body_length
    check (body is null or char_length(body) <= 4096),
  constraint whatsapp_messages_provider_id_shape
    check (provider_message_id is null or provider_message_id ~ '^[A-Za-z0-9_=./-]{8,255}$'),
  constraint whatsapp_messages_error_code_shape
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),

  -- An inbound message is always from the contact and is never queued.
  constraint whatsapp_messages_direction_origin
    check (
      (direction = 'inbound' and origin = 'contact')
      or (direction = 'outbound' and origin <> 'contact')
    ),
  constraint whatsapp_messages_direction_status
    check (
      (direction = 'inbound' and status = 'received')
      or (direction = 'outbound' and status <> 'received')
    ),
  -- Only a CRM-queued message may sit in `queued`; an app-sent message is
  -- already gone by the time coexistence tells us about it.
  constraint whatsapp_messages_queued_origin
    check (status <> 'queued' or origin in ('crm', 'automation')),
  constraint whatsapp_messages_failed_requires_code
    check (status <> 'failed' or error_code is not null)
);

comment on table public.whatsapp_messages is
  'Artist-scoped WhatsApp message history. Holds no provider credential. origin distinguishes CRM sends from WhatsApp Business App sends learned through Meta coexistence echoes.';
comment on column public.whatsapp_messages.provider_message_id is
  'The Meta message identifier (wamid). Unique per artist so a coexistence echo collides with the CRM row instead of duplicating it.';
comment on column public.whatsapp_messages.origin is
  'contact = inbound; crm = queued in this CRM; business_app = sent by hand from the WhatsApp Business App; automation = reserved for later CRM automation.';

create unique index if not exists whatsapp_messages_id_artist_key
  on public.whatsapp_messages (id, artist_id);

create index if not exists whatsapp_messages_conversation_idx
  on public.whatsapp_messages (conversation_id, created_at desc, id);

create index if not exists whatsapp_messages_artist_idx
  on public.whatsapp_messages (artist_id, created_at desc);

drop trigger if exists whatsapp_conversations_set_updated_at
  on public.whatsapp_conversations;
create trigger whatsapp_conversations_set_updated_at
  before update on public.whatsapp_conversations
  for each row execute function public.set_updated_at();

drop trigger if exists whatsapp_messages_set_updated_at
  on public.whatsapp_messages;
create trigger whatsapp_messages_set_updated_at
  before update on public.whatsapp_messages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Outbox link
--
-- Mirrors the availability link added in migration 0041: a dedicated nullable
-- column, a composite foreign key proving the message belongs to the same
-- artist as the job, and a kind-scoped check so only WhatsApp jobs carry it.
-- ---------------------------------------------------------------------------

alter table public.integration_outbox
  add column if not exists whatsapp_message_id uuid;

do $$ begin
  alter table public.integration_outbox
    add constraint integration_outbox_whatsapp_message_artist_fkey
    foreign key (whatsapp_message_id, artist_id)
    references public.whatsapp_messages(id, artist_id)
    on delete restrict
    deferrable initially deferred;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.integration_outbox
    add constraint integration_outbox_whatsapp_entity
    check (
      (
        kind = 'whatsapp_message'
        and whatsapp_message_id is not null
        and session_id is null
        and email_message_id is null
        and availability_block_id is null
      )
      or (
        kind <> 'whatsapp_message'
        and whatsapp_message_id is null
      )
    );
exception when duplicate_object then null; end $$;

create index if not exists integration_outbox_whatsapp_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind = 'whatsapp_message'
    and status in ('pending', 'failed', 'leased');

-- Automatic draining only ever considers jobs created after this migration, so
-- enabling the drain later cannot replay historical rows.
insert into crm_private.outbox_drain_rollouts (
  kind,
  automatic_after,
  created_at
)
select
  'whatsapp_message'::public.outbox_kind,
  statement_timestamp(),
  statement_timestamp()
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_conversations force row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_messages force row level security;

revoke all on public.whatsapp_conversations
  from public, anon, authenticated, service_role;
revoke all on public.whatsapp_messages
  from public, anon, authenticated, service_role;

-- Reads only. Every write goes through a named SECURITY DEFINER RPC.
grant select on public.whatsapp_conversations to authenticated;
grant select on public.whatsapp_messages to authenticated;

drop policy if exists whatsapp_conversations_select_artist_scope
  on public.whatsapp_conversations;
create policy whatsapp_conversations_select_artist_scope
  on public.whatsapp_conversations
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists whatsapp_conversations_insert_artist_scope
  on public.whatsapp_conversations;
create policy whatsapp_conversations_insert_artist_scope
  on public.whatsapp_conversations
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists whatsapp_conversations_update_artist_scope
  on public.whatsapp_conversations;
create policy whatsapp_conversations_update_artist_scope
  on public.whatsapp_conversations
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists whatsapp_messages_select_artist_scope
  on public.whatsapp_messages;
create policy whatsapp_messages_select_artist_scope
  on public.whatsapp_messages
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists whatsapp_messages_insert_artist_scope
  on public.whatsapp_messages;
create policy whatsapp_messages_insert_artist_scope
  on public.whatsapp_messages
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists whatsapp_messages_update_backend
  on public.whatsapp_messages;
create policy whatsapp_messages_update_backend
  on public.whatsapp_messages
  for update
  using (crm_private.is_service_backend())
  with check (crm_private.is_service_backend());

-- ---------------------------------------------------------------------------
-- Provider routing
--
-- Replaces the 0041 definition, adding only the WhatsApp mapping. Every other
-- branch, the backend-only gate and the returned columns are unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_outbox_route(p_outbox_id uuid)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  integration_type public.artist_integration_type,
  provider text,
  integration_key text,
  external_account_label text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_kind public.outbox_kind;
  v_integration_type public.artist_integration_type;
begin
  if not crm_private.is_service_backend() then
    raise exception 'outbox route resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'outbox id is required' using errcode = '22023';
  end if;

  select o.artist_id, o.kind into v_artist_id, v_kind
  from public.integration_outbox o
  where o.id = p_outbox_id;
  if not found then
    raise exception 'outbox route is unavailable' using errcode = '22023';
  end if;

  v_integration_type := case v_kind
    when 'telegram_notification' then 'telegram'::public.artist_integration_type
    when 'transactional_email' then 'email'::public.artist_integration_type
    when 'approved_email' then 'email'::public.artist_integration_type
    when 'calendar_create' then 'calendar'::public.artist_integration_type
    when 'calendar_update' then 'calendar'::public.artist_integration_type
    when 'calendar_cancel' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_create' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_update' then 'calendar'::public.artist_integration_type
    when 'calendar_availability_cancel' then 'calendar'::public.artist_integration_type
    when 'whatsapp_message' then 'whatsapp'::public.artist_integration_type
    else null
  end;
  if v_integration_type is null then
    raise exception 'outbox kind has no provider route' using errcode = '22023';
  end if;

  return query
  select o.id, o.artist_id, o.kind, v_integration_type,
         i.provider, i.integration_key, i.external_account_label, i.configuration
  from public.integration_outbox o
  join public.artist_integrations i
    on i.artist_id = o.artist_id
   and i.integration_type = v_integration_type
   and i.is_enabled
  join crm_private.artist_state a
    on a.artist_id = o.artist_id and a.is_active
  where o.id = p_outbox_id;

  if not found then
    raise exception 'artist provider route is unavailable' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_outbox_route(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_outbox_route(uuid) to service_role;

comment on function public.resolve_outbox_route(uuid) is
  'Backend-only safe metadata for one artist-scoped outbox row. Returns no payload, client data or credentials.';

-- ---------------------------------------------------------------------------
-- Queue an outbound WhatsApp message from the CRM
-- ---------------------------------------------------------------------------

create or replace function public.queue_whatsapp_message(
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
  v_conversation public.whatsapp_conversations%rowtype;
  v_body text;
  v_message_id uuid;
  v_outbox_id uuid;
  v_dedupe_key text;
  v_existing public.whatsapp_messages%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'a request id is required' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.whatsapp_conversations c
  where c.id = p_conversation_id;
  if not found then
    raise exception 'whatsapp conversation was not found' using errcode = '23503';
  end if;

  -- Authorisation is resolved from the stored conversation, never from caller
  -- input: the caller names a conversation, and the artist comes from the row.
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');
  perform crm_private.require_active_artist(v_conversation.artist_id);

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'a message body is required' using errcode = '22023';
  end if;
  if char_length(v_body) > 4096 then
    raise exception 'the message body is too long' using errcode = '22023';
  end if;

  -- The artist must have an enabled WhatsApp integration of their own. There is
  -- deliberately no fallback to another artist's route.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_conversation.artist_id
      and i.integration_type = 'whatsapp'::public.artist_integration_type
      and i.integration_key = v_conversation.integration_key
      and i.is_enabled
  ) then
    raise exception 'this artist has no enabled WhatsApp integration'
      using errcode = '23503';
  end if;

  v_dedupe_key := 'whatsapp:send:' || p_request_id::text;

  -- Idempotent retry: the same request id returns the original message.
  select m.* into v_existing
  from public.whatsapp_messages m
  join public.integration_outbox o on o.whatsapp_message_id = m.id
  where o.dedupe_key = v_dedupe_key;
  if found then
    return jsonb_build_object(
      'message_id', v_existing.id,
      'conversation_id', v_existing.conversation_id,
      'status', v_existing.status,
      'replayed', true
    );
  end if;

  insert into public.whatsapp_messages (
    conversation_id, artist_id, direction, origin, status,
    message_type, body, created_by
  ) values (
    v_conversation.id,
    v_conversation.artist_id,
    'outbound'::public.whatsapp_message_direction,
    'crm'::public.whatsapp_message_origin,
    'queued'::public.whatsapp_message_status,
    'text',
    v_body,
    auth.uid()
  )
  returning id into v_message_id;

  -- The payload carries an identifier only. The body and the contact are read
  -- back by the trusted drain, never copied into the durable job.
  insert into public.integration_outbox (
    kind, dedupe_key, payload, artist_id, client_id, whatsapp_message_id
  ) values (
    'whatsapp_message'::public.outbox_kind,
    v_dedupe_key,
    jsonb_build_object('whatsapp_message_id', v_message_id),
    v_conversation.artist_id,
    v_conversation.client_id,
    v_message_id
  )
  returning id into v_outbox_id;

  update public.whatsapp_conversations c
  set last_message_at = now()
  where c.id = v_conversation.id;

  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    'whatsapp.queued',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_conversation.client_id,
    null, null, null, null,
    jsonb_build_object(
      'integration', v_conversation.integration_key,
      'conversation', v_conversation.id,
      'outbox', v_outbox_id
    )
  );

  return jsonb_build_object(
    'message_id', v_message_id,
    'conversation_id', v_conversation.id,
    'status', 'queued',
    'replayed', false
  );
end;
$$;

revoke all on function public.queue_whatsapp_message(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_whatsapp_message(uuid, text, uuid)
  to authenticated;

comment on function public.queue_whatsapp_message(uuid, text, uuid) is
  'Artist-scoped CRM WhatsApp send. The artist and destination come from the stored conversation; the caller cannot select an artist, integration or phone number.';
