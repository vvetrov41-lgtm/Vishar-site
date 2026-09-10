-- 20260910130600_telegram_enquiry_dead_letter_self_heal.sql
--
-- One-time, fail-closed self-healing for recent enquiry Telegram jobs that were
-- dead-lettered only because no eligible profile destination was visible at the
-- time of routing. The normal scheduler already calls claim_telegram_outbox()
-- every five minutes; recovery is therefore kept inside that database boundary
-- instead of adding another Worker surface or provider-side retry path.
--
-- Safety invariants:
--   * service backend only;
--   * only telegram_notification + telegram_destination_unavailable;
--   * only post-rollout jobs created within the last seven days;
--   * current recipient eligibility must be true;
--   * existing notification/outbox-success evidence blocks replay;
--   * each outbox id may be auto-recovered at most once;
--   * the existing single-job recovery function remains authoritative;
--   * bounded SKIP LOCKED selection prevents scheduler contention.

create table crm_private.telegram_enquiry_recovery_marks (
  outbox_id uuid primary key
    references public.integration_outbox(id) on delete cascade,
  recovered_at timestamptz not null default now(),
  reason text not null,
  constraint telegram_enquiry_recovery_marks_reason_allowed
    check (reason = 'destination_became_eligible')
);

alter table crm_private.telegram_enquiry_recovery_marks enable row level security;

revoke all on table crm_private.telegram_enquiry_recovery_marks
  from public, anon, authenticated, service_role;

comment on table crm_private.telegram_enquiry_recovery_marks is
  'Server-only one-shot guard for automatic recovery of recent enquiry Telegram destination-unavailable dead letters.';

create or replace function public.service_recover_telegram_enquiry_outbox_batch(
  p_limit integer default 10
)
returns table (
  scanned integer,
  recovered integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_candidate record;
  v_result jsonb;
  v_scanned integer := 0;
  v_recovered integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram enquiry recovery sweep is backend-only'
      using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'Telegram enquiry recovery limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  for v_candidate in
    select o.id, o.enquiry_id
    from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r
      on r.kind = o.kind
    where o.kind = 'telegram_notification'
      and o.status = 'dead'
      and o.last_error_code = 'telegram_destination_unavailable'
      and o.enquiry_id is not null
      and o.created_at >= r.automatic_after
      and o.created_at >= now() - interval '7 days'
      and not exists (
        select 1
        from crm_private.telegram_enquiry_recovery_marks m
        where m.outbox_id = o.id
      )
      and not exists (
        select 1
        from public.activity_log a
        where a.outbox_id = o.id
          and a.event_type = 'outbox.succeeded'
      )
      and not exists (
        select 1
        from public.notifications n
        where n.entity_type = 'enquiry'
          and n.entity_id = o.enquiry_id
          and n.notification_type = 'enquiry.created'
      )
      and exists (
        select 1
        from public.artist_memberships am
        join public.artists artist
          on artist.id = am.artist_id
         and artist.is_active
        where am.artist_id = o.artist_id
          and am.is_active
          and crm_private.telegram_notification_recipient_eligible(
            am.profile_id,
            o.artist_id,
            artist.workspace_id
          )
      )
    order by o.updated_at, o.created_at, o.id
    for update of o skip locked
    limit p_limit
  loop
    v_scanned := v_scanned + 1;
    v_result := public.service_recover_telegram_enquiry_outbox(v_candidate.id);

    if coalesce(v_result ->> 'recovered', 'false') = 'true' then
      insert into crm_private.telegram_enquiry_recovery_marks (
        outbox_id,
        reason
      ) values (
        v_candidate.id,
        'destination_became_eligible'
      );

      perform crm_private.log_activity(
        'outbox.telegram_auto_recovered',
        'worker',
        null,
        null,
        v_candidate.enquiry_id,
        null,
        null,
        null,
        null,
        null,
        v_candidate.id,
        jsonb_build_object('reason', 'destination_became_eligible')
      );

      v_recovered := v_recovered + 1;
    end if;
  end loop;

  return query select v_scanned, v_recovered;
end;
$$;

-- The batch helper is intentionally not an API surface. claim_telegram_outbox()
-- owns the service-role entry point and invokes this helper as the function
-- owner, keeping the ACL inventory unchanged and the recovery path narrower.
revoke all on function public.service_recover_telegram_enquiry_outbox_batch(integer)
  from public, anon, authenticated, service_role;

comment on function public.service_recover_telegram_enquiry_outbox_batch(integer) is
  'Internal bounded one-shot recovery sweep invoked only by the scheduled Telegram claim wrapper. Returns counts only and never exposes a chat id, client contact or provider credential.';

-- Keep the existing Worker RPC stable. Every automatic claim performs the
-- bounded recovery sweep first, then leases normal due jobs exactly as before.
-- A successfully recovered row becomes failed/due and may be leased in this
-- same transaction. If recovery is not safe, the row stays dead.
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

  perform *
  from public.service_recover_telegram_enquiry_outbox_batch(p_limit);

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
  'Backend-only bounded Telegram lease. First performs one-shot safe recovery of recent eligible destination-unavailable enquiry dead letters, then returns authoritative due-job fields without client contact, payload or provider credentials.';
