-- 0071_instagram_channel_binding.sql
--
-- Artist-scoped Instagram Professional messaging, bound to the neutral
-- communications core from migrations 0069 and 0070.
--
-- The authoritative Meta contract this implements is the Instagram API with
-- Instagram Login. Two properties of that contract drive the design here and
-- differ from WhatsApp:
--
--   * The account identity that arrives on a webhook is the Instagram
--     professional account id (`entry[].id`), and it is only learned at
--     connection time through OAuth. It therefore cannot be a static Worker
--     variable the way a WhatsApp phone number id is. The mapping from that id
--     to a CRM artist lives here, is written only by the trusted connector,
--     and fails closed for an unknown account.
--
--   * A single Meta app serves both artists, so the webhook signature proves
--     only that Meta sent the payload — never which artist it belongs to.
--     Artist resolution is a separate, backend-owned lookup, and this is the
--     boundary that stops Vladimir's account from ever opening a Kristina
--     conversation.
--
-- No token is stored in Postgres. The Instagram long-lived user access token
-- lives only in the connector Worker's encrypted KV store, exactly as the
-- Gmail and Monzo refresh tokens do. What is stored here is the non-secret
-- account identity plus the granted scope names.
--
-- Forward-only. No provider call, no credential, no cron change, no
-- deployment and no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. Integration identity guard
--
-- Extends the existing trigger from migration 0052 rather than adding a second
-- public surface. WhatsApp already required its selector to stay inside the
-- owning artist's slug namespace, because the Worker turns that selector
-- deterministically into an encrypted binding name. Instagram now carries the
-- same rule, plus a shape check on the account identity it must hold.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from public.artist_integrations i
    join public.artists a on a.id = i.artist_id
    where i.integration_type = 'instagram'::public.artist_integration_type
      and i.integration_key not like a.slug || '-%'
  ) then
    raise exception 'existing Instagram integration key is outside its artist namespace'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function crm_private.protect_artist_integration_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_slug text;
begin
  if tg_op = 'UPDATE'
     and (
       new.artist_id is distinct from old.artist_id
       or new.integration_type is distinct from old.integration_type
       or new.integration_key is distinct from old.integration_key
     ) then
    raise exception 'artist integration identity is immutable; disable it and create a new integration'
      using errcode = '23514';
  end if;

  if new.integration_type in (
    'whatsapp'::public.artist_integration_type,
    'instagram'::public.artist_integration_type
  ) then
    select a.slug into v_artist_slug
    from public.artists a
    where a.id = new.artist_id;

    if not found then
      raise exception 'artist does not exist'
        using errcode = '23503';
    end if;

    if new.integration_key not like v_artist_slug || '-%' then
      raise exception 'messaging integration key must stay in the owning artist namespace'
        using errcode = '23514';
    end if;
  end if;

  -- An enabled Instagram route must name exactly one Instagram professional
  -- account. Without it the webhook could never resolve an artist, and an
  -- outbound send would have no account to send from.
  if new.integration_type = 'instagram'::public.artist_integration_type
     and new.is_enabled then
    if coalesce(new.configuration ->> 'instagram_user_id', '') !~ '^[0-9]{5,40}$' then
      raise exception 'an enabled Instagram integration must record its Instagram professional account id'
        using errcode = '23514';
    end if;
  end if;

  if new.is_enabled then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_artist_integration_identity()
  from public, anon, authenticated, service_role;

comment on function crm_private.protect_artist_integration_identity() is
  'Protects immutable artist integration identity, active-artist activation, messaging integration-key ownership and the Instagram account binding. Messaging selectors must stay inside the owning artist slug namespace so one artist cannot resolve another artist encrypted binding.';

-- One Instagram professional account belongs to at most one artist. Without
-- this a misconfigured second row could make webhook routing ambiguous, and an
-- ambiguous route is exactly the cross-artist leak this integration must not
-- have.
create unique index if not exists artist_integrations_instagram_account_key
  on public.artist_integrations ((configuration ->> 'instagram_user_id'))
  where integration_type = 'instagram'::public.artist_integration_type
    and configuration ? 'instagram_user_id';

