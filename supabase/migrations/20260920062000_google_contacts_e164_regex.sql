-- The original Google Contacts projection used a standard SQL string with two
-- backslashes before "+". With standard_conforming_strings enabled PostgreSQL
-- passed both backslashes to the regex engine, so valid E.164 values never
-- matched. Use an escape string explicitly so the regex receives a single
-- backslash and matches a literal leading plus.

create or replace function crm_private.enqueue_google_contact_create(
  p_artist_id uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_outbox_id uuid;
begin
  if p_artist_id is null or p_client_id is null then
    return null;
  end if;

  if not crm_private.google_contacts_sync_enabled(p_artist_id) then
    return null;
  end if;

  if not exists (
    select 1
    from public.clients c
    join public.artists a
      on a.id = p_artist_id
     and a.is_active
     and a.workspace_id = c.workspace_id
    where c.id = p_client_id
      and c.archived_at is null
      and btrim(c.full_name) <> ''
      and c.phone_normalized ~ E'^\\+[1-9][0-9]{7,14}$'
      and exists (
        select 1
        from public.communication_conversations cc
        where cc.artist_id = p_artist_id
          and cc.client_id = p_client_id
          and cc.channel = 'whatsapp'::public.communication_channel
          and cc.link_state = 'linked'::public.communication_link_state
      )
  ) then
    return null;
  end if;

  insert into public.integration_outbox (
    kind,
    dedupe_key,
    payload,
    client_id,
    artist_id
  ) values (
    'google_contact_create'::public.outbox_kind,
    'google_contact_create:' || p_artist_id::text || ':' || p_client_id::text,
    jsonb_build_object('client_id', p_client_id),
    p_client_id,
    p_artist_id
  )
  on conflict (dedupe_key) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is not null then
    perform crm_private.log_activity(
      'outbox.created',
      'system',
      null,
      p_client_id,
      null,
      null,
      null,
      null,
      null,
      null,
      v_outbox_id,
      jsonb_build_object('kind', 'google_contact_create')
    );
  end if;

  return v_outbox_id;
end;
$$;

revoke all on function crm_private.enqueue_google_contact_create(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.enqueue_google_contact_create(uuid,uuid) is
  'Private idempotent enqueue for a valid linked WhatsApp client. Uses an explicit E.164 regex escape and stores IDs only in the outbox payload.';

create or replace function crm_private.reconcile_google_contact_sync(p_artist_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_count integer := 0;
begin
  if p_artist_id is null
     or not crm_private.google_contacts_sync_enabled(p_artist_id) then
    return 0;
  end if;

  with eligible as (
    select distinct c.id as client_id
    from public.clients c
    join public.artists a
      on a.id = p_artist_id
     and a.is_active
     and a.workspace_id = c.workspace_id
    join public.communication_conversations cc
      on cc.artist_id = p_artist_id
     and cc.client_id = c.id
     and cc.channel = 'whatsapp'::public.communication_channel
     and cc.link_state = 'linked'::public.communication_link_state
    where c.archived_at is null
      and btrim(c.full_name) <> ''
      and c.phone_normalized ~ E'^\\+[1-9][0-9]{7,14}$'
  ),
  inserted as (
    insert into public.integration_outbox (
      kind,
      dedupe_key,
      payload,
      client_id,
      artist_id
    )
    select
      'google_contact_create'::public.outbox_kind,
      'google_contact_create:' || p_artist_id::text || ':' || e.client_id::text,
      jsonb_build_object('client_id', e.client_id),
      e.client_id,
      p_artist_id
    from eligible e
    on conflict (dedupe_key) do nothing
    returning id, client_id
  ),
  logged as (
    select crm_private.log_activity(
      'outbox.created',
      'system',
      null,
      i.client_id,
      null,
      null,
      null,
      null,
      null,
      null,
      i.id,
      jsonb_build_object('kind', 'google_contact_create', 'reconciled', true)
    )
    from inserted i
  )
  select count(*)::integer into v_count from logged;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function crm_private.reconcile_google_contact_sync(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.reconcile_google_contact_sync(uuid) is
  'Private bounded reconciliation that queues eligible already-linked WhatsApp clients after Google Contacts permission is enabled using an explicit E.164 regex escape.';
