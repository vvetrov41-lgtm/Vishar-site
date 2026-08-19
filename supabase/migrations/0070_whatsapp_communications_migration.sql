-- 0070_whatsapp_communications_migration.sql
--
-- Move production WhatsApp into the provider-neutral core created in 0069 and
-- keep every existing caller working unchanged.
--
-- The transition is deliberately conservative:
--
--   * Rows keep their primary keys. An `integration_outbox` job that already
--     points at a WhatsApp message still points at the same uuid afterwards,
--     and a CRM deep link to a conversation still resolves.
--
--   * `public.whatsapp_conversations` and `public.whatsapp_messages` are
--     republished as `security_invoker` views with the same column names and
--     the same enum types. The deployed private CRM, the production GPT read
--     RPCs from migration 0054 and any other existing reader keep working
--     against the same relation names, under the same row level security.
--
--   * Every WhatsApp RPC keeps its exact name, argument list, return shape and
--     grant. The WhatsApp webhook Worker and the WhatsApp drain Worker that
--     are already deployed to production call these functions and must not
--     need a redeploy for this migration to be safe.
--
--   * Nothing is fabricated. Columns the old schema never recorded (an
--     explicit `sent_at`, an attachment list) stay null or empty rather than
--     being invented from an unrelated timestamp.
--
-- The neutral engine underneath is shared from here on: one claim, one lease,
-- one acknowledgement and one retry policy serve every channel, so Instagram
-- does not get a second, independently drifting copy of the queue.
--
-- Forward-only. No provider call, no credential, no cron change, no deployment
-- and no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. Copy conversations
-- ---------------------------------------------------------------------------

insert into public.communication_conversations (
  id, artist_id, channel, integration_key,
  external_contact_id, external_display_label,
  client_id, link_state,
  last_message_at, last_inbound_at,
  created_at, updated_at
)
select
  c.id,
  c.artist_id,
  'whatsapp'::public.communication_channel,
  c.integration_key,
  c.contact_wa_id,
  c.contact_label,
  c.client_id,
  case
    when c.client_id is not null then 'linked'::public.communication_link_state
    else 'unmatched'::public.communication_link_state
  end,
  c.last_message_at,
  c.last_inbound_at,
  c.created_at,
  c.updated_at
from public.whatsapp_conversations c
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Copy messages
--
-- `business_app` becomes the neutral `provider_app`. Every other label already
-- matches, and the compatibility view maps the value back for existing
-- readers.
-- ---------------------------------------------------------------------------

insert into public.communication_messages (
  id, conversation_id, artist_id, channel,
  direction, origin, status,
  message_type, body,
  provider_message_id, provider_timestamp,
  delivered_at, read_at, failed_at, error_code,
  created_by, created_at, updated_at
)
select
  m.id,
  m.conversation_id,
  m.artist_id,
  'whatsapp'::public.communication_channel,
  m.direction::text::public.communication_direction,
  case m.origin
    when 'business_app'::public.whatsapp_message_origin
      then 'provider_app'::public.communication_origin
    else m.origin::text::public.communication_origin
  end,
  m.status::text::public.communication_status,
  m.message_type,
  m.body,
  m.provider_message_id,
  m.provider_timestamp,
  m.delivered_at,
  m.read_at,
  m.failed_at,
  m.error_code,
  m.created_by,
  m.created_at,
  m.updated_at
from public.whatsapp_messages m
on conflict (id) do nothing;

-- Derive the outbound-only `last_outbound_at` from the copied history rather
-- than from a queue that may never have run.
update public.communication_conversations c
set last_outbound_at = latest.sent_at
from (
  select m.conversation_id, max(m.created_at) as sent_at
  from public.communication_messages m
  where m.direction = 'outbound'::public.communication_direction
  group by m.conversation_id
) as latest
where latest.conversation_id = c.id;

-- ---------------------------------------------------------------------------
-- 3. Repoint the durable queue
-- ---------------------------------------------------------------------------

update public.integration_outbox o
set communication_message_id = o.whatsapp_message_id
where o.whatsapp_message_id is not null
  and o.communication_message_id is null;

alter table public.integration_outbox
  drop constraint if exists integration_outbox_whatsapp_entity;
alter table public.integration_outbox
  drop constraint if exists integration_outbox_whatsapp_message_artist_fkey;
alter table public.integration_outbox
  drop column if exists whatsapp_message_id;

do $$ begin
  alter table public.integration_outbox
    add constraint integration_outbox_communication_message_artist_fkey
    foreign key (communication_message_id, artist_id)
    references public.communication_messages(id, artist_id)
    on delete restrict
    deferrable initially deferred;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.integration_outbox
    add constraint integration_outbox_communication_entity
    check (
      (
        kind in (
          'whatsapp_message'::public.outbox_kind,
          'instagram_message'::public.outbox_kind
        )
        and communication_message_id is not null
        and session_id is null
        and email_message_id is null
        and availability_block_id is null
      )
      or (
        kind not in (
          'whatsapp_message'::public.outbox_kind,
          'instagram_message'::public.outbox_kind
        )
        and communication_message_id is null
      )
    );
