-- Email conversation history is detected automatically from Gmail.
--
-- Root cause of "email-only clients have no conversation channel": the Gmail
-- metadata snapshot (run by the shared production cron) listed mailboxes by
-- reading public.artist_integrations directly with the backend key. That
-- table has never been granted to service_role, so every run got HTTP 403 and
-- no snapshot row was ever written.
--
-- This migration
--   1. lists Gmail mailboxes through a backend-only RPC;
--   2. keeps a durable per-client "last Gmail message" record, because the
--      snapshot only covers 30 days and deletes older rows;
--   3. lets the worker look up older Gmail history for clients with upcoming
--      appointments (one newest-message lookup per client, at most daily);
--   4. makes that durable record the Email conversation evidence for booking
--      cards, and dispatches a waiting card when it appears.
-- Only timestamps and direction are stored: no subject, body, address or
-- provider id. The form's "preferred contact" is still never evidence.

-- ---------------------------------------------------------------------------
-- 1. Gmail mailboxes for the backend
-- ---------------------------------------------------------------------------

create or replace function public.service_list_gmail_mailboxes()
returns table (
  artist_id uuid,
  integration_key text,
  external_account_label text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail mailbox listing is backend-only' using errcode = '42501';
  end if;

  return query
  select i.artist_id, i.integration_key, lower(btrim(i.external_account_label))
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
    and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null
  order by i.artist_id;
end;
$$;

revoke all on function public.service_list_gmail_mailboxes()
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_gmail_mailboxes() to service_role;

comment on function public.service_list_gmail_mailboxes() is
  'Backend-only list of enabled Gmail mailboxes (artist, integration key, mailbox address). No tokens, no message data.';

-- ---------------------------------------------------------------------------
-- 2. Durable last Gmail message per client
-- ---------------------------------------------------------------------------

create table crm_private.gmail_client_email_activity (
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  last_message_at timestamptz,
  last_direction text check (last_direction is null or last_direction in ('inbound', 'outbound')),
  history_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (artist_id, client_id),
  constraint gmail_client_email_activity_direction_shape check (
    (last_message_at is null) = (last_direction is null)
  )
);

alter table crm_private.gmail_client_email_activity enable row level security;
revoke all on crm_private.gmail_client_email_activity
  from public, anon, authenticated, service_role;

comment on table crm_private.gmail_client_email_activity is
  'Newest Gmail message time and direction between an artist mailbox and a known client. No content, address or provider id. Kept after the 30-day snapshot forgets it.';

create or replace function crm_private.note_gmail_client_email_activity(
  p_artist_id uuid,
  p_client_id uuid,
  p_last_message_at timestamptz,
  p_direction text,
  p_history_checked boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_artist_id is null or p_client_id is null then
    return;
  end if;
  if p_last_message_at is not null
     and (p_direction is null or p_direction not in ('inbound', 'outbound')
          or p_last_message_at > now() + interval '5 minutes') then
    raise exception 'Gmail activity is invalid' using errcode = '22023';
  end if;

  insert into crm_private.gmail_client_email_activity as a (
    artist_id, client_id, last_message_at, last_direction, history_checked_at, updated_at
  ) values (
    p_artist_id, p_client_id, p_last_message_at,
    case when p_last_message_at is null then null else p_direction end,
    case when p_history_checked then now() end,
    now()
  )
  on conflict (artist_id, client_id) do update
  set last_message_at = case
        when excluded.last_message_at is not null
         and (a.last_message_at is null or excluded.last_message_at > a.last_message_at)
          then excluded.last_message_at
        else a.last_message_at
      end,
      last_direction = case
        when excluded.last_message_at is not null
         and (a.last_message_at is null or excluded.last_message_at > a.last_message_at)
          then excluded.last_direction
        else a.last_direction
      end,
      history_checked_at = coalesce(excluded.history_checked_at, a.history_checked_at),
      updated_at = now();
end;
$$;

revoke all on function crm_private.note_gmail_client_email_activity(uuid, uuid, timestamptz, text, boolean)
  from public, anon, authenticated, service_role;

create or replace function crm_private.note_gmail_snapshot_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.last_message_at is not null and new.direction in ('inbound', 'outbound') then
    perform crm_private.note_gmail_client_email_activity(
      new.artist_id, new.client_id, least(new.last_message_at, now()), new.direction, false
    );
  end if;
  return null;
end;
$$;

revoke all on function crm_private.note_gmail_snapshot_activity()
  from public, anon, authenticated, service_role;

drop trigger if exists gmail_client_metadata_snapshots_note_activity
  on public.gmail_client_metadata_snapshots;
create trigger gmail_client_metadata_snapshots_note_activity
after insert or update of last_message_at on public.gmail_client_metadata_snapshots
for each row execute function crm_private.note_gmail_snapshot_activity();

-- ---------------------------------------------------------------------------
-- 3. Older history for clients with upcoming appointments
-- ---------------------------------------------------------------------------

create or replace function public.service_list_gmail_history_candidates(
  p_artist_id uuid,
  p_limit integer default 10
)
returns table (
  client_id uuid,
  client_email text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail history candidates are backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or coalesce(p_limit, 0) < 1 or p_limit > 25 then
    raise exception 'invalid Gmail history candidate request' using errcode = '22023';
  end if;

  return query
  select c.id, lower(btrim(c.email))
  from public.clients c
  join lateral (
    select min(s.start_at) as next_start
    from public.sessions s
    where s.client_id = c.id
      and s.artist_id = p_artist_id
      and s.status = 'confirmed'::public.session_status
      and s.cancelled_at is null
      and s.start_at > now()
      and s.appointment_type in (
        'tattoo_session'::public.appointment_type,
        'in_person_consultation'::public.appointment_type
      )
  ) upcoming on upcoming.next_start is not null
  left join crm_private.gmail_client_email_activity a
    on a.artist_id = p_artist_id and a.client_id = c.id
  where c.archived_at is null
    and nullif(btrim(coalesce(c.email, '')), '') is not null
    and (a.history_checked_at is null or a.history_checked_at < now() - interval '1 day')
  order by upcoming.next_start, c.id
  limit p_limit;
end;
$$;

revoke all on function public.service_list_gmail_history_candidates(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_gmail_history_candidates(uuid, integer) to service_role;

create or replace function public.service_record_gmail_client_history(
  p_artist_id uuid,
  p_client_id uuid,
  p_last_message_at timestamptz,
  p_direction text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail history recording is backend-only' using errcode = '42501';
  end if;
  -- Only a client this artist genuinely works with.
  if p_artist_id is null or p_client_id is null or not exists (
    select 1 from public.sessions s
    where s.client_id = p_client_id and s.artist_id = p_artist_id
    union all
    select 1 from public.enquiries e
    where e.client_id = p_client_id and e.artist_id = p_artist_id
  ) then
    raise exception 'Gmail history target is unavailable' using errcode = '22023';
  end if;

  perform crm_private.note_gmail_client_email_activity(
    p_artist_id, p_client_id, p_last_message_at, p_direction, true
  );
end;
$$;

revoke all on function public.service_record_gmail_client_history(uuid, uuid, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_client_history(uuid, uuid, timestamptz, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Booking card Email evidence reads the durable record
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

    select 'email', 'gmail_thread', g.id, null::uuid, g.created_at
    from crm_private.gmail_thread_contexts g
    where g.client_id = p_client_id
      and g.artist_id = p_artist_id

    union all

    -- Automatic: the Gmail snapshot and history lookup, kept durably.
    select 'email', 'gmail_metadata', null::uuid, null::uuid, a.last_message_at
    from crm_private.gmail_client_email_activity a
    where a.client_id = p_client_id
      and a.artist_id = p_artist_id
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

-- The waiting-card dispatch moves from the 30-day snapshot to the durable
-- record, which the snapshot trigger above fills first.
drop trigger if exists gmail_client_metadata_snapshots_dispatch_waiting_booking_cards
  on public.gmail_client_metadata_snapshots;

drop trigger if exists gmail_client_email_activity_dispatch_waiting_booking_cards
  on crm_private.gmail_client_email_activity;
create trigger gmail_client_email_activity_dispatch_waiting_booking_cards
after insert or update of last_message_at on crm_private.gmail_client_email_activity
for each row
when (new.last_message_at is not null)
execute function crm_private.dispatch_waiting_booking_cards_from_evidence();