-- ---------------------------------------------------------------------------
-- 2. Connector-owned binding lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.service_set_instagram_integration(
  p_artist_id uuid,
  p_integration_key text,
  p_instagram_user_id text,
  p_username text,
  p_scopes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_username text;
  v_scopes text[];
  v_configuration jsonb;
  v_integration_id uuid;
  v_conflicting_artist uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram integration management is backend-only'
      using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if coalesce(p_instagram_user_id, '') !~ '^[0-9]{5,40}$' then
    raise exception 'a valid Instagram professional account id is required'
      using errcode = '22023';
  end if;

  v_username := nullif(btrim(coalesce(p_username, '')), '');
  if v_username is not null and v_username !~ '^[A-Za-z0-9._]{1,40}$' then
    raise exception 'the Instagram username is not in the expected form'
      using errcode = '22023';
  end if;

  v_scopes := coalesce(p_scopes, array[]::text[]);
  if array_length(v_scopes, 1) is null or array_length(v_scopes, 1) > 12 then
    raise exception 'the granted Instagram scopes are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_scopes) as s(scope)
    where s.scope !~ '^[a-z][a-z0-9_]{2,63}$'
  ) then
    raise exception 'a granted Instagram scope is not in the expected form'
      using errcode = '22023';
  end if;
  -- Messaging is the whole point of this integration. Enabling a route that
  -- cannot send or receive would produce a connection that silently does
  -- nothing.
  if not ('instagram_business_manage_messages' = any (v_scopes)) then
    raise exception 'the Instagram connection did not grant messaging permission'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  -- Refuse to move an account that another artist already owns. Reassignment
  -- is an explicit disconnect, never an implicit side effect of reconnecting.
  select i.artist_id into v_conflicting_artist
  from public.artist_integrations i
  where i.integration_type = 'instagram'::public.artist_integration_type
    and i.configuration ->> 'instagram_user_id' = p_instagram_user_id
    and i.artist_id <> p_artist_id
  limit 1;
  if found then
    raise exception 'this Instagram account is already connected to another artist'
      using errcode = '23514';
  end if;

  v_configuration := jsonb_build_object(
    'instagram_user_id', p_instagram_user_id,
    'username', v_username,
    'scopes', to_jsonb(v_scopes),
    'connected_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  insert into public.artist_integrations (
    artist_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    p_artist_id,
    'instagram'::public.artist_integration_type,
    'instagram_login',
    p_integration_key,
    coalesce('@' || v_username, 'Instagram'),
    v_configuration,
    true
  )
  on conflict (artist_id, integration_type, integration_key) do update
  set provider = 'instagram_login',
      external_account_label = excluded.external_account_label,
      configuration = excluded.configuration,
      is_enabled = true,
      updated_at = now()
  returning id into v_integration_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'instagram.connected',
    'worker',
    null, null, null, null, null, null,
    jsonb_build_object(
      'integration', p_integration_key,
      'account', p_instagram_user_id
    )
  );

  return jsonb_build_object(
    'integration_id', v_integration_id,
    'artist_id', p_artist_id,
    'integration_key', p_integration_key,
    'is_enabled', true
  );
end;
$$;

