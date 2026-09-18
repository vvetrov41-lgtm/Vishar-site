-- Automatic Google Contacts projection for authoritatively linked WhatsApp clients.
--
-- Safety model:
-- * WhatsApp ingestion/linkage never calls Google.
-- * Only a linked CRM client can enqueue work.
-- * Provider routing remains per-artist and reuses the existing pinned Google
--   account/token envelope.
-- * Contacts projection is inert until the OAuth callback explicitly enables
--   google_contacts_sync in the artist's Google integration configuration.
-- * No client PII is copied into the outbox payload or dedupe key.

create or replace function crm_private.google_contacts_sync_enabled(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.artist_integrations i
    join public.artists a
      on a.id = i.artist_id
     and a.is_active
    where i.artist_id = p_artist_id
      and i.integration_type = 'calendar'::public.artist_integration_type
      and i.provider = 'google'
      and i.integration_key = 'google_calendar_' || a.slug
      and i.is_enabled
      and i.configuration ->> 'google_contacts_sync' = 'true'
  );
$$;

revoke all on function crm_private.google_contacts_sync_enabled(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.google_contacts_sync_enabled(uuid) is
  'Private fail-closed check for the explicit Google Contacts projection capability on an active artist Google integration.';

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
      and c.phone_normalized ~ '^\\+[1-9][0-9]{7,14}$'
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
    'google-contact-create:' || p_artist_id::text || ':' || p_client_id::text,
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
  'Private idempotent enqueue for a valid linked WhatsApp client. The outbox payload contains IDs only; provider PII is read later from authoritative CRM state.';

create or replace function crm_private.enqueue_linked_whatsapp_google_contact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.channel <> 'whatsapp'::public.communication_channel
     or new.link_state <> 'linked'::public.communication_link_state
     or new.client_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.client_id is not distinct from new.client_id
     and old.link_state is not distinct from new.link_state then
    return new;
  end if;

  -- Provider projection must never make communication ingestion/linkage fail.
  begin
    perform crm_private.enqueue_google_contact_create(new.artist_id, new.client_id);
  exception when others then
    null;
  end;

  return new;
end;
$$;

revoke all on function crm_private.enqueue_linked_whatsapp_google_contact()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_conversations_enqueue_google_contact
  on public.communication_conversations;

create trigger communication_conversations_enqueue_google_contact
after insert or update of client_id, link_state
on public.communication_conversations
for each row
execute function crm_private.enqueue_linked_whatsapp_google_contact();

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
      and c.phone_normalized ~ '^\\+[1-9][0-9]{7,14}$'
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
      'google-contact-create:' || p_artist_id::text || ':' || e.client_id::text,
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
  'Private bounded reconciliation that queues eligible already-linked WhatsApp clients after Google Contacts permission is enabled.';

create or replace function public.set_google_contacts_sync(
  p_artist_id uuid,
  p_integration_key text,
  p_is_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug text;
  v_integration public.artist_integrations%rowtype;
  v_reconciled integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Google Contacts metadata is backend-only'
      using errcode = '42501';
  end if;

  if p_artist_id is null or p_is_enabled is null then
    raise exception 'Google Contacts metadata is incomplete'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_artist_id);

  select a.slug into v_slug
  from public.artists a
  where a.id = p_artist_id
    and a.is_active;

  if v_slug is null
     or p_integration_key is distinct from ('google_calendar_' || v_slug) then
    raise exception 'Google Contacts integration route is invalid'
      using errcode = '22023';
  end if;

  select i.* into v_integration
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'calendar'::public.artist_integration_type
    and i.provider = 'google'
    and i.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'Google integration is unavailable'
      using errcode = '55000';
  end if;

  if p_is_enabled and (
    not v_integration.is_enabled
    or nullif(btrim(coalesce(v_integration.external_account_label, '')), '') is null
  ) then
    raise exception 'Google integration must be connected before Contacts sync'
      using errcode = '55000';
  end if;

  update public.artist_integrations i
  set configuration = jsonb_set(
        coalesce(i.configuration, '{}'::jsonb),
        '{google_contacts_sync}',
        to_jsonb(p_is_enabled),
        true
      ),
      updated_at = now()
  where i.id = v_integration.id;

  if p_is_enabled then
    v_reconciled := crm_private.reconcile_google_contact_sync(p_artist_id);
  end if;

  perform crm_private.log_activity(
    case
      when p_is_enabled then 'integration.google_contacts_enabled'
      else 'integration.google_contacts_disabled'
    end,
    'worker',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object(
      'artist_id', p_artist_id,
      'integration_key', p_integration_key,
      'is_enabled', p_is_enabled,
      'reconciled_jobs', v_reconciled
    )
  );

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'integration_key', p_integration_key,
    'is_enabled', p_is_enabled,
    'reconciled_jobs', v_reconciled
  );
