-- 0086_telegram_self_service.sql
--
-- Phase F foundation for one shared Telegram bot with self-service destinations.
--
-- Security posture:
--   * chat ids live only in crm_private;
--   * browser callers receive connection state, never a chat id;
--   * raw linking tokens are returned once and never persisted;
--   * only SHA-256 token hashes are stored;
--   * personal and artist/shared destinations are different target kinds;
--   * completing a personal link materialises the existing 0077 private target;
--   * no production destination is seeded or backfilled here;
--   * service delivery RPCs are additive and contact no provider by themselves.
--
-- Phase G changes the Worker to prefer this registry and retain the static
-- binding fallback until production equivalence is proven.

-- ---------------------------------------------------------------------------
-- 1. Private destination and linking state
-- ---------------------------------------------------------------------------

create table crm_private.telegram_destinations (
  id                       uuid primary key default gen_random_uuid(),
  destination_kind         text not null,
  profile_id               uuid references public.profiles(id) on delete cascade,
  artist_id                uuid references public.artists(id) on delete cascade,
  chat_id                  text not null,
  chat_type                text not null,
  safe_label               text not null,
  is_active                boolean not null default true,
  connected_by_profile_id  uuid references public.profiles(id) on delete set null,
  connected_at             timestamptz not null default now(),
  last_success_at          timestamptz,
  last_error_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint telegram_destinations_kind_known
    check (destination_kind in ('profile', 'artist')),
  constraint telegram_destinations_exact_target
    check (
      (destination_kind = 'profile' and profile_id is not null and artist_id is null)
      or
      (destination_kind = 'artist' and artist_id is not null and profile_id is null)
    ),
  constraint telegram_destinations_chat_id_shape
    check (chat_id ~ '^-?[0-9]{1,20}$'),
  constraint telegram_destinations_chat_type_known
    check (chat_type in ('private', 'group', 'supergroup')),
  constraint telegram_destinations_target_chat_type
    check (
      (destination_kind = 'profile' and chat_type = 'private')
      or
      (destination_kind = 'artist' and chat_type in ('group', 'supergroup'))
    ),
  constraint telegram_destinations_safe_label_present
    check (btrim(safe_label) <> '' and char_length(safe_label) <= 120),
  unique (profile_id),
  unique (artist_id)
);

revoke all on crm_private.telegram_destinations
  from public, anon, authenticated, service_role;

comment on table crm_private.telegram_destinations is
  'Telegram delivery addresses. A chat id is a capability and is never exposed through a browser, GPT or MCP surface.';

create table crm_private.telegram_link_sessions (
  id                  uuid primary key default gen_random_uuid(),
  token_hash          text not null unique,
  destination_kind    text not null,
  profile_id          uuid references public.profiles(id) on delete cascade,
  artist_id           uuid references public.artists(id) on delete cascade,
  requested_by        uuid not null references public.profiles(id) on delete cascade,
  expires_at          timestamptz not null,
  consumed_at         timestamptz,
  invalidated_at      timestamptz,
  created_at          timestamptz not null default now(),

  constraint telegram_link_sessions_hash_shape
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint telegram_link_sessions_kind_known
    check (destination_kind in ('profile', 'artist')),
  constraint telegram_link_sessions_exact_target
    check (
      (destination_kind = 'profile' and profile_id is not null and artist_id is null)
      or
      (destination_kind = 'artist' and artist_id is not null and profile_id is null)
    ),
  constraint telegram_link_sessions_expiry_after_create
    check (expires_at > created_at)
);

create index telegram_link_sessions_profile_open_idx
  on crm_private.telegram_link_sessions(profile_id, created_at desc)
  where destination_kind = 'profile' and consumed_at is null and invalidated_at is null;
create index telegram_link_sessions_artist_open_idx
  on crm_private.telegram_link_sessions(artist_id, created_at desc)
  where destination_kind = 'artist' and consumed_at is null and invalidated_at is null;

revoke all on crm_private.telegram_link_sessions
  from public, anon, authenticated, service_role;

comment on table crm_private.telegram_link_sessions is
  'Single-use Telegram linking challenges. Only a SHA-256 token hash is persisted; the raw start parameter exists only in the begin RPC response.';