exception when duplicate_object then null; end $$;

create index if not exists integration_outbox_instagram_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind = 'instagram_message'
    and status in ('pending', 'failed', 'leased');

-- ---------------------------------------------------------------------------
-- 4. Retire the WhatsApp tables and republish them as compatibility views
-- ---------------------------------------------------------------------------

drop trigger if exists whatsapp_messages_set_updated_at on public.whatsapp_messages;
drop trigger if exists whatsapp_conversations_set_updated_at on public.whatsapp_conversations;

drop table if exists public.whatsapp_messages;
drop table if exists public.whatsapp_conversations;

create view public.whatsapp_conversations
with (security_invoker = true)
as
select
  c.id,
  c.artist_id,
  c.client_id,
  c.integration_key,
  c.external_contact_id as contact_wa_id,
  c.external_display_label as contact_label,
  c.last_message_at,
  c.last_inbound_at,
  c.created_at,
  c.updated_at
from public.communication_conversations c
where c.channel = 'whatsapp'::public.communication_channel;

comment on view public.whatsapp_conversations is
  'Compatibility projection of the WhatsApp channel over public.communication_conversations. security_invoker keeps the underlying artist-scoped row level security authoritative.';

create view public.whatsapp_messages
with (security_invoker = true)
as
select
  m.id,
  m.conversation_id,
  m.artist_id,
  m.direction::text::public.whatsapp_message_direction as direction,
  case m.origin
    when 'provider_app'::public.communication_origin
      then 'business_app'::public.whatsapp_message_origin
    else m.origin::text::public.whatsapp_message_origin
  end as origin,
  m.status::text::public.whatsapp_message_status as status,
  m.message_type,
  m.body,
  m.provider_message_id,
  m.provider_timestamp,
  m.delivered_at,
  m.read_at,
  m.failed_at,
  m.error_code,
  m.created_by,
  m.created_at,
  m.updated_at
from public.communication_messages m
where m.channel = 'whatsapp'::public.communication_channel;

comment on view public.whatsapp_messages is
  'Compatibility projection of the WhatsApp channel over public.communication_messages. security_invoker keeps the underlying artist-scoped row level security authoritative.';

-- The compatibility views are read-only by construction. `whatsapp_messages`
-- already is, because its origin mapping is an expression; `whatsapp_conversations`
-- would otherwise be simple enough for PostgreSQL to make auto-updatable, which
-- would open a second write path into the core that bypasses every RPC. These
-- triggers close it explicitly rather than relying on the absence of a grant.
create or replace function crm_private.reject_whatsapp_view_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'whatsapp compatibility views are read-only; use the communications RPCs'
    using errcode = '42501';
end;
$$;

revoke all on function crm_private.reject_whatsapp_view_write()
  from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_conversations_read_only on public.whatsapp_conversations;
create trigger whatsapp_conversations_read_only
  instead of insert or update or delete on public.whatsapp_conversations
  for each row execute function crm_private.reject_whatsapp_view_write();

drop trigger if exists whatsapp_messages_read_only on public.whatsapp_messages;
create trigger whatsapp_messages_read_only
  instead of insert or update or delete on public.whatsapp_messages
  for each row execute function crm_private.reject_whatsapp_view_write();

revoke all on public.whatsapp_conversations from public, anon, authenticated, service_role;
revoke all on public.whatsapp_messages from public, anon, authenticated, service_role;
grant select on public.whatsapp_conversations to authenticated;
grant select on public.whatsapp_messages to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Shared helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.communication_outbox_kind(
  p_channel public.communication_channel
)
returns public.outbox_kind
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_channel
    when 'whatsapp'::public.communication_channel
      then 'whatsapp_message'::public.outbox_kind
    when 'instagram'::public.communication_channel
      then 'instagram_message'::public.outbox_kind
  end;
$$;

revoke all on function crm_private.communication_outbox_kind(public.communication_channel)
  from public, anon, authenticated, service_role;

comment on function crm_private.communication_outbox_kind(public.communication_channel) is
  'Maps a communication channel to its durable outbox kind. Keeping one kind per channel preserves the existing resolve_outbox_route contract.';

create or replace function crm_private.communication_integration_type(
  p_channel public.communication_channel
)
returns public.artist_integration_type
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_channel
    when 'whatsapp'::public.communication_channel
      then 'whatsapp'::public.artist_integration_type
    when 'instagram'::public.communication_channel
      then 'instagram'::public.artist_integration_type
  end;
$$;

revoke all on function crm_private.communication_integration_type(public.communication_channel)
  from public, anon, authenticated, service_role;