end;
$$;

revoke all on function public.set_google_contacts_sync(uuid,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_google_contacts_sync(uuid,text,boolean)
  to service_role;

comment on function public.set_google_contacts_sync(uuid,text,boolean) is
  'Backend-only capability switch for automatic Google Contacts projection on the existing pinned per-artist Google integration. Enabling reconciles existing linked WhatsApp clients.';

create index if not exists integration_outbox_google_contacts_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind = 'google_contact_create'::public.outbox_kind
    and status in (
      'pending'::public.outbox_status,
      'failed'::public.outbox_status,
      'leased'::public.outbox_status
    );

create or replace function public.claim_google_contact_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  client_id uuid,
  attempt_count integer,
  max_attempts integer,
  client_display_name text,
  phone_normalized text,
  email_normalized text,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Google Contacts outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Google Contacts worker id is invalid'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'Google Contacts claim limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Google Contacts lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind = 'google_contact_create'::public.outbox_kind
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'leased' and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit p_limit
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id,
    l.artist_id,
    l.kind,
    l.client_id,
    l.attempt_count,
    l.max_attempts,
    c.full_name,
    c.phone_normalized,
    c.email_normalized,
    (
      c.id is not null
      and c.archived_at is null
      and a.id is not null
      and a.is_active
      and a.workspace_id = c.workspace_id
      and btrim(c.full_name) <> ''
      and c.phone_normalized ~ '^\\+[1-9][0-9]{7,14}$'
      and l.payload ->> 'client_id' = c.id::text
      and exists (
        select 1
        from public.communication_conversations cc
        where cc.artist_id = l.artist_id
          and cc.client_id = c.id
          and cc.channel = 'whatsapp'::public.communication_channel
          and cc.link_state = 'linked'::public.communication_link_state
      )
    ) as job_valid
  from leased l
  left join public.clients c on c.id = l.client_id
  left join public.artists a on a.id = l.artist_id
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_google_contact_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_google_contact_outbox(text,integer,integer)
  to service_role;

comment on function public.claim_google_contact_outbox(text,integer,integer) is
  'Backend-only leased claim for Google Contacts projection. Returns the current minimal client contact projection only after authoritative ownership/link checks.';

create or replace function public.record_google_contact_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_result_code text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_attempt_count integer;
  v_status public.outbox_status;
  v_terminal boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Google Contacts outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Google Contacts worker id is invalid'
      using errcode = '22023';
  end if;

  if p_succeeded is null then
    raise exception 'Google Contacts result is required'
      using errcode = '22023';
  end if;

  if p_succeeded then
    if p_result_code not in ('created', 'existing', 'skipped_invalid') then
      raise exception 'successful Google Contacts result code is invalid'
        using errcode = '22023';
    end if;
  elsif coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Google Contacts result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'google_contact_create'::public.outbox_kind
  for update;

  if not found then
    raise exception 'Google Contacts outbox job is unavailable'
      using errcode = '22023';
  end if;

  if v_job.status = 'succeeded' then
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased'
     or v_job.leased_by is distinct from p_worker_id then
    raise exception 'Google Contacts outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  if p_succeeded then
    v_status := 'succeeded'::public.outbox_status;
  else
    v_terminal := p_error_code in (
      'artist_route_unconfigured',
      'calendar_encryption_key_invalid',
      'calendar_oauth_expired',
      'calendar_provider_rejected',
      'calendar_scope_missing',
      'calendar_token_invalid',
      'google_account_mismatch',
      'google_contact_job_invalid',
      'google_contacts_not_enabled',
      'google_contacts_permission_denied',
      'google_contacts_provider_rejected',
      'google_contacts_scope_missing',
      'provider_route_invalid'
    );

    v_status := case
      when v_terminal or v_attempt_count >= v_job.max_attempts
        then 'dead'::public.outbox_status
      else 'failed'::public.outbox_status
    end;
  end if;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then o.next_attempt_at
        when p_error_code = 'google_contacts_create_result_unknown'
          then now() + interval '5 minutes'
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

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker',
    null,
    v_job.client_id,
    null,
    null,
    null,
    null,
    null,
    null,
    p_outbox_id,
    jsonb_build_object(
      'kind', 'google_contact_create',
      'attempt_count', v_attempt_count,
      'result_code', case when p_succeeded then p_result_code else null end,
      'error_code', case when p_succeeded then null else p_error_code end
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true,
    'result_code', case when p_succeeded then p_result_code else null end,
    'error_code', case when p_succeeded then null else p_error_code end
  );
end;
$$;

revoke all on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text)
  to service_role;

