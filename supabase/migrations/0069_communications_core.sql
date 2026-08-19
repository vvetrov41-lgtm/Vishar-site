-- 0069_communications_core.sql
--
-- Provider-neutral communications domain.
--
-- Until now WhatsApp owned its own conversation, message and outbox-link
-- shape. Adding Instagram beside it as a second private copy would have
-- duplicated the artist-routing, idempotency, delivery-state and CRM-linking
-- rules that are the hard part of messaging, and would have produced two
-- independently drifting security surfaces.
--
-- This migration introduces the shared core instead:
--
--   communication_conversations   one artist, one channel, one external party
--     -> communication_messages   normalised inbound/outbound history
--        -> integration_outbox    the existing durable queue, unchanged
--
-- Nothing is migrated here and no existing object is dropped. Migration 0070
-- moves the WhatsApp rows across, repoints the outbox link and republishes the
-- WhatsApp tables as compatibility views. Splitting the two keeps this file
-- reviewable as pure addition.
--
-- Load-bearing design notes:
--
--   * Identity is channel-neutral. WhatsApp's `contact_wa_id` (a phone number)
--     is not a usable domain identity for Instagram, whose participants are
--     Instagram-scoped ids with no phone number at all. `external_contact_id`
--     is the provider's opaque participant id for the channel, and the human
--     labels beside it are provider metadata, never an identity.
--
--   * `body` is nullable and carries no default. An Instagram share, story
--     reply, reaction or unsupported message legitimately has no text, and a
--     `not null` body would have forced either a fabricated placeholder or a
--     second table later.
--
--   * Attachments are recorded as shape, not content. Meta serves Instagram
--     media from short-lived signed CDN URLs; storing those URLs durably would
--     put an expiring credential-like value into a browser-readable table for
--     no lasting benefit. `attachments` therefore holds only the ordered
--     attachment types, and `media_state` reserves the future ingestion
--     lifecycle without blocking it.
--
--   * Provider referral/ad attribution is a distinct column written only by
--     the trusted backend. The browser has no write path to it at all, so
--     campaign attribution cannot be forged from the CRM.
--
-- Forward-only. No provider call, no credential, no cron change, no deployment
-- and no enqueued work.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.communication_channel as enum ('whatsapp', 'instagram');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.communication_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

-- `contact` is a message from the external party. `crm` is a message this CRM
-- queued. `provider_app` is a message the artist sent by hand from the
-- provider's own app, learned through an echo notification. `automation` is
-- reserved for a later CRM/agent-initiated send so automated traffic stays
-- distinguishable from a human reply.
do $$ begin
  create type public.communication_origin as enum (
    'contact', 'crm', 'provider_app', 'automation'
  );
exception when duplicate_object then null; end $$;

