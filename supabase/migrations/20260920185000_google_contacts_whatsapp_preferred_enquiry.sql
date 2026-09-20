-- Allow an explicit WhatsApp preference on a trusted enquiry to qualify the
-- attached CRM client for the existing Google Contacts projection.
--
-- Safety:
-- * Browser input never selects artist/workspace/provider credentials.
-- * The durable enquiry row is accepted only when its immutable submitted phone
--   normalizes to the attached client's current canonical phone.
-- * Identifier-conflict enquiries are never an eligibility proof.
-- * Existing linked WhatsApp conversations remain an independent eligibility
--   proof.
-- * Enquiry intake never depends on the outbox/provider path.

create or replace function crm_private.google_contact_client_eligible(
  p_artist_id uuid,
  p_client_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
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
      and (
        exists (
          select 1
          from public.communication_conversations cc
          where cc.artist_id = p_artist_id
            and cc.client_id = p_client_id
            and cc.channel = 'whatsapp'::public.communication_channel
            and cc.link_state = 'linked'::public.communication_link_state
        )
        or exists (
          select 1
          from public.enquiries e
          where e.artist_id = p_artist_id
            and e.client_id = p_client_id
            and e.archived_at is null
            and e.submitted_preferred_contact = 'WhatsApp'
            and not e.client_identifier_conflict
            and public.normalize_phone(e.submitted_phone) = c.phone_normalized
        )
      )
  );
$$;

revoke all on function crm_private.google_contact_client_eligible(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.google_contact_client_eligible(uuid,uuid) is
  'Private fail-closed Google Contact eligibility check. Accepts either an authoritative linked WhatsApp conversation or a non-conflicting WhatsApp-preferred enquiry whose submitted phone matches the client canonical phone.';

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

  if not crm_private.google_contact_client_eligible(p_artist_id, p_client_id) then
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
  'Private idempotent enqueue for an eligible Google Contacts client. Eligibility can come from a linked WhatsApp conversation or a trusted matching WhatsApp-preferred enquiry; outbox payload stores IDs only.';

create or replace function crm_private.enqueue_whatsapp_preferred_enquiry_google_contact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.submitted_preferred_contact is distinct from 'WhatsApp'
     or new.client_id is null
     or new.artist_id is null
     or coalesce(new.client_identifier_conflict, false) then
    return new;
  end if;

  -- Contact projection must never make durable enquiry intake fail.
  begin
    perform crm_private.enqueue_google_contact_create(new.artist_id, new.client_id);
  exception when others then
    null;
  end;

  return new;
end;
$$;

revoke all on function crm_private.enqueue_whatsapp_preferred_enquiry_google_contact()
  from public, anon, authenticated, service_role;

drop trigger if exists enquiries_enqueue_google_contact
  on public.enquiries;

create trigger enquiries_enqueue_google_contact
after insert
on public.enquiries
for each row
execute function crm_private.enqueue_whatsapp_preferred_enquiry_google_contact();

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
    select c.id as client_id
    from public.clients c
    join public.artists a
      on a.id = p_artist_id
     and a.is_active
     and a.workspace_id = c.workspace_id
    where crm_private.google_contact_client_eligible(p_artist_id, c.id)
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
  'Private bounded reconciliation for all currently eligible Google Contacts clients, including linked WhatsApp and trusted matching WhatsApp-preferred enquiry paths.';

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
      and l.payload ->> 'client_id' = c.id::text
      and crm_private.google_contact_client_eligible(l.artist_id, c.id)
    ) as job_valid
  from leased l
  left join public.clients c on c.id = l.client_id
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_google_contact_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_google_contact_outbox(text,integer,integer)
  to service_role;

comment on function public.claim_google_contact_outbox(text,integer,integer) is
  'Backend-only leased claim for Google Contacts projection. Revalidates authoritative client eligibility at processing time across linked-WhatsApp and matching WhatsApp-preferred enquiry paths.';