comment on function public.record_google_contact_outbox_result(uuid,text,boolean,text,text) is
  'Backend-only lease-bound Google Contacts acknowledgement with bounded retry/dead-letter semantics and PII-free activity metadata.';

-- Extend the existing authoritative provider resolver without creating a second
-- Google credential/integration row. Contacts is a capability of the same
-- pinned Google account, and the explicit configuration flag must be true.
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
    raise exception 'outbox id is required'
      using errcode = '22023';
  end if;

  select o.artist_id, o.kind into v_artist_id, v_kind
  from public.integration_outbox o
  where o.id = p_outbox_id;

  if not found then
    raise exception 'outbox route is unavailable'
      using errcode = '22023';
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
    when 'google_contact_create' then 'calendar'::public.artist_integration_type
    when 'whatsapp_message' then 'whatsapp'::public.artist_integration_type
    when 'instagram_message' then 'instagram'::public.artist_integration_type
    else null
  end;

  if v_integration_type is null then
    raise exception 'outbox kind has no provider route'
      using errcode = '22023';
  end if;

  if v_integration_type = 'telegram'::public.artist_integration_type then
    return query
    select o.id, o.artist_id, o.kind, v_integration_type,
           'telegram'::text, 'shared-registry'::text,
           'Shared Telegram registry'::text, '{}'::jsonb
    from public.integration_outbox o
    join crm_private.artist_state a
      on a.artist_id = o.artist_id and a.is_active
    where o.id = p_outbox_id
      and exists (
        select 1
        from crm_private.telegram_destinations d
        where d.artist_id = o.artist_id
          and d.destination_kind = 'artist'
          and d.is_active
      );

    if found then
      return;
    end if;
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
  where o.id = p_outbox_id
    and (
      v_kind <> 'google_contact_create'::public.outbox_kind
      or (
        i.provider = 'google'
        and i.configuration ->> 'google_contacts_sync' = 'true'
      )
    );

  if not found then
    raise exception 'artist provider route is unavailable'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_outbox_route(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_outbox_route(uuid)
  to service_role;

comment on function public.resolve_outbox_route(uuid) is
  'Backend-only outbox provider resolver. Google Contacts jobs reuse the owning artist pinned Google integration only when explicit Contacts sync capability is enabled.';


-- Google connection status includes both Calendar and Contacts projection
-- health. Existing Calendar-only OAuth tokens intentionally surface a safe
-- reconnect-required error until the new Contacts permission is granted.
create or replace function public.list_calendar_connection_status()
returns table(
  artist_id uuid,
  artist_slug text,
  artist_display_name text,
  provider text,
  integration_key text,
  connected boolean,
  external_account_label text,
  connection_updated_at timestamptz,
  last_successful_sync_at timestamptz,
  queued_jobs integer,
  retrying_jobs integer,
  failed_jobs integer,
  last_error_code text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with manageable_artists as (
    select
      a.id,
      a.slug,
      a.display_name,
      'google_calendar_' || a.slug as expected_integration_key
    from public.artists a
    where a.is_active
      and public.can_manage_artist_integrations(a.id)
  ),
  google_jobs as (
    select
      o.artist_id,
      count(*) filter (where o.status = 'pending')::integer as queued_jobs,
      count(*) filter (where o.status = 'leased')::integer as retrying_jobs,
      count(*) filter (
        where o.status in ('failed', 'dead')
          and (i.updated_at is null or o.updated_at >= i.updated_at)
      )::integer as failed_jobs
    from public.integration_outbox o
    join manageable_artists a on a.id = o.artist_id
    left join public.artist_integrations i
      on i.artist_id = a.id
     and i.integration_type = 'calendar'
     and i.provider = 'google'
     and i.integration_key = a.expected_integration_key
    where o.kind in (
      'calendar_create',
      'calendar_update',
      'calendar_cancel',
      'calendar_availability_create',
      'calendar_availability_update',
      'calendar_availability_cancel',
      'google_contact_create'
    )
    group by o.artist_id
  ),
  successful_syncs as (
    select s.artist_id, s.calendar_last_synced_at
    from public.sessions s
    join manageable_artists a on a.id = s.artist_id
    where s.calendar_last_synced_at is not null
    union all
    select b.artist_id, b.calendar_last_synced_at
    from public.artist_availability_blocks b
    join manageable_artists a on a.id = b.artist_id
    where b.calendar_last_synced_at is not null
  ),
  calendar_sync as (
    select artist_id, max(calendar_last_synced_at) as last_successful_sync_at
    from successful_syncs
    group by artist_id
  )
  select
    a.id as artist_id,
    a.slug as artist_slug,
    a.display_name as artist_display_name,
    coalesce(i.provider, 'google') as provider,
    a.expected_integration_key as integration_key,
    coalesce(i.is_enabled, false) as connected,
    i.external_account_label,
    i.updated_at as connection_updated_at,
    s.last_successful_sync_at,
    coalesce(j.queued_jobs, 0) as queued_jobs,
    coalesce(j.retrying_jobs, 0) as retrying_jobs,
    coalesce(j.failed_jobs, 0) as failed_jobs,
    coalesce(
      e.last_error_code,
      case
        when coalesce(i.is_enabled, false)
          and coalesce(i.configuration ->> 'google_contacts_sync', 'false') <> 'true'
          then 'google_contacts_scope_missing'
        else null
      end
    ) as last_error_code
  from manageable_artists a
  left join public.artist_integrations i
    on i.artist_id = a.id
   and i.integration_type = 'calendar'
   and i.provider = 'google'
   and i.integration_key = a.expected_integration_key
  left join google_jobs j on j.artist_id = a.id
  left join calendar_sync s on s.artist_id = a.id
  left join lateral (
    select o.last_error_code
    from public.integration_outbox o
    where o.artist_id = a.id
      and o.kind in (
        'calendar_create',
        'calendar_update',
        'calendar_cancel',
        'calendar_availability_create',
        'calendar_availability_update',
        'calendar_availability_cancel',
        'google_contact_create'
      )
      and o.status in ('failed', 'dead')
      and o.last_error_code is not null
      and (i.updated_at is null or o.updated_at >= i.updated_at)
    order by o.updated_at desc, o.id desc
    limit 1
  ) e on true
  order by a.display_name, a.slug;
$$;

comment on function public.list_calendar_connection_status() is
  'Authorized Google integration status including Calendar and automatic Google Contacts projection health; Calendar-only legacy consent surfaces reconnect required until Contacts is granted.';