-- Not every provider reports every state. WhatsApp reports sent/delivered/read
-- per message; Instagram reports a read watermark and no delivery receipt. The
-- enum is the union, and each adapter only ever applies the states its
-- provider actually documents.
do $$ begin
  create type public.communication_status as enum (
    'received', 'queued', 'sent', 'delivered', 'read', 'failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.communication_link_state as enum ('unmatched', 'linked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.communication_conversation_state as enum ('open', 'archived');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table if not exists public.communication_conversations (
  id                      uuid primary key default gen_random_uuid(),
  artist_id               uuid not null references public.artists(id) on delete restrict,
  channel                 public.communication_channel not null,
  integration_key         text not null,

  -- The provider's participant identifier for the external party. WhatsApp
  -- reports digits without a leading plus; Instagram reports an
  -- Instagram-scoped id. Both are contact data and neither is a credential.
  external_contact_id     text not null,
  external_username       text,
  external_display_label  text,

  client_id               uuid references public.clients(id) on delete restrict,
  enquiry_id              uuid references public.enquiries(id) on delete restrict,
  link_state              public.communication_link_state not null default 'unmatched',
  state                   public.communication_conversation_state not null default 'open',

  last_message_at         timestamptz,
  last_inbound_at         timestamptz,
  last_outbound_at        timestamptz,
  operator_read_at        timestamptz,

  -- Provider-supplied referral/ad context, written only by the trusted webhook
  -- ingestion path. No authenticated CRM caller can write this column.
  provider_referral       jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint communication_conversations_artist_channel_contact_key
    unique (artist_id, channel, external_contact_id),

  constraint communication_conversations_key_shape
    check (integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'),

  -- Channel-aware participant shape. WhatsApp ids are the digits Meta reports
  -- for a phone number; Instagram-scoped ids are numeric but are deliberately
  -- allowed a wider length because Meta does not publish a fixed width.
  constraint communication_conversations_contact_shape
    check (
      case channel
        when 'whatsapp' then external_contact_id ~ '^[0-9]{6,20}$'
        when 'instagram' then external_contact_id ~ '^[0-9]{5,40}$'
        else false
      end
    ),

  constraint communication_conversations_username_shape
    check (
      external_username is null
      or (btrim(external_username) <> '' and char_length(external_username) <= 80)
    ),
  constraint communication_conversations_label_length
    check (
      external_display_label is null
      or (btrim(external_display_label) <> '' and char_length(external_display_label) <= 160)
    ),

  -- A linked conversation always names a client, and an unmatched one never
  -- does. The link state cannot drift away from the foreign key.
  constraint communication_conversations_link_state_consistent
    check (
      (link_state = 'linked' and client_id is not null)
      or (link_state = 'unmatched' and client_id is null)
    ),
  -- An enquiry link only exists on top of a client link.
  constraint communication_conversations_enquiry_requires_client
    check (enquiry_id is null or client_id is not null),

  constraint communication_conversations_referral_object
    check (provider_referral is null or jsonb_typeof(provider_referral) = 'object'),
  constraint communication_conversations_referral_size
    check (provider_referral is null or pg_column_size(provider_referral) <= 2048)
);

comment on table public.communication_conversations is
  'Artist-scoped, channel-neutral conversation with one external party. Holds no provider credential; integration_key selects the encrypted server-side binding.';
comment on column public.communication_conversations.integration_key is
  'Non-secret server configuration selector. Provider tokens, app secrets and account ids live only in encrypted Cloudflare configuration or the connector token store.';
comment on column public.communication_conversations.external_contact_id is
  'Provider participant identifier (WhatsApp wa_id, Instagram-scoped id). CRM contact data, never written to logs, outbox payloads or the activity trail.';
comment on column public.communication_conversations.provider_referral is
  'Provider-supplied referral/ad attribution. Written only by the trusted webhook ingestion path so browser callers cannot forge campaign attribution.';

create unique index if not exists communication_conversations_id_artist_key
  on public.communication_conversations (id, artist_id);

create index if not exists communication_conversations_artist_recent_idx
  on public.communication_conversations (artist_id, last_message_at desc nulls last, id);

create index if not exists communication_conversations_artist_channel_recent_idx
  on public.communication_conversations (artist_id, channel, last_message_at desc nulls last, id);

create index if not exists communication_conversations_client_idx
  on public.communication_conversations (client_id)
  where client_id is not null;

create index if not exists communication_conversations_unmatched_idx
  on public.communication_conversations (artist_id, last_message_at desc nulls last)
  where link_state = 'unmatched';

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table if not exists public.communication_messages (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null,
  artist_id            uuid not null references public.artists(id) on delete restrict,
  channel              public.communication_channel not null,
  direction            public.communication_direction not null,
  origin               public.communication_origin not null,
  status               public.communication_status not null,

  message_type         text not null default 'text',
  body                 text,

  -- Ordered attachment shape only. See the header note: provider media URLs
  -- expire and are deliberately not stored.
  attachments          jsonb not null default '[]'::jsonb,
  media_state          text not null default 'not_ingested',

  provider_message_id  text,
  provider_timestamp   timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  error_code           text,

  created_by           uuid references public.profiles(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint communication_messages_conversation_artist_fkey
    foreign key (conversation_id, artist_id)
    references public.communication_conversations(id, artist_id)
    on delete restrict,

  -- One provider message maps to at most one stored row per artist and
  -- channel. This is the deduplication boundary for repeated webhook
  -- deliveries and for a provider echo of a message the CRM itself sent.
  constraint communication_messages_provider_id_key
    unique (artist_id, channel, provider_message_id),

  constraint communication_messages_type_shape
    check (message_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint communication_messages_body_length
    check (body is null or char_length(body) <= 4096),
  constraint communication_messages_provider_id_shape
    check (provider_message_id is null or provider_message_id ~ '^[A-Za-z0-9_=./-]{8,255}$'),
  constraint communication_messages_error_code_shape
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),

  constraint communication_messages_attachments_array
    check (jsonb_typeof(attachments) = 'array'),
  constraint communication_messages_attachments_size
    check (pg_column_size(attachments) <= 2048),
  constraint communication_messages_media_state_allowed
    check (media_state in ('not_ingested', 'pending', 'stored', 'unavailable')),

  -- An inbound message is always from the external party and is never queued.
  constraint communication_messages_direction_origin
    check (
      (direction = 'inbound' and origin = 'contact')
      or (direction = 'outbound' and origin <> 'contact')
    ),
  constraint communication_messages_direction_status
    check (
      (direction = 'inbound' and status = 'received')
      or (direction = 'outbound' and status <> 'received')
    ),
  -- Only a CRM-queued message may sit in `queued`; a message sent from the
  -- provider's own app is already gone by the time the echo tells us about it.
  constraint communication_messages_queued_origin
    check (status <> 'queued' or origin in ('crm', 'automation')),
  constraint communication_messages_failed_requires_code
    check (status <> 'failed' or error_code is not null)
);

comment on table public.communication_messages is
  'Artist-scoped normalised message history across channels. Holds no provider credential and no expiring provider media URL.';
comment on column public.communication_messages.attachments is
  'Ordered attachment types only, for example ["image"]. Provider media URLs expire and are deliberately not persisted here.';
comment on column public.communication_messages.media_state is
  'Reserved lifecycle marker for a future media ingestion pipeline. not_ingested is the only state this release produces.';
comment on column public.communication_messages.origin is
  'contact = inbound; crm = queued in this CRM; provider_app = sent by hand from the provider app and learned through an echo; automation = reserved for later CRM automation.';

create unique index if not exists communication_messages_id_artist_key
  on public.communication_messages (id, artist_id);

create index if not exists communication_messages_conversation_idx
  on public.communication_messages (conversation_id, created_at desc, id);

create index if not exists communication_messages_artist_idx
  on public.communication_messages (artist_id, created_at desc);

create index if not exists communication_messages_provider_lookup_idx
  on public.communication_messages (artist_id, channel, provider_message_id)
  where provider_message_id is not null;

drop trigger if exists communication_conversations_set_updated_at
  on public.communication_conversations;
create trigger communication_conversations_set_updated_at
  before update on public.communication_conversations
  for each row execute function public.set_updated_at();

drop trigger if exists communication_messages_set_updated_at
  on public.communication_messages;
create trigger communication_messages_set_updated_at
  before update on public.communication_messages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Outbox link
--
-- The durable queue itself is unchanged. A single neutral link column replaces
-- the need for one nullable column per channel, and the composite foreign key
-- proves the queued message belongs to the same artist as the job.
--
-- Migration 0070 backfills this column from `whatsapp_message_id` and then
-- retires the WhatsApp-specific column and constraints.
-- ---------------------------------------------------------------------------

alter table public.integration_outbox
  add column if not exists communication_message_id uuid;

comment on column public.integration_outbox.communication_message_id is
  'Channel-neutral link to the queued communication message. Set for whatsapp_message and instagram_message jobs only.';

-- Automatic draining only ever considers jobs created after this migration, so
-- enabling the Instagram drain later cannot replay historical rows.
insert into crm_private.outbox_drain_rollouts (
  kind,
  automatic_after,
  created_at
)
select
  'instagram_message'::public.outbox_kind,
  statement_timestamp(),
  statement_timestamp()
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Mirrors the WhatsApp policies from migration 0047 exactly: reads are
-- artist-scoped for authenticated CRM users, and every write goes through a
-- named SECURITY DEFINER RPC. Message updates stay backend-only so a browser
-- cannot rewrite delivery state or history.
-- ---------------------------------------------------------------------------

alter table public.communication_conversations enable row level security;
alter table public.communication_conversations force row level security;
alter table public.communication_messages enable row level security;
alter table public.communication_messages force row level security;

revoke all on public.communication_conversations
  from public, anon, authenticated, service_role;
revoke all on public.communication_messages
  from public, anon, authenticated, service_role;

grant select on public.communication_conversations to authenticated;
grant select on public.communication_messages to authenticated;

drop policy if exists communication_conversations_select_artist_scope
  on public.communication_conversations;
create policy communication_conversations_select_artist_scope
  on public.communication_conversations
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists communication_conversations_insert_artist_scope
  on public.communication_conversations;
create policy communication_conversations_insert_artist_scope
  on public.communication_conversations
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists communication_conversations_update_artist_scope
  on public.communication_conversations;
create policy communication_conversations_update_artist_scope
  on public.communication_conversations
  for update
  using (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  )
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists communication_messages_select_artist_scope
  on public.communication_messages;
create policy communication_messages_select_artist_scope
  on public.communication_messages
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

drop policy if exists communication_messages_insert_artist_scope
  on public.communication_messages;
create policy communication_messages_insert_artist_scope
  on public.communication_messages
  for insert
  with check (
    crm_private.is_service_backend()
    or public.can_manage_artist(artist_id)
  );

drop policy if exists communication_messages_update_backend
  on public.communication_messages;
create policy communication_messages_update_backend
  on public.communication_messages
  for update
  using (crm_private.is_service_backend())
  with check (crm_private.is_service_backend());