-- Monotonic delivery-state application shared by every channel adapter.
--
-- A provider may resend a status, deliver two statuses out of order, or report
-- a status for a message this CRM never sent. None of those may move a message
-- backwards or resurrect a terminal state incorrectly.
create or replace function crm_private.apply_communication_status(
  p_message_id uuid,
  p_status public.communication_status,
  p_provider_timestamp timestamptz,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_message public.communication_messages%rowtype;
  v_current_rank integer;
  v_incoming_rank integer;
  v_new_status public.communication_status;
begin
  select m.* into v_message
  from public.communication_messages m
  where m.id = p_message_id
  for update;
  if not found then
    return jsonb_build_object('changed', false, 'status', null);
  end if;

  if v_message.direction <> 'outbound'::public.communication_direction then
    return jsonb_build_object('changed', false, 'status', v_message.status);
  end if;

  -- An older provider timestamp never wins over a newer recorded one.
  if v_message.provider_timestamp is not null
     and p_provider_timestamp < v_message.provider_timestamp then
    return jsonb_build_object('changed', false, 'status', v_message.status);
  end if;

  v_current_rank := case v_message.status
    when 'queued'::public.communication_status then 0
    when 'sent'::public.communication_status then 1
    when 'delivered'::public.communication_status then 2
    when 'read'::public.communication_status then 3
    else -1
  end;
  v_incoming_rank := case p_status
    when 'sent'::public.communication_status then 1
    when 'delivered'::public.communication_status then 2
    when 'read'::public.communication_status then 3
    else -1
  end;

  if p_status = 'failed'::public.communication_status then
    -- A provider cannot fail a message it has already delivered or shown.
    if v_message.status in (
      'delivered'::public.communication_status,
      'read'::public.communication_status
    ) then
      return jsonb_build_object('changed', false, 'status', v_message.status);
    end if;
    v_new_status := 'failed'::public.communication_status;
  else
    if v_message.status <> 'failed'::public.communication_status
       and v_current_rank >= v_incoming_rank then
      return jsonb_build_object('changed', false, 'status', v_message.status);
    end if;
    v_new_status := p_status;
  end if;

  update public.communication_messages m
  set status = v_new_status,
      provider_timestamp = p_provider_timestamp,
      sent_at = case
        when v_new_status in (
          'sent'::public.communication_status,
          'delivered'::public.communication_status,
          'read'::public.communication_status
        ) then coalesce(m.sent_at, p_provider_timestamp)
        else m.sent_at
      end,
      delivered_at = case
        when v_new_status in (
          'delivered'::public.communication_status,
          'read'::public.communication_status
        ) then coalesce(m.delivered_at, p_provider_timestamp)
        else m.delivered_at
      end,
      read_at = case
        when v_new_status = 'read'::public.communication_status
          then coalesce(m.read_at, p_provider_timestamp)
        else m.read_at
      end,
      failed_at = case
        when v_new_status = 'failed'::public.communication_status
          then p_provider_timestamp
        else null
      end,
      error_code = case
        when v_new_status = 'failed'::public.communication_status
          then coalesce(p_error_code, 'provider_failed')
        else null
      end,
      updated_at = now()
  where m.id = v_message.id;

  return jsonb_build_object(
    'message_id', v_message.id,
    'changed', true,
    'status', v_new_status
  );
end;
$$;

revoke all on function crm_private.apply_communication_status(
  uuid, public.communication_status, timestamptz, text
) from public, anon, authenticated, service_role;

comment on function crm_private.apply_communication_status(
  uuid, public.communication_status, timestamptz, text
) is
  'Shared monotonic delivery-state transition for every communication channel. Out-of-order and replayed provider statuses are safe no-ops.';

-- ---------------------------------------------------------------------------
-- 6. Provider routing
--
-- Replaces the 0047 definition, adding only the Instagram mapping. Every other
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
    when 'instagram_message' then 'instagram'::public.artist_integration_type
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
-- 7. Neutral outbound queue
-- ---------------------------------------------------------------------------

create or replace function public.queue_communication_message(
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
  v_body text;
  v_message_id uuid;
  v_outbox_id uuid;
  v_dedupe_key text;
  v_existing public.communication_messages%rowtype;
begin
  if p_conversation_id is null then
    raise exception 'a conversation id is required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'a request id is required' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = p_conversation_id;
  if not found then
    raise exception 'conversation was not found' using errcode = '23503';
  end if;

  -- Authorisation is resolved from the stored conversation, never from caller
  -- input: the caller names a conversation, and the artist, channel and
  -- destination all come from the row.
  perform crm_private.require_artist_access(v_conversation.artist_id, 'manage');
  perform crm_private.require_active_artist(v_conversation.artist_id);

  if v_conversation.state <> 'open'::public.communication_conversation_state then
    raise exception 'this conversation is archived' using errcode = '23514';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'a message body is required' using errcode = '22023';
  end if;
  if char_length(v_body) > 4096 then
    raise exception 'the message body is too long' using errcode = '22023';
  end if;

  -- The artist must have an enabled integration of their own for this exact
  -- channel and selector. There is deliberately no fallback to another
  -- artist's route.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_conversation.artist_id
      and i.integration_type = crm_private.communication_integration_type(v_conversation.channel)
      and i.integration_key = v_conversation.integration_key
      and i.is_enabled
  ) then
    raise exception 'this artist has no enabled integration for this channel'
      using errcode = '23503';
  end if;

  v_dedupe_key := v_conversation.channel::text || ':send:' || p_request_id::text;

  -- Idempotent retry: the same request id returns the original message.
  select m.* into v_existing
  from public.communication_messages m
  join public.integration_outbox o on o.communication_message_id = m.id
  where o.dedupe_key = v_dedupe_key;
  if found then
    return jsonb_build_object(
      'message_id', v_existing.id,
      'conversation_id', v_existing.conversation_id,
      'status', v_existing.status,
      'replayed', true
    );
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, created_by
  ) values (
    v_conversation.id,
    v_conversation.artist_id,
    v_conversation.channel,
    'outbound'::public.communication_direction,
    'crm'::public.communication_origin,
    'queued'::public.communication_status,
    'text',
    v_body,
    auth.uid()
  )
  returning id into v_message_id;

  -- The payload carries an identifier only. The body and the participant are
  -- read back by the trusted drain, never copied into the durable job.
  insert into public.integration_outbox (
    kind, dedupe_key, payload, artist_id, client_id, communication_message_id
  ) values (
    crm_private.communication_outbox_kind(v_conversation.channel),
    v_dedupe_key,
    jsonb_build_object('communication_message_id', v_message_id),
    v_conversation.artist_id,
    v_conversation.client_id,
    v_message_id
  )
  returning id into v_outbox_id;

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now()
  where c.id = v_conversation.id;

  -- The activity trail keeps a channel-specific event type. The Activity page
  -- and existing WhatsApp audit expectations already read `whatsapp.queued`,
  -- and a per-channel type stays filterable as more channels arrive.
  perform crm_private.log_artist_activity(
    v_conversation.artist_id,
    v_conversation.channel::text || '.queued',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_conversation.client_id,
    v_conversation.enquiry_id,
    null, null, null,
    jsonb_build_object(
      'channel', v_conversation.channel,
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

revoke all on function public.queue_communication_message(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_communication_message(uuid, text, uuid)
  to authenticated;

comment on function public.queue_communication_message(uuid, text, uuid) is
  'Artist-scoped CRM reply for any channel. The artist, channel, integration and destination all come from the stored conversation; the caller cannot select any of them.';

-- ---------------------------------------------------------------------------
-- 8. Neutral claim, lease and acknowledgement
-- ---------------------------------------------------------------------------

-- The claim projection returns the destination and body because a message
-- cannot be delivered without them. The validity predicate is factored out so
-- both claim entry points apply exactly the same rule, recomputed from the
-- authoritative conversation and message rows rather than trusted from the
-- queued job.
create or replace function crm_private.communication_job_valid(
  p_artist_id uuid,
  p_channel public.communication_channel,
  p_message public.communication_messages,
  p_conversation public.communication_conversations
)
returns boolean
language sql
stable
set search_path = pg_catalog, public, crm_private
as $$
  select
    p_message.id is not null
    and p_message.artist_id = p_artist_id
    and p_message.channel = p_channel
    and p_conversation.artist_id = p_artist_id
    and p_conversation.channel = p_channel
    and p_conversation.state = 'open'::public.communication_conversation_state
    and p_message.direction = 'outbound'::public.communication_direction
    and p_message.origin in (
      'crm'::public.communication_origin,
      'automation'::public.communication_origin
    )
    and p_message.status = 'queued'::public.communication_status
    and p_message.body is not null
    and btrim(p_message.body) <> ''
    and exists (
      select 1
      from public.artist_integrations i
      where i.artist_id = p_artist_id
        and i.integration_type = crm_private.communication_integration_type(p_channel)
        and i.integration_key = p_conversation.integration_key
        and i.is_enabled
    );
$$;

revoke all on function crm_private.communication_job_valid(
  uuid, public.communication_channel,
  public.communication_messages, public.communication_conversations
) from public, anon, authenticated, service_role;

create or replace function public.claim_communication_outbox(
  p_worker_id text,
  p_channel text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  channel public.communication_channel,
  communication_message_id uuid,
  conversation_id uuid,
  integration_key text,
  external_contact_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_lease_seconds integer;
  v_limit integer;
  v_channel public.communication_channel;
  v_kind public.outbox_kind;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication outbox claiming is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;

  v_channel := p_channel::public.communication_channel;
  v_kind := crm_private.communication_outbox_kind(v_channel);

  v_limit := coalesce(p_limit, 10);
  if v_limit < 1 or v_limit > 20 then
    raise exception 'the claim batch must be between 1 and 20' using errcode = '22023';
  end if;

  v_lease_seconds := coalesce(p_lease_seconds, 120);
  if v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'the lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r
      on r.kind = o.kind
    where o.kind = v_kind
      and o.created_at >= r.automatic_after
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id,
    l.artist_id,
    l.kind,
    v_channel,
    l.communication_message_id,
    m.conversation_id,
    conv.integration_key,
    conv.external_contact_id,
    m.body,
    l.attempt_count,
    l.max_attempts,
    crm_private.communication_job_valid(l.artist_id, v_channel, m, conv) as job_valid
  from leased l
  left join public.communication_messages m on m.id = l.communication_message_id
  left join public.communication_conversations conv on conv.id = m.conversation_id
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_communication_outbox(text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_communication_outbox(text, text, integer, integer)
  to service_role;

comment on function public.claim_communication_outbox(text, text, integer, integer) is
  'Backend-only bounded lease for due jobs on one channel. Returns the destination and body required to deliver, recomputed from authoritative rows, and no provider credential.';

create or replace function public.claim_communication_outbox_by_id(
  p_outbox_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  channel public.communication_channel,
  communication_message_id uuid,
  conversation_id uuid,
  integration_key text,
  external_contact_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_lease_seconds integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication outbox claiming is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  v_lease_seconds := coalesce(p_lease_seconds, 120);
  if v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'the lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select o.id
    from public.integration_outbox o
    where o.id = p_outbox_id
      and o.kind in (
        'whatsapp_message'::public.outbox_kind,
        'instagram_message'::public.outbox_kind
      )
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    for update of o skip locked
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidate c
    where o.id = c.id
    returning o.*
  )
  select
    l.id,
    l.artist_id,
    l.kind,
    conv.channel,
    l.communication_message_id,
    m.conversation_id,
    conv.integration_key,
    conv.external_contact_id,
    m.body,
    l.attempt_count,
    l.max_attempts,
    coalesce(
      crm_private.communication_job_valid(l.artist_id, conv.channel, m, conv),
      false
    ) as job_valid
  from leased l
  left join public.communication_messages m on m.id = l.communication_message_id
  left join public.communication_conversations conv on conv.id = m.conversation_id;
end;
$$;

revoke all on function public.claim_communication_outbox_by_id(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_communication_outbox_by_id(uuid, text, integer)
  to service_role;

comment on function public.claim_communication_outbox_by_id(uuid, text, integer) is
  'Backend-only atomic lease for one explicit due communication job. Returns no provider credential.';

create or replace function public.record_communication_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'an explicit result is required' using errcode = '22023';
  end if;
  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed communication result requires a safe machine error code'
      using errcode = '22023';
  end if;

  v_provider_message_id := nullif(btrim(coalesce(p_provider_message_id, '')), '');
  if p_succeeded and v_provider_message_id is null then
    raise exception 'a successful send must report a provider message id'
      using errcode = '22023';
  end if;
  if v_provider_message_id is not null
     and v_provider_message_id !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'the provider message id is not in the expected form'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in (
      'whatsapp_message'::public.outbox_kind,
      'instagram_message'::public.outbox_kind
    )
  for update;
  if not found then
    raise exception 'communication outbox job is unavailable' using errcode = '22023';
  end if;

  -- Idempotent replay of a successful acknowledgement. The lease fields were
  -- already cleared, so ownership is proved by the audit row this worker wrote.
  if v_job.status = 'succeeded'::public.outbox_status and p_succeeded then
    if not exists (
      select 1
      from public.activity_log a
      where a.outbox_id = p_outbox_id
        and a.event_type = 'outbox.succeeded'
        and a.metadata ->> 'worker_id' = p_worker_id
    ) then
      raise exception 'communication outbox lease is not owned by this worker'
        using errcode = '42501';
    end if;
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', v_job.status,
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased'::public.outbox_status
     or v_job.leased_by is distinct from p_worker_id then
    raise exception 'communication outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead'::public.outbox_status then o.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  -- The message row follows the job. A retryable failure leaves the message
  -- queued; only a terminal failure marks it failed in the CRM timeline.
  if p_succeeded then
    update public.communication_messages m
    set status = 'sent'::public.communication_status,
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        sent_at = coalesce(m.sent_at, now()),
        error_code = null,
        updated_at = now()
    where m.id = v_job.communication_message_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.communication_messages m
    set status = 'failed'::public.communication_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.communication_message_id;
  end if;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker',
    null,
    v_job.client_id,
    v_job.enquiry_id,
    v_job.project_id,
    v_job.session_id,
    null, null, null,
    p_outbox_id,
    jsonb_build_object(
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'lease_aware', true,
      'dead_letter', v_status = 'dead'::public.outbox_status
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true
  );
end;
$$;

revoke all on function public.record_communication_outbox_result(uuid, text, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_communication_outbox_result(uuid, text, boolean, text, text)
  to service_role;

comment on function public.record_communication_outbox_result(uuid, text, boolean, text, text) is
  'Backend-only lease-owned acknowledgement with bounded retry, dead-lettering and no participant or message content in the audit trail.';

-- ---------------------------------------------------------------------------
-- 9. Neutral inbound ingestion
--
-- The public webhook Workers authenticate the raw request first, resolve the
-- artist from the provider identity through a backend-owned mapping, then call
-- only these narrow RPCs. Nothing a webhook body carries can select the artist,
-- integration or destination through this surface.
-- ---------------------------------------------------------------------------

create or replace function public.record_communication_inbound_message(
  p_artist_id uuid,
  p_channel text,
  p_integration_key text,
  p_external_contact_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_message_type text,
  p_body text default null,
  p_attachments jsonb default '[]'::jsonb,
  p_provider_referral jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_channel public.communication_channel;
  v_conversation_id uuid;
  v_message_id uuid;
  v_existing public.communication_messages%rowtype;
  v_body text;
  v_attachments jsonb;
  v_referral jsonb;
  v_changed boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication ingestion is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;
  v_channel := p_channel::public.communication_channel;

  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;
  if p_provider_timestamp is null or p_provider_timestamp > now() + interval '5 minutes' then
    raise exception 'a valid provider timestamp is required' using errcode = '22023';
  end if;
  if coalesce(p_message_type, '') !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'a safe message type is required' using errcode = '22023';
  end if;

  -- Only a text message carries text. Every other provider message type is
  -- recorded by shape so the CRM timeline stays honest about what arrived
  -- without inventing a body for it.
  if p_message_type = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' or char_length(v_body) > 4096 then
      raise exception 'a valid text message body is required' using errcode = '22023';
    end if;
  else
    if p_body is not null then
      raise exception 'non-text webhook messages must not carry body text'
        using errcode = '22023';
    end if;
    v_body := null;
  end if;

  v_attachments := coalesce(p_attachments, '[]'::jsonb);
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 16 then
    raise exception 'attachment metadata is not in the expected form' using errcode = '22023';
  end if;

  v_referral := p_provider_referral;
  if v_referral is not null and jsonb_typeof(v_referral) <> 'object' then
    raise exception 'referral metadata is not in the expected form' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = crm_private.communication_integration_type(v_channel)
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist webhook route is unavailable'
      using errcode = '23503';
  end if;

  insert into public.communication_conversations (
    artist_id, channel, integration_key, external_contact_id,
    last_message_at, last_inbound_at, provider_referral
  ) values (
    p_artist_id,
    v_channel,
    p_integration_key,
    p_external_contact_id,
    p_provider_timestamp,
    p_provider_timestamp,
    v_referral
  )
  on conflict (artist_id, channel, external_contact_id) do update
  set integration_key = excluded.integration_key,
      last_message_at = greatest(
        coalesce(public.communication_conversations.last_message_at, '-infinity'::timestamptz),
        excluded.last_message_at
      ),
      last_inbound_at = greatest(
        coalesce(public.communication_conversations.last_inbound_at, '-infinity'::timestamptz),
        excluded.last_inbound_at
      ),
      -- First-touch attribution wins. A later referral never overwrites the
      -- one that actually opened the conversation.
      provider_referral = coalesce(
        public.communication_conversations.provider_referral,
        excluded.provider_referral
      ),
      updated_at = now()
  returning id into v_conversation_id;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, attachments, provider_message_id, provider_timestamp
  ) values (
    v_conversation_id,
    p_artist_id,
    v_channel,
    'inbound'::public.communication_direction,
    'contact'::public.communication_origin,
    'received'::public.communication_status,
    p_message_type,
    v_body,
    v_attachments,
    p_provider_message_id,
    p_provider_timestamp
  )
  on conflict (artist_id, channel, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    v_changed := true;
  else
    select m.* into v_existing
    from public.communication_messages m
    where m.artist_id = p_artist_id
      and m.channel = v_channel
      and m.provider_message_id = p_provider_message_id;

    if not found
       or v_existing.conversation_id <> v_conversation_id
       or v_existing.direction <> 'inbound'::public.communication_direction
       or v_existing.origin <> 'contact'::public.communication_origin then
      raise exception 'provider message id conflicts with an existing message'
        using errcode = '23514';
    end if;

    v_message_id := v_existing.id;
  end if;

  return jsonb_build_object(
    'message_id', v_message_id,
    'conversation_id', v_conversation_id,
    'changed', v_changed
  );
end;
$$;

revoke all on function public.record_communication_inbound_message(
  uuid, text, text, text, text, timestamptz, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_communication_inbound_message(
  uuid, text, text, text, text, timestamptz, text, text, jsonb, jsonb
) to service_role;

comment on function public.record_communication_inbound_message(
  uuid, text, text, text, text, timestamptz, text, text, jsonb, jsonb
) is
  'Backend-only idempotent ingestion of one authenticated inbound provider message after server-authoritative artist routing.';

-- ---------------------------------------------------------------------------
-- Provider delivery status
-- ---------------------------------------------------------------------------

create or replace function public.record_communication_message_status(
  p_artist_id uuid,
  p_channel text,
  p_integration_key text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_channel public.communication_channel;
  v_message_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication status ingestion is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;
  v_channel := p_channel::public.communication_channel;

  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'a valid provider message id is required' using errcode = '22023';
  end if;
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'unsupported delivery status' using errcode = '22023';
  end if;
  if p_provider_timestamp is null or p_provider_timestamp > now() + interval '5 minutes' then
    raise exception 'a valid provider timestamp is required' using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = crm_private.communication_integration_type(v_channel)
      and i.integration_key = p_integration_key
      and i.is_enabled
  ) then
    raise exception 'artist webhook route is unavailable'
      using errcode = '23503';
  end if;

  -- A status may legitimately race ahead of the send acknowledgement or refer
  -- to a message created outside this CRM. A missing row is a safe no-op so a
  -- valid provider webhook does not enter a retry storm.
  select m.id into v_message_id
  from public.communication_messages m
  where m.artist_id = p_artist_id
    and m.channel = v_channel
    and m.provider_message_id = p_provider_message_id;
  if not found then
    return jsonb_build_object('changed', false, 'status', null);
  end if;

  return crm_private.apply_communication_status(
    v_message_id,
    p_status::public.communication_status,
    p_provider_timestamp,
    case when p_status = 'failed' then 'provider_failed' else null end
  );
end;
$$;

revoke all on function public.record_communication_message_status(
  uuid, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_communication_message_status(
  uuid, text, text, text, text, timestamptz
) to service_role;

comment on function public.record_communication_message_status(
  uuid, text, text, text, text, timestamptz
) is
  'Backend-only monotonic application of an authenticated provider delivery status. Unknown provider message ids are safe no-ops.';

-- ---------------------------------------------------------------------------
-- 10. WhatsApp compatibility surface
--
-- Same names, same arguments, same return shapes, same grants. Only the
-- storage underneath changed, so the WhatsApp Workers already running in
-- production keep working without a redeploy.
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_inbound_message(
  p_artist_id uuid,
  p_integration_key text,
  p_contact_wa_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_message_type text,
  p_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp webhook ingestion is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_contact_wa_id, '') !~ '^[0-9]{6,20}$' then
    raise exception 'a valid WhatsApp contact id is required' using errcode = '22023';
  end if;

  return public.record_communication_inbound_message(
    p_artist_id,
    'whatsapp',
    p_integration_key,
    p_contact_wa_id,
    p_provider_message_id,
    p_provider_timestamp,
    p_message_type,
    p_body
  );
end;
$$;

revoke all on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) to service_role;

comment on function public.record_whatsapp_inbound_message(
  uuid, text, text, text, timestamptz, text, text
) is
  'Backend-only idempotent ingestion of one signed Meta inbound WhatsApp message. Compatibility wrapper over the neutral communications ingest.';

create or replace function public.record_whatsapp_message_status(
  p_artist_id uuid,
  p_integration_key text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp status ingestion is backend-only'
      using errcode = '42501';
  end if;

  return public.record_communication_message_status(
    p_artist_id,
    'whatsapp',
    p_integration_key,
    p_provider_message_id,
    p_status,
    p_provider_timestamp
  );
end;
$$;

revoke all on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) to service_role;

comment on function public.record_whatsapp_message_status(
  uuid, text, text, text, timestamptz
) is
  'Backend-only monotonic application of signed Meta sent/delivered/read/failed status notifications. Compatibility wrapper over the neutral communications status ingest.';

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
  v_channel public.communication_channel;
begin
  select c.channel into v_channel
  from public.communication_conversations c
  where c.id = p_conversation_id;
  if not found then
    raise exception 'whatsapp conversation was not found' using errcode = '23503';
  end if;
  if v_channel <> 'whatsapp'::public.communication_channel then
    raise exception 'whatsapp conversation was not found' using errcode = '23503';
  end if;

  return public.queue_communication_message(p_conversation_id, p_body, p_request_id);
end;
$$;

revoke all on function public.queue_whatsapp_message(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_whatsapp_message(uuid, text, uuid)
  to authenticated;

comment on function public.queue_whatsapp_message(uuid, text, uuid) is
  'Artist-scoped CRM WhatsApp send. Compatibility wrapper over the neutral communications queue; the caller still cannot select an artist, integration or phone number.';

create or replace function public.claim_whatsapp_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  whatsapp_message_id uuid,
  conversation_id uuid,
  integration_key text,
  contact_wa_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  -- Refuse before reaching the neutral claim so an unauthorised caller sees the
  -- same message this surface has always produced.
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox claiming is backend-only'
      using errcode = '42501';
  end if;

  return query
  select
    c.outbox_id,
    c.artist_id,
    c.kind,
    c.communication_message_id,
    c.conversation_id,
    c.integration_key,
    c.external_contact_id,
    c.body,
    c.attempt_count,
    c.max_attempts,
    c.job_valid
  from public.claim_communication_outbox(
    p_worker_id, 'whatsapp', p_limit, p_lease_seconds
  ) c;
end;
$$;

revoke all on function public.claim_whatsapp_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_whatsapp_outbox(text, integer, integer)
  to service_role;

comment on function public.claim_whatsapp_outbox(text, integer, integer) is
  'Backend-only bounded lease for due WhatsApp jobs. Compatibility projection of the neutral claim; column names are unchanged for the deployed drain Worker.';

create or replace function public.claim_whatsapp_outbox_by_id(
  p_outbox_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  whatsapp_message_id uuid,
  conversation_id uuid,
  integration_key text,
  contact_wa_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox claiming is backend-only'
      using errcode = '42501';
  end if;

  return query
  select
    c.outbox_id,
    c.artist_id,
    c.kind,
    c.communication_message_id,
    c.conversation_id,
    c.integration_key,
    c.external_contact_id,
    c.body,
    c.attempt_count,
    c.max_attempts,
    -- A job on another channel is never a valid WhatsApp job.
    (c.job_valid and c.kind = 'whatsapp_message'::public.outbox_kind) as job_valid
  from public.claim_communication_outbox_by_id(
    p_outbox_id, p_worker_id, p_lease_seconds
  ) c;
end;
$$;

revoke all on function public.claim_whatsapp_outbox_by_id(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_whatsapp_outbox_by_id(uuid, text, integer)
  to service_role;

comment on function public.claim_whatsapp_outbox_by_id(uuid, text, integer) is
  'Backend-only atomic lease for one explicit due WhatsApp job. Compatibility projection of the neutral claim.';

create or replace function public.record_whatsapp_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.integration_outbox o
    where o.id = p_outbox_id
      and o.kind = 'whatsapp_message'::public.outbox_kind
  ) then
    raise exception 'WhatsApp outbox job is unavailable' using errcode = '22023';
  end if;

  return public.record_communication_outbox_result(
    p_outbox_id, p_worker_id, p_succeeded, p_provider_message_id, p_error_code
  );
end;
$$;

revoke all on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text)
  to service_role;

comment on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text) is
  'Backend-only lease-owned WhatsApp acknowledgement. Compatibility wrapper over the neutral communications acknowledgement.';

create or replace function public.ensure_whatsapp_conversation_for_enquiry(
  p_enquiry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_client public.clients%rowtype;
  v_phone_normalized text;
  v_contact_wa_id text;
  v_integration_key text;
  v_integration_count integer;
  v_existing public.communication_conversations%rowtype;
  v_conversation_id uuid;
  v_created boolean := false;
begin
  if p_enquiry_id is null then
    raise exception 'an enquiry id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');

  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry was not found' using errcode = '23503';
  end if;

  perform crm_private.require_active_artist(v_enquiry.artist_id);
  perform crm_private.require_artist_access(v_enquiry.artist_id, 'manage');

  if v_enquiry.client_id is null then
    raise exception 'enquiry is not linked to a client' using errcode = '23503';
  end if;
  if v_enquiry.client_identifier_conflict then
    raise exception 'client identifier conflict must be resolved before WhatsApp messaging'
      using errcode = '23514';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_enquiry.client_id
    and c.archived_at is null;
  if not found then
    raise exception 'active client was not found' using errcode = '23503';
  end if;

  -- Reuse the repository's deliberately conservative normaliser. Local-format
  -- numbers fail closed instead of guessing a country code.
  v_phone_normalized := public.normalize_phone(v_client.phone);
  if v_phone_normalized is null then
    raise exception 'client phone must already be an international number for WhatsApp messaging'
      using errcode = '22023';
  end if;
  v_contact_wa_id := substr(v_phone_normalized, 2);

  select count(*), min(i.integration_key)
  into v_integration_count, v_integration_key
  from public.artist_integrations i
  where i.artist_id = v_enquiry.artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.is_enabled;

  if v_integration_count <> 1 or v_integration_key is null then
    raise exception 'artist must have exactly one enabled Meta WhatsApp integration'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_enquiry.artist_id::text || ':whatsapp:' || v_contact_wa_id, 0)
  );

  select c.* into v_existing
  from public.communication_conversations c
  where c.artist_id = v_enquiry.artist_id
    and c.channel = 'whatsapp'::public.communication_channel
    and c.external_contact_id = v_contact_wa_id
  for update;

  if found then
    if v_existing.client_id is not null and v_existing.client_id <> v_enquiry.client_id then
      raise exception 'WhatsApp destination is already linked to a different client in this artist scope'
        using errcode = '23514';
    end if;

    update public.communication_conversations c
    set client_id = coalesce(c.client_id, v_enquiry.client_id),
        link_state = 'linked'::public.communication_link_state,
        enquiry_id = coalesce(c.enquiry_id, v_enquiry.id),
        integration_key = v_integration_key,
        updated_at = now()
    where c.id = v_existing.id
    returning c.id into v_conversation_id;
  else
    insert into public.communication_conversations (
      artist_id, channel, client_id, enquiry_id, link_state,
      integration_key, external_contact_id
    ) values (
      v_enquiry.artist_id,
      'whatsapp'::public.communication_channel,
      v_enquiry.client_id,
      v_enquiry.id,
      'linked'::public.communication_link_state,
      v_integration_key,
      v_contact_wa_id
    )
    returning id into v_conversation_id;
    v_created := true;
  end if;

  if v_created then
    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'whatsapp.conversation_created',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      v_enquiry.client_id,
      v_enquiry.id,
      null, null, null,
      jsonb_build_object(
        'conversation', v_conversation_id,
        'integration', v_integration_key
      )
    );
  end if;

  return jsonb_build_object(
    'conversation_id', v_conversation_id,
    'artist_id', v_enquiry.artist_id,
    'client_id', v_enquiry.client_id,
    'contact_wa_id', v_contact_wa_id,
    'integration_key', v_integration_key,
    'created', v_created
  );
end;
$$;

revoke all on function public.ensure_whatsapp_conversation_for_enquiry(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_whatsapp_conversation_for_enquiry(uuid)
  to authenticated;

comment on function public.ensure_whatsapp_conversation_for_enquiry(uuid) is
  'Artist-scoped CRM WhatsApp conversation opener over the neutral communications core. Caller supplies only enquiry id.';
