-- 0036_telegram_outbox_automatic_drain.sql
--
-- DB-authoritative rollout cutoff and bounded automatic leasing for new
-- artist-routed Telegram jobs. Existing jobs are excluded by created_at,
-- without updating or enumerating them.
--
-- Forward-only. This migration does not deploy a Worker, create a schedule,
-- call Telegram or change the immediate post-finalisation send path.

create table crm_private.outbox_drain_rollouts (
  kind public.outbox_kind primary key,
  automatic_after timestamptz not null,
  created_at timestamptz not null,
  constraint outbox_drain_rollouts_created_before_cutoff
    check (created_at <= automatic_after)
);

alter table crm_private.outbox_drain_rollouts enable row level security;

revoke all on table crm_private.outbox_drain_rollouts
  from public, anon, authenticated, service_role;

comment on table crm_private.outbox_drain_rollouts is
  'Private rollout watermarks for automatic outbox drains. Direct browser, CRM and service-role table access is denied.';
comment on column crm_private.outbox_drain_rollouts.automatic_after is
  'Only jobs created at or after this DB-authoritative cutoff may be claimed automatically.';

insert into crm_private.outbox_drain_rollouts (
  kind,
  automatic_after,
  created_at
)
select
  'telegram_notification'::public.outbox_kind,
  statement_timestamp(),
  statement_timestamp();

create index if not exists integration_outbox_telegram_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind = 'telegram_notification'
    and status in ('pending', 'failed', 'leased');

create or replace function public.claim_telegram_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  enquiry_id uuid,
  attempt_count integer,
  max_attempts integer,
  reference_number text,
  file_count integer,
  client_conflict boolean,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'Telegram claim limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Telegram lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r
      on r.kind = o.kind
    where o.kind = 'telegram_notification'
      and o.created_at >= r.automatic_after
      and o.attempt_count < o.max_attempts
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
  ),
  projected as (
    select
      l.id,
      l.artist_id,
      l.kind,
      l.enquiry_id,
      l.client_id,
      l.attempt_count,
      l.max_attempts,
      l.next_attempt_at,
      l.created_at,
      e.id as enquiry_row_id,
      e.artist_id as enquiry_artist_id,
      e.client_id as enquiry_client_id,
      e.reference_number,
      e.client_identifier_conflict,
      e.intake_state,
      count(f.id)::integer as authoritative_file_count,
      count(f.id) filter (where f.upload_state <> 'ready')::integer as unready_file_count
    from leased l
    left join public.enquiries e on e.id = l.enquiry_id
    left join public.enquiry_files f on f.enquiry_id = e.id
    group by
      l.id, l.artist_id, l.kind, l.enquiry_id, l.client_id,
      l.attempt_count, l.max_attempts, l.next_attempt_at, l.created_at,
      e.id, e.artist_id, e.client_id, e.reference_number,
      e.client_identifier_conflict, e.intake_state
  )
  select
    p.id,
    p.artist_id,
    p.kind,
    p.enquiry_id,
    p.attempt_count,
    p.max_attempts,
    p.reference_number,
    p.authoritative_file_count,
    p.client_identifier_conflict,
    (
      p.enquiry_row_id is not null
      and p.enquiry_id = p.enquiry_row_id
      and p.artist_id = p.enquiry_artist_id
      and p.client_id = p.enquiry_client_id
      and p.intake_state = 'complete'
      and p.authoritative_file_count > 0
      and p.unready_file_count = 0
    ) as job_valid
  from projected p
  order by p.next_attempt_at, p.created_at, p.id;
end;
$$;

revoke all on function public.claim_telegram_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_telegram_outbox(text,integer,integer)
  to service_role;

comment on function public.claim_telegram_outbox(text,integer,integer) is
  'Backend-only bounded SKIP LOCKED lease for due post-rollout Telegram jobs. Returns authoritative enquiry notification fields and no client contact, payload or provider credential.';
