-- Fix the final Google Contacts claim-time E.164 validation path and safely
-- replay only jobs that were previously acknowledged as skipped_invalid before
-- any Google provider request was attempted.
--
-- The original claim function used a standard SQL regex string whose escaped
-- plus was normalized incorrectly. The enqueue and reconciliation paths were
-- already corrected in 20260920062000; this migration makes the leased claim
-- validation use the same explicit escape-string semantics.

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
      and c.phone_normalized ~ E'^\\+[1-9][0-9]{7,14}$'
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
  'Backend-only leased claim for Google Contacts projection. Returns the current minimal client contact projection only after authoritative ownership/link checks using explicit E.164 escaping.';

-- These rows are safe to replay because skipped_invalid is emitted before
-- route/token/provider resolution and therefore before any Google API request.
-- Requeue only rows whose authoritative CRM state is still eligible.
with skipped_invalid as (
  select distinct l.outbox_id
  from public.activity_log l
  where l.event_type = 'outbox.succeeded'
    and l.metadata ->> 'kind' = 'google_contact_create'
    and l.metadata ->> 'result_code' = 'skipped_invalid'
    and l.outbox_id is not null
),
eligible as (
  select o.id
  from public.integration_outbox o
  join skipped_invalid s on s.outbox_id = o.id
  join public.clients c on c.id = o.client_id
  join public.artists a
    on a.id = o.artist_id
   and a.is_active
   and a.workspace_id = c.workspace_id
  where o.kind = 'google_contact_create'::public.outbox_kind
    and o.status = 'succeeded'::public.outbox_status
    and c.archived_at is null
    and btrim(c.full_name) <> ''
    and c.phone_normalized ~ E'^\\+[1-9][0-9]{7,14}$'
    and o.payload ->> 'client_id' = c.id::text
    and exists (
      select 1
      from public.communication_conversations cc
      where cc.artist_id = o.artist_id
        and cc.client_id = c.id
        and cc.channel = 'whatsapp'::public.communication_channel
        and cc.link_state = 'linked'::public.communication_link_state
    )
)
update public.integration_outbox o
set status = 'pending'::public.outbox_status,
    next_attempt_at = now(),
    leased_by = null,
    leased_at = null,
    lease_expires_at = null,
    last_error_code = null,
    updated_at = now()
from eligible e
where o.id = e.id;