revoke all on function public.service_set_instagram_integration(uuid, text, text, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.service_set_instagram_integration(uuid, text, text, text, text[])
  to service_role;

comment on function public.service_set_instagram_integration(uuid, text, text, text, text[]) is
  'Backend-only Instagram connection binding written after the connector has verified the account server-side. Stores non-secret account identity and granted scopes; never a token.';

create or replace function public.service_disable_instagram_integration(
  p_artist_id uuid,
  p_integration_key text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_rows integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram integration management is backend-only'
      using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'a safe integration key is required' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'a safe machine error code is required' using errcode = '22023';
  end if;

  update public.artist_integrations i
  set is_enabled = false,
      updated_at = now()
  where i.artist_id = p_artist_id
    and i.integration_type = 'instagram'::public.artist_integration_type
    and i.integration_key = p_integration_key
    and i.is_enabled;

  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    perform crm_private.log_artist_activity(
      p_artist_id,
      'instagram.disconnected',
      'worker',
      null, null, null, null, null, null,
      jsonb_build_object(
        'integration', p_integration_key,
        'error_code', p_error_code
      )
    );
  end if;

  return jsonb_build_object('artist_id', p_artist_id, 'changed', v_rows > 0);
end;
$$;

revoke all on function public.service_disable_instagram_integration(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_disable_instagram_integration(uuid, text, text)
  to service_role;

comment on function public.service_disable_instagram_integration(uuid, text, text) is
  'Backend-only Instagram disconnect. Used by the operator disconnect action and by the connector when Meta reports the token is no longer usable.';

-- ---------------------------------------------------------------------------
-- 3. Server-authoritative webhook routing
--
-- The webhook body names an Instagram professional account. This function is
-- the only thing that turns that name into a CRM artist, and it refuses to
-- answer for an account that is unknown, disabled, ambiguous or owned by an
-- inactive artist. There is no fallback artist and no default route.
-- ---------------------------------------------------------------------------

create or replace function public.service_resolve_instagram_route(
  p_instagram_user_id text
)
returns table (
  artist_id uuid,
  integration_key text,
  instagram_user_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_match_count integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram route resolution is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_instagram_user_id, '') !~ '^[0-9]{5,40}$' then
    raise exception 'a valid Instagram professional account id is required'
      using errcode = '22023';
  end if;

  select count(*) into v_match_count
  from public.artist_integrations i
  join crm_private.artist_state a on a.artist_id = i.artist_id and a.is_active
  where i.integration_type = 'instagram'::public.artist_integration_type
    and i.provider = 'instagram_login'
    and i.is_enabled
    and i.configuration ->> 'instagram_user_id' = p_instagram_user_id;

  -- Fail closed. One account resolves to exactly one artist or to nothing.
  if v_match_count <> 1 then
    raise exception 'Instagram account route is unavailable' using errcode = '23503';
  end if;

  return query
  select i.artist_id, i.integration_key, p_instagram_user_id
  from public.artist_integrations i
  join crm_private.artist_state a on a.artist_id = i.artist_id and a.is_active
  where i.integration_type = 'instagram'::public.artist_integration_type
    and i.provider = 'instagram_login'
    and i.is_enabled
    and i.configuration ->> 'instagram_user_id' = p_instagram_user_id;
end;
$$;

revoke all on function public.service_resolve_instagram_route(text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_instagram_route(text)
  to service_role;

comment on function public.service_resolve_instagram_route(text) is
  'Backend-only mapping from a signed Instagram professional account id to exactly one active artist route. Unknown, disabled or ambiguous accounts fail closed.';

-- ---------------------------------------------------------------------------
-- 4. Read receipts
--
-- Instagram publishes a read watermark rather than a per-message delivery
-- receipt: `messaging_seen` names the most recent message the participant has
-- seen. Everything the CRM sent to that participant at or before that message
-- is therefore read, and nothing about delivery is claimed, because Meta does
-- not report it for this channel.
-- ---------------------------------------------------------------------------

create or replace function public.record_communication_read_receipt(
  p_artist_id uuid,
  p_channel text,
  p_integration_key text,
  p_external_contact_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_channel public.communication_channel;
  v_conversation_id uuid;
  v_watermark timestamptz;
  v_updated integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication read receipts are backend-only'
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
    raise exception 'artist webhook route is unavailable' using errcode = '23503';
  end if;

  select c.id into v_conversation_id
  from public.communication_conversations c
  where c.artist_id = p_artist_id
    and c.channel = v_channel
    and c.external_contact_id = p_external_contact_id;
  if not found then
    return jsonb_build_object('changed', false, 'messages', 0);
  end if;

  -- The named message is the watermark. If this CRM never stored it, the event
  -- is a safe no-op rather than a guess about which messages it covered.
  select m.created_at into v_watermark
  from public.communication_messages m
  where m.artist_id = p_artist_id
    and m.channel = v_channel
    and m.provider_message_id = p_provider_message_id;
  if not found then
    return jsonb_build_object('changed', false, 'messages', 0);
  end if;

  update public.communication_messages m
  set status = 'read'::public.communication_status,
      read_at = coalesce(m.read_at, p_provider_timestamp),
      sent_at = coalesce(m.sent_at, m.created_at),
      updated_at = now()
  where m.conversation_id = v_conversation_id
    and m.direction = 'outbound'::public.communication_direction
    and m.created_at <= v_watermark
    and m.status in (
      'sent'::public.communication_status,
      'delivered'::public.communication_status
    );

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'changed', v_updated > 0,
    'messages', v_updated,
    'conversation_id', v_conversation_id
  );
end;
$$;

revoke all on function public.record_communication_read_receipt(
  uuid, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_communication_read_receipt(
  uuid, text, text, text, text, timestamptz
) to service_role;

comment on function public.record_communication_read_receipt(
  uuid, text, text, text, text, timestamptz
) is
  'Backend-only application of a provider read watermark. Only sent or delivered outbound messages at or before the watermark move to read; terminal failures are untouched.';

-- ---------------------------------------------------------------------------
-- 5. Provider echoes
--
-- A reply the artist typed in the Instagram app arrives as a `message_echoes`
-- notification. Recording it keeps the CRM timeline honest about what the
-- client actually received. The provider message id is the deduplication
-- boundary, so an echo of a message this CRM itself sent collides with the
-- existing row instead of duplicating it.
-- ---------------------------------------------------------------------------

create or replace function public.record_communication_outbound_echo(
  p_artist_id uuid,
  p_channel text,
  p_integration_key text,
  p_external_contact_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_message_type text,
  p_body text default null,
  p_attachments jsonb default '[]'::jsonb
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
  v_body text;
  v_attachments jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication echo ingestion is backend-only'
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

  if p_message_type = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' or char_length(v_body) > 4096 then
      raise exception 'a valid text message body is required' using errcode = '22023';
    end if;
  else
    if p_body is not null then
      raise exception 'non-text echoes must not carry body text' using errcode = '22023';
    end if;
    v_body := null;
  end if;

  v_attachments := coalesce(p_attachments, '[]'::jsonb);
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 16 then
    raise exception 'attachment metadata is not in the expected form' using errcode = '22023';
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
    raise exception 'artist webhook route is unavailable' using errcode = '23503';
  end if;

  -- An echo never opens a conversation. If the CRM has no record of talking to
  -- this participant, there is nothing to attribute the echo to, and inventing
  -- a conversation from an outbound-only event would produce a contact the CRM
  -- never actually heard from.
  select c.id into v_conversation_id
  from public.communication_conversations c
  where c.artist_id = p_artist_id
    and c.channel = v_channel
    and c.external_contact_id = p_external_contact_id;
  if not found then
    return jsonb_build_object('changed', false, 'message_id', null);
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, attachments, provider_message_id, provider_timestamp,
    sent_at
  ) values (
    v_conversation_id,
    p_artist_id,
    v_channel,
    'outbound'::public.communication_direction,
    'provider_app'::public.communication_origin,
    'sent'::public.communication_status,
    p_message_type,
    v_body,
    v_attachments,
    p_provider_message_id,
    p_provider_timestamp,
    p_provider_timestamp
  )
  on conflict (artist_id, channel, provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    return jsonb_build_object('changed', false, 'message_id', null);
  end if;

  update public.communication_conversations c
  set last_message_at = greatest(
        coalesce(c.last_message_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      last_outbound_at = greatest(
        coalesce(c.last_outbound_at, '-infinity'::timestamptz),
        p_provider_timestamp
      ),
      updated_at = now()
  where c.id = v_conversation_id;

  return jsonb_build_object('changed', true, 'message_id', v_message_id);
end;
$$;

revoke all on function public.record_communication_outbound_echo(
  uuid, text, text, text, text, timestamptz, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_communication_outbound_echo(
  uuid, text, text, text, text, timestamptz, text, text, jsonb
) to service_role;

comment on function public.record_communication_outbound_echo(
  uuid, text, text, text, text, timestamptz, text, text, jsonb
) is
  'Backend-only idempotent ingestion of a provider echo for a message sent outside this CRM. Never creates a conversation.';

-- ---------------------------------------------------------------------------
-- 6. Participant enrichment
--
-- Meta's messaging webhook carries only the participant id. The connector
-- looks the display name and handle up separately, outside the webhook path,
-- so a slow or failing profile call can never delay or fail message
-- ingestion.
-- ---------------------------------------------------------------------------

create or replace function public.service_update_communication_participant(
  p_artist_id uuid,
  p_channel text,
  p_external_contact_id text,
  p_username text default null,
  p_display_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_channel public.communication_channel;
  v_username text;
  v_label text;
  v_updated integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'participant enrichment is backend-only'
      using errcode = '42501';
  end if;
  if p_artist_id is null then
    raise exception 'artist id is required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;
  v_channel := p_channel::public.communication_channel;

  v_username := nullif(btrim(coalesce(p_username, '')), '');
  if v_username is not null and v_username !~ '^[A-Za-z0-9._]{1,40}$' then
    raise exception 'the participant username is not in the expected form'
      using errcode = '22023';
  end if;

  v_label := nullif(btrim(coalesce(p_display_label, '')), '');
  if v_label is not null and char_length(v_label) > 160 then
    v_label := left(v_label, 160);
  end if;

  update public.communication_conversations c
  set external_username = coalesce(v_username, c.external_username),
      external_display_label = coalesce(v_label, c.external_display_label),
      updated_at = now()
  where c.artist_id = p_artist_id
    and c.channel = v_channel
    and c.external_contact_id = p_external_contact_id;

  get diagnostics v_updated = row_count;

  return jsonb_build_object('changed', v_updated > 0);
end;
$$;

revoke all on function public.service_update_communication_participant(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.service_update_communication_participant(
  uuid, text, text, text, text
) to service_role;

comment on function public.service_update_communication_participant(uuid, text, text, text, text) is
  'Backend-only participant label enrichment. Never changes identity, artist, client link or message history.';

-- ---------------------------------------------------------------------------
-- 7. Operator-initiated connection authorisation
--
-- The connector Worker never trusts an artist id that arrives from a browser.
-- It calls this function with the operator's own Supabase session, and the
-- database answers with the integration selector that operator is allowed to
-- connect. The selector is derived from the artist slug rather than accepted
-- from the caller, so the encrypted binding namespace cannot be steered.
-- ---------------------------------------------------------------------------

create or replace function public.authorize_instagram_connection(p_artist_id uuid)
returns table (
  artist_id uuid,
  artist_slug text,
  integration_key text,
  instagram_user_id text,
  is_enabled boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug text;
begin
  if p_artist_id is null then
    raise exception 'an artist id is required' using errcode = '22023';
  end if;

  perform crm_private.require_role('owner', 'booking_manager');
  perform crm_private.require_active_artist(p_artist_id);
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');

  select a.slug into v_slug from public.artists a where a.id = p_artist_id;
  if not found then
    raise exception 'artist does not exist' using errcode = '23503';
  end if;

  return query
  select
    p_artist_id,
    v_slug,
    v_slug || '-instagram',
    i.configuration ->> 'instagram_user_id',
    coalesce(i.is_enabled, false)
  from (select 1) as anchor
  left join public.artist_integrations i
    on i.artist_id = p_artist_id
   and i.integration_type = 'instagram'::public.artist_integration_type
   and i.integration_key = v_slug || '-instagram';
end;
$$;

revoke all on function public.authorize_instagram_connection(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_instagram_connection(uuid)
  to authenticated;

comment on function public.authorize_instagram_connection(uuid) is
  'Authenticated CRM entry point for Instagram onboarding. Proves the caller may manage this artist integrations and returns the server-derived selector; the caller cannot choose one.';

-- ---------------------------------------------------------------------------
-- 8. Participant enrichment backlog
--
-- The webhook path deliberately stores only the participant id. The connector
-- fills in handles afterwards, and this bounded query is how it finds the work.
-- ---------------------------------------------------------------------------

create or replace function public.service_list_unenriched_participants(
  p_channel text,
  p_limit integer default 20
)
returns table (
  artist_id uuid,
  integration_key text,
  external_contact_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_channel public.communication_channel;
  v_limit integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'participant enrichment is backend-only' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'instagram') then
    raise exception 'a supported channel is required' using errcode = '22023';
  end if;
  v_channel := p_channel::public.communication_channel;

  v_limit := coalesce(p_limit, 20);
  if v_limit < 1 or v_limit > 50 then
    raise exception 'the batch must be between 1 and 50' using errcode = '22023';
  end if;

  return query
  select c.artist_id, c.integration_key, c.external_contact_id
  from public.communication_conversations c
  join public.artist_integrations i
    on i.artist_id = c.artist_id
   and i.integration_type = crm_private.communication_integration_type(v_channel)
   and i.integration_key = c.integration_key
   and i.is_enabled
  where c.channel = v_channel
    and c.external_username is null
  order by c.last_inbound_at desc nulls last, c.id
  limit v_limit;
end;
$$;

revoke all on function public.service_list_unenriched_participants(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_unenriched_participants(text, integer)
  to service_role;

comment on function public.service_list_unenriched_participants(text, integer) is
  'Backend-only bounded list of conversations still missing a participant handle. Returns no message content.';