create table crm_private.telegram_connector_settings (
  singleton     boolean primary key default true check (singleton),
  bot_username  text,
  updated_at    timestamptz not null default now(),
  constraint telegram_connector_username_shape
    check (bot_username is null or bot_username ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$')
);

insert into crm_private.telegram_connector_settings(singleton, bot_username)
values (true, null)
on conflict (singleton) do nothing;

revoke all on crm_private.telegram_connector_settings
  from public, anon, authenticated, service_role;

-- Separate delivery state keeps in-app status independent from external
-- delivery status. A notification can be read in CRM even when Telegram is
-- temporarily unavailable, and a Telegram retry never creates a second CRM
-- notification.
create table crm_private.telegram_notification_deliveries (
  id                 uuid primary key default gen_random_uuid(),
  notification_id    uuid not null unique references public.notifications(id) on delete cascade,
  profile_id         uuid not null references public.profiles(id) on delete cascade,
  destination_id     uuid not null references crm_private.telegram_destinations(id) on delete cascade,
  status             text not null default 'pending',
  attempt_count      integer not null default 0,
  max_attempts       integer not null default 5,
  next_attempt_at    timestamptz not null default now(),
  leased_by          text,
  leased_at          timestamptz,
  lease_expires_at   timestamptz,
  last_error_code    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint telegram_notification_delivery_status_known
    check (status in ('pending', 'leased', 'failed', 'succeeded', 'dead')),
  constraint telegram_notification_delivery_attempts_valid
    check (attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts),
  constraint telegram_notification_delivery_error_shape
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint telegram_notification_delivery_lease_shape
    check (
      (status = 'leased' and leased_by is not null and leased_at is not null and lease_expires_at is not null)
      or
      (status <> 'leased' and leased_by is null and leased_at is null and lease_expires_at is null)
    )
);

create index telegram_notification_deliveries_due_idx
  on crm_private.telegram_notification_deliveries(next_attempt_at)
  where status in ('pending', 'failed', 'leased');

revoke all on crm_private.telegram_notification_deliveries
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Private scope helper for backend delivery
-- ---------------------------------------------------------------------------

create or replace function crm_private.profile_can_receive_notification(
  p_profile_id uuid,
  p_artist_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from crm_private.profile_access p
    where p.profile_id = p_profile_id
      and p.is_active
      and (
        p_artist_id is null
        or exists (
          select 1
          from crm_private.artist_access a
          where a.profile_id = p_profile_id
            and a.artist_id = p_artist_id
            and a.is_active
        )
      )
      and (
        p_workspace_id is null
        or exists (
          select 1
          from crm_private.workspace_access w
          join crm_private.workspace_state s on s.workspace_id = w.workspace_id
          where w.profile_id = p_profile_id
            and w.workspace_id = p_workspace_id
            and w.is_active
            and s.is_active
        )
      )
  );
$$;

revoke all on function crm_private.profile_can_receive_notification(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Browser control plane - safe metadata only
-- ---------------------------------------------------------------------------

create or replace function public.get_telegram_connector_info()
returns table (bot_username text)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select s.bot_username
  from crm_private.telegram_connector_settings s
  where s.singleton
    and public.is_active_user();
$$;

revoke all on function public.get_telegram_connector_info()
  from public, anon, authenticated, service_role;
grant execute on function public.get_telegram_connector_info()
  to authenticated;

comment on function public.get_telegram_connector_info() is
  'Returns only the public Telegram bot username used to construct a t.me start link. Never returns a bot token or destination id.';

create or replace function public.configure_telegram_connector_identity(p_bot_username text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_username text;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure the Telegram bot identity'
      using errcode = '42501';
  end if;

  v_username := nullif(btrim(coalesce(p_bot_username, '')), '');
  if v_username is not null and v_username !~ '^[A-Za-z][A-Za-z0-9_]{4,31}$' then
    raise exception 'Telegram bot username is invalid' using errcode = '22023';
  end if;

  update crm_private.telegram_connector_settings
  set bot_username = v_username,
      updated_at = now()
  where singleton;

  return v_username;
end;
$$;

revoke all on function public.configure_telegram_connector_identity(text)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_telegram_connector_identity(text)
  to authenticated;

create or replace function public.list_telegram_destinations()
returns table (
  destination_kind text,
  artist_id uuid,
  target_label text,
  is_connected boolean,
  safe_label text,
  connected_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with me as (
    select auth.uid() as profile_id
    where public.is_active_user()
  ),
  personal as (
    select
      'profile'::text as destination_kind,
      null::uuid as artist_id,
      'Personal Telegram'::text as target_label,
      coalesce(d.is_active, false) as is_connected,
      d.safe_label,
      d.connected_at
    from me
    left join crm_private.telegram_destinations d
      on d.destination_kind = 'profile'
     and d.profile_id = me.profile_id
  ),
  artists as (
    select
      'artist'::text,
      a.id,
      a.display_name,
      coalesce(d.is_active, false),
      d.safe_label,
      d.connected_at
    from public.artists a
    left join crm_private.telegram_destinations d
      on d.destination_kind = 'artist'
     and d.artist_id = a.id
    where a.is_active
      and crm_private.has_artist_capability(a.id, 'manage_integrations')
  )
  select * from personal
  union all
  select * from artists
  order by destination_kind, target_label;
$$;

revoke all on function public.list_telegram_destinations()
  from public, anon, authenticated, service_role;
grant execute on function public.list_telegram_destinations()
  to authenticated;

comment on function public.list_telegram_destinations() is
  'Safe Telegram connection status for the signed-in profile and Artists whose integrations they may manage. Chat ids are never returned.';

create or replace function public.begin_telegram_link(
  p_destination_kind text,
  p_artist_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_kind text := lower(btrim(coalesce(p_destination_kind, '')));
  v_profile_id uuid := auth.uid();
  v_token text;
  v_hash text;
  v_expires timestamptz := now() + interval '10 minutes';
  v_label text;
begin
  if v_profile_id is null or not public.is_active_user() then
    raise exception 'an active CRM profile is required' using errcode = '42501';
  end if;

  if v_kind = 'profile' then
    if p_artist_id is not null then
      raise exception 'a personal Telegram link takes no artist id' using errcode = '22023';
    end if;
    v_label := 'Personal Telegram';

    update crm_private.telegram_link_sessions s
    set invalidated_at = now()
    where s.destination_kind = 'profile'
      and s.profile_id = v_profile_id
      and s.consumed_at is null
      and s.invalidated_at is null;
  elsif v_kind = 'artist' then
    if p_artist_id is null then
      raise exception 'an artist id is required for a shared Telegram destination'
        using errcode = '22023';
    end if;
    perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
    perform crm_private.require_active_artist(p_artist_id);

    select a.display_name into v_label
    from public.artists a
    where a.id = p_artist_id;

    update crm_private.telegram_link_sessions s
    set invalidated_at = now()
    where s.destination_kind = 'artist'
      and s.artist_id = p_artist_id
      and s.consumed_at is null
      and s.invalidated_at is null;
  else
    raise exception 'Telegram destination kind must be profile or artist'
      using errcode = '22023';
  end if;

  -- UUID text without hyphens is 32 characters from Telegram's documented
  -- start-parameter alphabet. Only its digest is persisted.
  v_token := replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into crm_private.telegram_link_sessions (
    token_hash, destination_kind, profile_id, artist_id,
    requested_by, expires_at
  ) values (
    v_hash,
    v_kind,
    case when v_kind = 'profile' then v_profile_id else null end,
    case when v_kind = 'artist' then p_artist_id else null end,
    v_profile_id,
    v_expires
  );

  return jsonb_build_object(
    'link_token', v_token,
    'expires_at', v_expires,
    'destination_kind', v_kind,
    'artist_id', case when v_kind = 'artist' then p_artist_id else null end,
    'target_label', v_label
  );
end;
$$;

revoke all on function public.begin_telegram_link(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_telegram_link(text,uuid)
  to authenticated;

comment on function public.begin_telegram_link(text,uuid) is
  'Creates one ten-minute single-use Telegram start challenge. Returns the raw token once; PostgreSQL stores only its SHA-256 digest.';

create or replace function public.disconnect_telegram_destination(
  p_destination_kind text,
  p_artist_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_kind text := lower(btrim(coalesce(p_destination_kind, '')));
  v_profile_id uuid := auth.uid();
  v_changed integer := 0;
begin
  if v_profile_id is null or not public.is_active_user() then
    raise exception 'an active CRM profile is required' using errcode = '42501';
  end if;

  if v_kind = 'profile' then
    if p_artist_id is not null then
      raise exception 'a personal Telegram destination takes no artist id'
        using errcode = '22023';
    end if;

    update crm_private.telegram_destinations d
    set is_active = false, updated_at = now()
    where d.destination_kind = 'profile'
      and d.profile_id = v_profile_id
      and d.is_active;
    get diagnostics v_changed = row_count;

    update crm_private.profile_notification_targets t
    set is_active = false
    where t.profile_id = v_profile_id
      and t.channel = 'telegram';

    insert into public.notification_preferences(profile_id, channel, is_enabled)
    values (v_profile_id, 'telegram', false)
    on conflict (profile_id, channel) do update
      set is_enabled = false,
          updated_at = now();
  elsif v_kind = 'artist' then
    if p_artist_id is null then
      raise exception 'an artist id is required for a shared Telegram destination'
        using errcode = '22023';
    end if;
    perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');

    update crm_private.telegram_destinations d
    set is_active = false, updated_at = now()
    where d.destination_kind = 'artist'
      and d.artist_id = p_artist_id
      and d.is_active;
    get diagnostics v_changed = row_count;
  else
    raise exception 'Telegram destination kind must be profile or artist'
      using errcode = '22023';
  end if;

  return v_changed > 0;
end;
$$;

revoke all on function public.disconnect_telegram_destination(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.disconnect_telegram_destination(text,uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Backend linking completion and destination resolution
-- ---------------------------------------------------------------------------

create or replace function public.service_complete_telegram_link(
  p_token text,
  p_chat_id text,
  p_chat_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
  v_hash text;
  v_chat_id text := btrim(coalesce(p_chat_id, ''));
  v_chat_type text := lower(btrim(coalesce(p_chat_type, '')));
  v_session crm_private.telegram_link_sessions%rowtype;
  v_destination_id uuid;
  v_label text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram linking completion is backend-only' using errcode = '42501';
  end if;

  if v_token !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'Telegram linking challenge is invalid or expired' using errcode = '22023';
  end if;
  if v_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'Telegram chat id is invalid' using errcode = '22023';
  end if;
  if v_chat_type not in ('private', 'group', 'supergroup') then
    raise exception 'Telegram chat type is unsupported' using errcode = '22023';
  end if;

  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  select s.* into v_session
  from crm_private.telegram_link_sessions s
  where s.token_hash = v_hash
    and s.consumed_at is null
    and s.invalidated_at is null
    and s.expires_at > now()
  for update;

  if not found then
    raise exception 'Telegram linking challenge is invalid or expired' using errcode = '22023';
  end if;

  if v_session.destination_kind = 'profile' and v_chat_type <> 'private' then
    raise exception 'a personal Telegram destination must be a private chat'
      using errcode = '22023';
  end if;
  if v_session.destination_kind = 'artist' and v_chat_type not in ('group', 'supergroup') then
    raise exception 'an Artist Telegram destination must be a group chat'
      using errcode = '22023';
  end if;

  if v_session.destination_kind = 'profile' then
    if not exists (
      select 1 from crm_private.profile_access p
      where p.profile_id = v_session.profile_id and p.is_active
    ) then
      raise exception 'the CRM profile is no longer active' using errcode = '42501';
    end if;
    v_label := 'Personal Telegram';

    insert into crm_private.telegram_destinations (
      destination_kind, profile_id, chat_id, chat_type, safe_label,
      is_active, connected_by_profile_id, connected_at, updated_at
    ) values (
      'profile', v_session.profile_id, v_chat_id, v_chat_type, v_label,
      true, v_session.requested_by, now(), now()
    )
    on conflict (profile_id) do update
      set chat_id = excluded.chat_id,
          chat_type = excluded.chat_type,
          safe_label = excluded.safe_label,
          is_active = true,
          connected_by_profile_id = excluded.connected_by_profile_id,
          connected_at = now(),
          last_error_at = null,
          updated_at = now()
    returning id into v_destination_id;

    insert into crm_private.profile_notification_targets (
      profile_id, channel, target_address, safe_label, is_active, connected_at,
      last_success_at, last_error_at
    ) values (
      v_session.profile_id, 'telegram', v_chat_id, v_label, true, now(), null, null
    )
    on conflict (profile_id, channel) do update
      set target_address = excluded.target_address,
          safe_label = excluded.safe_label,
          is_active = true,
          connected_at = now(),
          last_error_at = null;
  else
    if not exists (
      select 1
      from crm_private.profile_access p
      join crm_private.artist_access a on a.profile_id = p.profile_id
      where p.profile_id = v_session.requested_by
        and p.is_active
        and a.artist_id = v_session.artist_id
        and a.is_active
        and (p.role = 'owner' or (p.role = 'booking_manager' and a.can_manage_integrations))
    ) then
      raise exception 'Artist integration access was revoked before linking completed'
        using errcode = '42501';
    end if;
    perform crm_private.require_active_artist(v_session.artist_id);
    v_label := 'Shared Telegram group';

    insert into crm_private.telegram_destinations (
      destination_kind, artist_id, chat_id, chat_type, safe_label,
      is_active, connected_by_profile_id, connected_at, updated_at
    ) values (
      'artist', v_session.artist_id, v_chat_id, v_chat_type, v_label,
      true, v_session.requested_by, now(), now()
    )
    on conflict (artist_id) do update
      set chat_id = excluded.chat_id,
          chat_type = excluded.chat_type,
          safe_label = excluded.safe_label,
          is_active = true,
          connected_by_profile_id = excluded.connected_by_profile_id,
          connected_at = now(),
          last_error_at = null,
          updated_at = now()
    returning id into v_destination_id;
  end if;

  update crm_private.telegram_link_sessions s
  set consumed_at = now()
  where s.id = v_session.id;

  return jsonb_build_object(
    'destination_id', v_destination_id,
    'destination_kind', v_session.destination_kind,
    'profile_id', v_session.profile_id,
    'artist_id', v_session.artist_id,
    'connected', true
  );
end;
$$;

revoke all on function public.service_complete_telegram_link(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_complete_telegram_link(text,text,text)
  to service_role;

create or replace function public.service_resolve_telegram_destination(
  p_artist_id uuid default null,
  p_profile_id uuid default null
)
returns table (
  destination_id uuid,
  destination_kind text,
  chat_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram destination resolution is backend-only' using errcode = '42501';
  end if;

  if (p_artist_id is null) = (p_profile_id is null) then
    raise exception 'exactly one Telegram destination target is required'
      using errcode = '22023';
  end if;

  if p_artist_id is not null then
    return query
    select d.id, d.destination_kind, d.chat_id
    from crm_private.telegram_destinations d
    join public.artists a on a.id = d.artist_id
    where d.destination_kind = 'artist'
      and d.artist_id = p_artist_id
      and d.is_active
      and a.is_active;
  else
    return query
    select d.id, d.destination_kind, d.chat_id
    from crm_private.telegram_destinations d
    join crm_private.profile_access p on p.profile_id = d.profile_id
    where d.destination_kind = 'profile'
      and d.profile_id = p_profile_id
      and d.is_active
      and p.is_active;
  end if;
end;
$$;

revoke all on function public.service_resolve_telegram_destination(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_telegram_destination(uuid,uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Personal Telegram delivery queue
-- ---------------------------------------------------------------------------

create or replace function public.service_claim_telegram_notifications(
  p_worker_id text,
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  profile_id uuid,
  chat_id text,
  title text,
  body text,
  priority public.notification_priority,
  artist_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram notification leasing is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Telegram claim limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Telegram lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  -- Materialise only notifications created after the current destination was
  -- connected. Linking Telegram must never replay an old in-app backlog.
  insert into crm_private.telegram_notification_deliveries (
    notification_id, profile_id, destination_id, next_attempt_at
  )
  select n.id, n.recipient_profile_id, d.id, now()
  from public.notifications n
  join crm_private.telegram_destinations d
    on d.destination_kind = 'profile'
   and d.profile_id = n.recipient_profile_id
   and d.is_active
  join public.notification_preferences pref
    on pref.profile_id = n.recipient_profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where n.scheduled_at <= now()
    and n.created_at >= d.connected_at
    and crm_private.profile_can_receive_notification(
          n.recipient_profile_id, n.artist_id, n.workspace_id)
    and not exists (
      select 1
      from crm_private.telegram_notification_deliveries x
      where x.notification_id = n.id
    )
  on conflict (notification_id) do nothing;

  return query
  with candidates as (
    select x.id
    from crm_private.telegram_notification_deliveries x
    join public.notifications n on n.id = x.notification_id
    join crm_private.telegram_destinations d on d.id = x.destination_id
    join public.notification_preferences pref
      on pref.profile_id = x.profile_id
     and pref.channel = 'telegram'
     and pref.is_enabled
    where d.is_active
      and d.destination_kind = 'profile'
      and d.profile_id = x.profile_id
      and crm_private.profile_can_receive_notification(x.profile_id, n.artist_id, n.workspace_id)
      and (
        (x.status in ('pending', 'failed') and x.next_attempt_at <= now())
        or (x.status = 'leased' and x.lease_expires_at <= now())
      )
    order by x.next_attempt_at, x.id
    for update of x skip locked
    limit p_limit
  ),
  leased as (
    update crm_private.telegram_notification_deliveries x
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    where x.id in (select id from candidates)
    returning x.*
  )
  select
    l.id,
    n.id,
    l.profile_id,
    d.chat_id,
    n.title,
    n.body,
    n.priority,
    n.artist_id,
    n.workspace_id
  from leased l
  join public.notifications n on n.id = l.notification_id
  join crm_private.telegram_destinations d on d.id = l.destination_id
  order by l.leased_at, l.id;
end;
$$;

revoke all on function public.service_claim_telegram_notifications(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_claim_telegram_notifications(text,integer,integer)
  to service_role;

create or replace function public.service_record_telegram_notification_result(
  p_delivery_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_delivery crm_private.telegram_notification_deliveries%rowtype;
  v_attempt integer;
  v_status text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram notification acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'Telegram notification result is required' using errcode = '22023';
  end if;
  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Telegram result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select x.* into v_delivery
  from crm_private.telegram_notification_deliveries x
  where x.id = p_delivery_id
  for update;

  if not found then
    raise exception 'Telegram notification delivery is unavailable' using errcode = '22023';
  end if;

  if v_delivery.status = 'succeeded' and p_succeeded then
    return jsonb_build_object(
      'delivery_id', v_delivery.id,
      'status', 'succeeded',
      'attempt_count', v_delivery.attempt_count,
      'changed', false
    );
  end if;

  if v_delivery.status <> 'leased' or v_delivery.leased_by is distinct from p_worker_id then
    raise exception 'Telegram notification lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt := v_delivery.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'
    when v_attempt >= v_delivery.max_attempts then 'dead'
    else 'failed'
  end;

  update crm_private.telegram_notification_deliveries x
  set status = v_status,
      attempt_count = v_attempt,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then x.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_delivery.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where x.id = v_delivery.id;

  update crm_private.telegram_destinations d
  set last_success_at = case when p_succeeded then now() else d.last_success_at end,
      last_error_at = case when p_succeeded then d.last_error_at else now() end,
      updated_at = now()
  where d.id = v_delivery.destination_id;

  update crm_private.profile_notification_targets t
  set last_success_at = case when p_succeeded then now() else t.last_success_at end,
      last_error_at = case when p_succeeded then t.last_error_at else now() end
  where t.profile_id = v_delivery.profile_id
    and t.channel = 'telegram';

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'status', v_status,
    'attempt_count', v_attempt,
    'changed', true
  );
end;
$$;

revoke all on function public.service_record_telegram_notification_result(uuid,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_telegram_notification_result(uuid,text,boolean,text)
  to service_role;
