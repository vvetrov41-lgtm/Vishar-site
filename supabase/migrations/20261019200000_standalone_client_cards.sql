-- 20261019200000_standalone_client_cards.sql
--
-- A client card must be usable without an enquiry, project or session.
--
-- Before this migration the CRM decided "does this client belong to this
-- artist" in four different ways:
--
--   * crm_private.client_in_artist_scope     enquiries, projects, conversations
--   * crm_private.gpt_client_in_artist_scope enquiries, projects, sessions
--   * public.can_access/can_manage_client    enquiries, projects, conversations
--   * crm_private.workflow_artist_from_links enquiries, projects
--
-- create_client_from_communication creates a card whose only relationship is
-- the conversation it was created from. The CRM list therefore showed it, but
-- every GPT read/write and every internal note refused it (not_found,
-- permission_denied, "client has no artist-scoped record").
--
-- The fix keeps clients.workspace_id as the tenant owner and adds an explicit,
-- durable client <-> artist relationship (public.client_artist_links) for
-- cards that start without business records. Every scope predicate now uses
-- one canonical definition: the client and artist share a workspace AND the
-- client has a direct link, enquiry, project, session or conversation with
-- that artist. Cross-workspace access stays structurally impossible.
--
-- Also fixed here:
--   * create_client_from_communication rejected every email address. Its
--     regex was written as '\\.' inside a standard-conforming string, which
--     requires a literal backslash. The same expression elsewhere uses '[.]'.
--   * Duplicate detection by normalised email and phone before a new card is
--     created, idempotent replay, and atomic creation of card + link + consent.
--   * A client-level privacy acknowledgement record that does not depend on an
--     enquiry, with audit time, source and actor. Existing records are never
--     replaced and nothing is back-dated.

-- ---------------------------------------------------------------------------
-- 1. Direct client <-> artist relationship
-- ---------------------------------------------------------------------------

create table public.client_artist_links (
  client_id uuid not null references public.clients(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  source text not null
    check (source in ('communication_client_created', 'communication_linked', 'conversation_backfill')),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (client_id, artist_id)
);

create index client_artist_links_artist_idx
  on public.client_artist_links (artist_id, client_id);

comment on table public.client_artist_links is
  'Direct relationship between a workspace client card and an artist, for cards that exist without an enquiry, project or session. Written only by SECURITY DEFINER CRM functions.';

alter table public.client_artist_links enable row level security;
alter table public.client_artist_links force row level security;

revoke all on table public.client_artist_links from public, anon, authenticated, service_role;
grant select on table public.client_artist_links to authenticated;

create policy client_artist_links_select_artist_scope
  on public.client_artist_links
  for select
  using (crm_private.is_service_backend() or public.can_access_artist(artist_id));

create trigger guard_client_workspace_link
  before insert or update of client_id, artist_id on public.client_artist_links
  for each row execute function crm_private.guard_client_workspace_link();

-- A card that already has a direct link has a tenant; the compatibility
-- adoption path must not move it to another workspace.
create or replace function crm_private.guard_client_workspace_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_client_id uuid;
  v_artist_id uuid;
  v_artist_workspace_id uuid;
  v_client_workspace_id uuid;
begin
  v_client_id := nullif(v_row ->> 'client_id', '')::uuid;
  v_artist_id := nullif(v_row ->> 'artist_id', '')::uuid;

  if v_client_id is null or v_artist_id is null then
    return new;
  end if;

  select a.workspace_id into v_artist_workspace_id
  from public.artists a
  where a.id = v_artist_id and a.is_active;

  select c.workspace_id into v_client_workspace_id
  from public.clients c
  where c.id = v_client_id and c.archived_at is null
  for update;

  if v_artist_workspace_id is null or v_client_workspace_id is null then
    raise exception 'client or artist workspace is unavailable'
      using errcode = '23503';
  end if;

  if v_client_workspace_id = v_artist_workspace_id then
    return new;
  end if;

  -- Compatibility for backend/test code that creates the card before it knows
  -- which artist owns it. Adoption is legal only while the card has no CRM
  -- relationship at all. The first relationship fixes the tenant permanently.
  if not exists (select 1 from public.enquiries e where e.client_id = v_client_id)
     and not exists (select 1 from public.projects p where p.client_id = v_client_id)
     and not exists (select 1 from public.sessions s where s.client_id = v_client_id)
     and not exists (
       select 1 from public.communication_conversations c
       where c.client_id = v_client_id
     )
     and not exists (
       select 1 from public.client_artist_links l
       where l.client_id = v_client_id
     ) then
    update public.clients c
    set workspace_id = v_artist_workspace_id,
        updated_at = now()
    where c.id = v_client_id;
    return new;
  end if;

  raise exception 'client belongs to a different workspace'
    using errcode = '23514';
end;
$$;

revoke all on function crm_private.guard_client_workspace_link()
  from public, anon, authenticated, service_role;

-- Cards that currently exist only through a linked conversation get their
-- direct link now. Conversations are already guarded to the client workspace.
insert into public.client_artist_links (client_id, artist_id, source, created_at)
select distinct on (c.client_id, c.artist_id)
       c.client_id, c.artist_id, 'conversation_backfill', now()
from public.communication_conversations c
join public.clients cl on cl.id = c.client_id
join public.artists a on a.id = c.artist_id
where c.client_id is not null
  and cl.archived_at is null
  and a.is_active
  and cl.workspace_id = a.workspace_id
on conflict (client_id, artist_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. One canonical scope predicate
-- ---------------------------------------------------------------------------

create or replace function crm_private.client_in_artist_scope(p_client_id uuid, p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.clients c
    join public.artists a on a.id = p_artist_id
    where c.id = p_client_id
      and c.workspace_id = a.workspace_id
  ) and (
    exists (
      select 1 from public.client_artist_links l
      where l.client_id = p_client_id and l.artist_id = p_artist_id
    ) or exists (
      select 1 from public.enquiries e
      where e.client_id = p_client_id and e.artist_id = p_artist_id
    ) or exists (
      select 1 from public.projects p
      where p.client_id = p_client_id and p.artist_id = p_artist_id
    ) or exists (
      select 1 from public.sessions s
      where s.client_id = p_client_id and s.artist_id = p_artist_id
    ) or exists (
      select 1 from public.communication_conversations c
      where c.client_id = p_client_id and c.artist_id = p_artist_id
    )
  );
$$;

revoke all on function crm_private.client_in_artist_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_in_artist_scope(uuid, uuid) is
  'Canonical client/artist ownership: same workspace and a direct link, enquiry, project, session or conversation with that artist.';

-- Every artist the client is related to, by the same sources.
create or replace function crm_private.client_artist_ids(p_client_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select distinct x.artist_id
  from (
    select l.artist_id from public.client_artist_links l where l.client_id = p_client_id
    union all
    select e.artist_id from public.enquiries e where e.client_id = p_client_id
    union all
    select p.artist_id from public.projects p where p.client_id = p_client_id
    union all
    select s.artist_id from public.sessions s where s.client_id = p_client_id
    union all
    select c.artist_id from public.communication_conversations c where c.client_id = p_client_id
  ) x
  where x.artist_id is not null;
$$;

revoke all on function crm_private.client_artist_ids(uuid)
  from public, anon, authenticated, service_role;

-- The GPT name is kept for its many callers; it is now the canonical rule.
create or replace function crm_private.gpt_client_in_artist_scope(p_client_id uuid, p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.client_in_artist_scope(p_client_id, p_artist_id);
$$;

revoke all on function crm_private.gpt_client_in_artist_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

-- A client related to another artist too is shared; artist-scoped GPT writes
-- on shared clients stay refused, as before.
create or replace function crm_private.gpt_client_has_other_artist_scope(p_client_id uuid, p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from crm_private.client_artist_ids(p_client_id) a(artist_id)
    where a.artist_id <> p_artist_id
  );
$$;

revoke all on function crm_private.gpt_client_has_other_artist_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

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
      from crm_private.client_artist_ids(p_client_id) x(artist_id)
      join public.artists a on a.id = x.artist_id
      join public.clients c on c.id = p_client_id and c.workspace_id = a.workspace_id
      where public.can_access_artist(x.artist_id)
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
      from crm_private.client_artist_ids(p_client_id) x(artist_id)
      join public.artists a on a.id = x.artist_id
      join public.clients c on c.id = p_client_id and c.workspace_id = a.workspace_id
      where public.can_manage_artist(x.artist_id)
    );
$$;

-- Notes, follow-ups, email drafts and activity resolve the artist from the
-- client when no enquiry/project/session is given. A standalone card now
-- resolves through its direct link or conversation.
create or replace function crm_private.workflow_artist_from_links(
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_artist_count integer;
begin
  perform crm_private.assert_consistent_entity_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );

  v_artist_id := crm_private.resolve_artist_from_links(
    p_enquiry_id, p_project_id, p_session_id
  );

  if v_artist_id is not null then
    return v_artist_id;
  end if;

  if p_client_id is null then
    raise exception 'an artist-scoped workflow requires an enquiry, project, session or client'
      using errcode = '22023';
  end if;

  select count(*)::integer, min(a.artist_id::text)::uuid
    into v_artist_count, v_artist_id
  from crm_private.client_artist_ids(p_client_id) a(artist_id);

  if v_artist_count = 0 then
    raise exception 'client is not linked to an artist'
      using errcode = '22023';
  elsif v_artist_count > 1 then
    raise exception 'client belongs to multiple artist scopes; provide an enquiry, project or session'
      using errcode = '22023';
  end if;

  return v_artist_id;
end;
$$;

revoke all on function crm_private.workflow_artist_from_links(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Client-level privacy acknowledgement
-- ---------------------------------------------------------------------------

create table public.client_privacy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  privacy_notice_version text not null check (btrim(privacy_notice_version) <> ''),
  acknowledged_at timestamptz not null default now(),
  basis text not null default 'staff_confirmed' check (basis in ('staff_confirmed')),
  source text not null
    check (source in ('communication_client_created', 'client_card')),
  recorded_by uuid,
  communication_conversation_id uuid
    references public.communication_conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, artist_id, privacy_notice_version)
);

comment on table public.client_privacy_acknowledgements is
  'Staff-confirmed privacy notice acknowledgement for a client card, independent of any enquiry. Append-only: a later confirmation never replaces or back-dates an earlier one.';

alter table public.client_privacy_acknowledgements enable row level security;
alter table public.client_privacy_acknowledgements force row level security;

revoke all on table public.client_privacy_acknowledgements from public, anon, authenticated, service_role;
grant select on table public.client_privacy_acknowledgements to authenticated;

create policy client_privacy_acknowledgements_select_artist_scope
  on public.client_privacy_acknowledgements
  for select
  using (crm_private.is_service_backend() or public.can_access_artist(artist_id));

create trigger guard_client_workspace_link
  before insert or update of client_id, artist_id on public.client_privacy_acknowledgements
  for each row execute function crm_private.guard_client_workspace_link();

create or replace function crm_private.client_privacy_acknowledgement_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'privacy acknowledgements are append-only' using errcode = '55000';
end;
$$;

revoke all on function crm_private.client_privacy_acknowledgement_immutable()
  from public, anon, authenticated, service_role;

create trigger client_privacy_acknowledgements_immutable
  before update on public.client_privacy_acknowledgements
  for each row execute function crm_private.client_privacy_acknowledgement_immutable();

-- The notice the artist's own booking form currently shows: Kristina's own
-- notice (workers/lib/validation.js KRISTINA_PRIVACY_NOTICE_VERSION), else the
-- version manual CRM intake records.
create or replace function crm_private.staff_privacy_notice_version(p_artist_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when exists (
      select 1 from public.artists a
      where a.id = p_artist_id and a.slug = 'kristina'
    ) then '2026-10-12'
    else '2026-07-29'
  end;
$$;

revoke all on function crm_private.staff_privacy_notice_version(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.record_client_privacy_acknowledgement(
  p_client_id uuid,
  p_artist_id uuid,
  p_source text,
  p_conversation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_version text := crm_private.staff_privacy_notice_version(p_artist_id);
  v_row public.client_privacy_acknowledgements%rowtype;
  v_replayed boolean := false;
begin
  insert into public.client_privacy_acknowledgements (
    client_id, artist_id, privacy_notice_version, acknowledged_at,
    source, recorded_by, communication_conversation_id
  ) values (
    p_client_id, p_artist_id, v_version, now(),
    p_source, auth.uid(), p_conversation_id
  )
  on conflict (client_id, artist_id, privacy_notice_version) do nothing
  returning * into v_row;

  if not found then
    v_replayed := true;
    select x.* into v_row
    from public.client_privacy_acknowledgements x
    where x.client_id = p_client_id
      and x.artist_id = p_artist_id
      and x.privacy_notice_version = v_version;
  else
    perform crm_private.log_artist_activity(
      p_artist_id,
      'client.privacy_acknowledged',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      p_client_id,
      null, null, null, null,
      jsonb_build_object(
        'privacy_notice_version', v_version,
        'basis', v_row.basis,
        'source', p_source
      )
    );
  end if;

  return jsonb_build_object(
    'privacy_notice_version', v_row.privacy_notice_version,
    'privacy_acknowledged_at', v_row.acknowledged_at,
    'privacy_acknowledgement_replayed', v_replayed
  );
end;
$$;

revoke all on function crm_private.record_client_privacy_acknowledgement(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- Operator action on an existing card: the staff member confirms that the
-- client acknowledged the privacy notice. Time and actor are recorded now.
-- A card shared by several artists names the artist whose notice it is.
create or replace function public.record_client_privacy_acknowledgement(
  p_client_id uuid,
  p_artist_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  if p_client_id is null then
    raise exception 'client id is required' using errcode = '22023';
  end if;
  perform crm_private.require_role('owner', 'booking_manager');

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.archived_at is null
  ) then
    raise exception 'client not found' using errcode = 'P0002';
  end if;

  if p_artist_id is null then
    v_artist_id := crm_private.workflow_artist_from_links(p_client_id, null, null, null);
  elsif crm_private.client_in_artist_scope(p_client_id, p_artist_id) then
    v_artist_id := p_artist_id;
  else
    raise exception 'client is not linked to that artist' using errcode = '42501';
  end if;
  perform crm_private.require_artist_access(v_artist_id, 'manage');

  return jsonb_build_object('client_id', p_client_id)
    || crm_private.record_client_privacy_acknowledgement(
         p_client_id, v_artist_id, 'client_card', null
       );
end;
$$;

revoke all on function public.record_client_privacy_acknowledgement(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_client_privacy_acknowledgement(uuid, uuid)
  to authenticated;

comment on function public.record_client_privacy_acknowledgement(uuid, uuid) is
  'Records that staff confirmed the client acknowledged the current privacy notice. Idempotent; never replaces or back-dates an earlier acknowledgement.';

-- ---------------------------------------------------------------------------
-- 4. Creating a client from a conversation
-- ---------------------------------------------------------------------------

create or replace function public.create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_instagram text,
  p_privacy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_existing public.clients%rowtype;
  v_workspace_id uuid;
  v_full_name text;
  v_email text;
  v_email_norm text;
  v_phone text;
  v_phone_norm text;
  v_instagram text;
  v_client_id uuid;
  v_duplicate_id uuid;
  v_replayed boolean := false;
  v_privacy jsonb := '{}'::jsonb;
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

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = v_conversation.artist_id;
  if v_workspace_id is null then
    raise exception 'conversation workspace is unavailable' using errcode = '23503';
  end if;

  v_full_name := left(btrim(coalesce(p_full_name, '')), 160);
  if v_full_name = '' then
    raise exception 'a client name is required' using errcode = '22023';
  end if;

  v_email := left(nullif(btrim(coalesce(p_email, '')), ''), 320);
  if v_email is not null then
    v_email_norm := public.normalize_email(v_email);
    if v_email_norm is null
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
      raise exception 'that email address is not valid' using errcode = '22023';
    end if;
  end if;

  v_phone := left(nullif(btrim(coalesce(p_phone, '')), ''), 80);
  v_phone_norm := crm_private.client_phone_e164(v_phone, null);
  v_instagram := left(nullif(btrim(coalesce(p_instagram, '')), ''), 80);

  if v_instagram is null
     and v_conversation.channel = 'instagram'::public.communication_channel
     and v_conversation.external_username is not null then
    v_instagram := '@' || v_conversation.external_username;
  end if;

  if v_conversation.client_id is not null then
    -- A retry of the same operator action (double submit, network retry)
    -- returns the card it already created instead of failing or duplicating.
    select cl.* into v_existing
    from public.clients cl
    where cl.id = v_conversation.client_id;
    -- Only a card this conversation's own create action produced, with the
    -- same name and normalised identifiers, is a retry. A conversation
    -- linked to an existing client keeps being refused.
    if v_existing.archived_at is not null
       or lower(v_existing.full_name) <> lower(v_full_name)
       or v_existing.email_normalized is distinct from v_email_norm
       or v_existing.phone_normalized is distinct from v_phone_norm
       or not exists (
         select 1 from public.activity_log l
         where l.client_id = v_existing.id
           and l.artist_id = v_conversation.artist_id
           and l.event_type = 'communication.client_created'
           and l.metadata ->> 'conversation' = v_conversation.id::text
       ) then
      raise exception 'this conversation is already linked to a client'
        using errcode = '23514';
    end if;
    v_client_id := v_existing.id;
    v_replayed := true;
  else
    -- Duplicate check by normalised identifiers inside the tenant. The
    -- operator links the existing card instead of creating a second one.
    perform pg_advisory_xact_lock(hashtextextended(identifier, 0))
    from unnest(array[
      case when v_email_norm is not null
        then 'workspace:' || v_workspace_id::text || ':email:' || v_email_norm end,
      case when v_phone_norm is not null
        then 'workspace:' || v_workspace_id::text || ':phone:' || v_phone_norm end
    ]) as identifiers(identifier)
    where identifier is not null
    order by identifier;

    select c.id into v_duplicate_id
    from public.clients c
    where c.workspace_id = v_workspace_id
      and c.archived_at is null
      and (
        (v_email_norm is not null and c.email_normalized = v_email_norm)
        or (v_phone_norm is not null and c.phone_normalized = v_phone_norm)
      )
    order by c.created_at, c.id
    limit 1;

    if v_duplicate_id is not null then
      raise exception 'a client with this email or phone already exists'
        using errcode = '23505',
              hint = 'Link the existing client to this conversation instead.';
    end if;

    insert into public.clients (workspace_id, full_name, email, phone, instagram)
    values (v_workspace_id, v_full_name, v_email, v_phone, v_instagram)
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
  end if;

  insert into public.client_artist_links (client_id, artist_id, source, created_by)
  values (v_client_id, v_conversation.artist_id, 'communication_client_created', auth.uid())
  on conflict (client_id, artist_id) do nothing;

  if coalesce(p_privacy_acknowledged, false) then
    v_privacy := crm_private.record_client_privacy_acknowledgement(
      v_client_id, v_conversation.artist_id,
      'communication_client_created', v_conversation.id
    );
  end if;

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'client_id', v_client_id,
    'link_state', 'linked',
    'replayed', v_replayed
  ) || v_privacy;
end;
$$;

revoke all on function public.create_client_from_communication(uuid, text, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_client_from_communication(uuid, text, text, text, text, boolean)
  to authenticated;

comment on function public.create_client_from_communication(uuid, text, text, text, text, boolean) is
  'Operator action creating a standalone client card from an unmatched conversation, linking it to the conversation artist, and optionally recording a staff-confirmed privacy acknowledgement. Atomic and idempotent; refuses duplicates by normalised email or phone.';

-- The five-argument contract stays for existing callers.
create or replace function public.create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_instagram text default null
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.create_client_from_communication(
    p_conversation_id, p_full_name, p_email, p_phone, p_instagram, false
  );
$$;

revoke all on function public.create_client_from_communication(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_client_from_communication(uuid, text, text, text, text)
  to authenticated;

create or replace function public.gpt_create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_instagram text,
  p_privacy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conversation public.communication_conversations%rowtype;
  v_crm_artist_id uuid;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);
  -- Creating a client is a CRM action that happens to start in the inbox.
  -- The communications ceiling alone must not hand a GPT client the CRM
  -- intake its owner deliberately left off, so both apply here.
  select c.artist_id into v_crm_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  if v_crm_artist_id is distinct from v_conversation.artist_id then
    raise exception 'this conversation is outside the active GPT artist scope'
      using errcode = '42501';
  end if;
  return public.create_client_from_communication(
    v_conversation.id, p_full_name, p_email, p_phone, p_instagram,
    coalesce(p_privacy_acknowledged, false)
  );
end;
$$;

revoke all on function public.gpt_create_client_from_communication(uuid, text, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_create_client_from_communication(uuid, text, text, text, text, boolean)
  to authenticated;

comment on function public.gpt_create_client_from_communication(uuid, text, text, text, text, boolean) is
  'Creates a standalone CRM client from one artist-pinned conversation through the existing CRM contract, optionally with a staff-confirmed privacy acknowledgement.';

create or replace function public.gpt_create_client_from_communication(
  p_conversation_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_instagram text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.gpt_create_client_from_communication(
    p_conversation_id, p_full_name, p_email, p_phone, p_instagram, false
  );
$$;

revoke all on function public.gpt_create_client_from_communication(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_create_client_from_communication(uuid, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Linking an existing client to a conversation
-- ---------------------------------------------------------------------------

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

  insert into public.client_artist_links (client_id, artist_id, source, created_by)
  values (p_client_id, v_conversation.artist_id, 'communication_linked', auth.uid())
  on conflict (client_id, artist_id) do nothing;

  -- Repeating the same operator link is a no-op: no second audit row, no
  -- state churn. Confirming an automatic match still records the operator.
  if v_conversation.client_id = p_client_id
     and v_conversation.link_state = 'linked'::public.communication_link_state
     and v_conversation.auto_linked_at is null then
    return jsonb_build_object(
      'conversation_id', v_conversation.id,
      'client_id', p_client_id,
      'link_state', 'linked',
      'replayed', true
    );
  end if;

  update public.communication_conversations c
  set client_id = p_client_id,
      link_state = 'linked'::public.communication_link_state,
      auto_linked_at = null,
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
    'link_state', 'linked',
    'replayed', false
  );
end;
$$;
