-- 20260922200000_transient_outbox_dead_letter_recovery.sql
--
-- Audit H-1 (2026-09-22). An outbox job exhausts eight attempts in roughly two
-- hours. A backend outage longer than that dead-letters every Telegram enquiry
-- alert and every Calendar projection created during it, and nothing brings
-- them back: the existing self-heal only covers
-- `telegram_destination_unavailable`.
--
-- Workers now label a permanent PostgREST 4xx refusal `database_rejected`, so a
-- dead job whose last error is still `database_unavailable` failed on a
-- genuine outage. This sweep gives such a job exactly one more full retry
-- budget when replay is provably safe:
--
--   * service backend only, bounded, SKIP LOCKED;
--   * only jobs created within the last seven days;
--   * each outbox id is recovered at most once (one-shot mark);
--   * Telegram enquiry alerts reuse service_recover_telegram_enquiry_outbox,
--     which refuses if delivery evidence exists or no recipient is eligible;
--   * Calendar create/update is replayed only for a confirmed, future session
--     whose calendar version still equals the job version. Google event ids are
--     deterministic per session, so a replay updates rather than duplicates.
--
-- Customer-facing kinds (email, WhatsApp) are never replayed here.

alter table crm_private.telegram_enquiry_recovery_marks
  drop constraint telegram_enquiry_recovery_marks_reason_allowed;

alter table crm_private.telegram_enquiry_recovery_marks
  add constraint telegram_enquiry_recovery_marks_reason_allowed
  check (reason in ('destination_became_eligible', 'transient_backend_failure'));

create table crm_private.outbox_transient_recovery_marks (
  outbox_id uuid primary key
    references public.integration_outbox(id) on delete cascade,
  kind public.outbox_kind not null,
  recovered_at timestamptz not null default now()
);

alter table crm_private.outbox_transient_recovery_marks enable row level security;

revoke all on table crm_private.outbox_transient_recovery_marks
  from public, anon, authenticated, service_role;

comment on table crm_private.outbox_transient_recovery_marks is
  'Server-only one-shot guard: each dead outbox job may be revived once after a transient backend failure.';

-- The single-job Telegram recovery keeps every existing guard and additionally
-- accepts a genuine backend outage as the dead-letter reason.
create or replace function public.service_recover_telegram_enquiry_outbox(
  p_outbox_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_has_destination boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram enquiry recovery is backend-only' using errcode = '42501';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for update;

  if not found
     or v_job.status <> 'dead'
     or v_job.last_error_code not in ('telegram_destination_unavailable', 'database_unavailable')
     or v_job.enquiry_id is null then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_job_not_recoverable');
  end if;

  if exists (
    select 1 from public.activity_log a
    where a.outbox_id = v_job.id and a.event_type = 'outbox.succeeded'
  ) or exists (
    select 1 from public.notifications n
    where n.entity_type = 'enquiry'
      and n.entity_id = v_job.enquiry_id
      and n.notification_type = 'enquiry.created'
  ) then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_delivery_evidence_present');
  end if;

  select exists (
    select 1
    from public.artist_memberships am
    join public.artists a
      on a.id = am.artist_id and a.is_active
    where am.artist_id = v_job.artist_id
      and am.is_active
      and crm_private.telegram_notification_recipient_eligible(
        am.profile_id, v_job.artist_id, a.workspace_id
      )
  ) into v_has_destination;

  if not v_has_destination then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_destination_unavailable');
  end if;

  update public.integration_outbox o
  set status = 'failed',
      attempt_count = 0,
      next_attempt_at = now(),
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = null,
      updated_at = now()
  where o.id = v_job.id;

  return jsonb_build_object('recovered', true, 'error_code', null);
end;
$$;

revoke all on function public.service_recover_telegram_enquiry_outbox(uuid)
  from public, anon, authenticated;
grant execute on function public.service_recover_telegram_enquiry_outbox(uuid) to service_role;

create or replace function public.service_recover_transient_dead_outbox(
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
  v_revived boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Transient outbox recovery is backend-only'
      using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'Transient outbox recovery limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  for v_candidate in
    select o.id, o.kind, o.enquiry_id, o.session_id, o.payload
    from public.integration_outbox o
    where o.status = 'dead'
      and o.last_error_code = 'database_unavailable'
      and o.kind in ('telegram_notification', 'calendar_create', 'calendar_update')
      and o.created_at >= now() - interval '7 days'
      and not exists (
        select 1 from crm_private.outbox_transient_recovery_marks m
        where m.outbox_id = o.id
      )
    order by o.updated_at, o.created_at, o.id
    for update of o skip locked
    limit p_limit
  loop
    v_scanned := v_scanned + 1;
    v_revived := false;

    if v_candidate.kind = 'telegram_notification' then
      v_result := public.service_recover_telegram_enquiry_outbox(v_candidate.id);
      v_revived := coalesce(v_result ->> 'recovered', 'false') = 'true';
      if v_revived then
        insert into crm_private.telegram_enquiry_recovery_marks (outbox_id, reason)
        values (v_candidate.id, 'transient_backend_failure')
        on conflict (outbox_id) do nothing;
      end if;
    else
      update public.integration_outbox o
      set status = 'failed',
          attempt_count = 0,
          next_attempt_at = now(),
          leased_by = null,
          leased_at = null,
          lease_expires_at = null,
          last_error_code = null,
          updated_at = now()
      from public.sessions s
      where o.id = v_candidate.id
        and s.id = o.session_id
        and public.session_is_calendar_eligible(s.status)
        and s.start_at > now()
        and s.calendar_version = (o.payload ->> 'calendar_version')::integer;
      v_revived := found;

      if v_revived then
        update public.sessions s
        set calendar_sync_status = 'retrying',
            calendar_last_error_code = null
        where s.id = v_candidate.session_id
          and s.calendar_sync_status = 'failed';
      end if;
    end if;

    -- The mark is written whether or not the job was revived, so a job that is
    -- not safe to replay is examined once and never rescanned.
    insert into crm_private.outbox_transient_recovery_marks (outbox_id, kind)
    values (v_candidate.id, v_candidate.kind)
    on conflict (outbox_id) do nothing;

    if v_revived then
      perform crm_private.log_activity(
        'outbox.transient_auto_recovered',
        'worker', null, null,
        v_candidate.enquiry_id, null, v_candidate.session_id,
        null, null, null, v_candidate.id,
        jsonb_build_object('reason', 'transient_backend_failure', 'kind', v_candidate.kind)
      );
      v_recovered := v_recovered + 1;
    end if;
  end loop;

  return query select v_scanned, v_recovered;
end;
$$;

revoke all on function public.service_recover_transient_dead_outbox(integer)
  from public, anon, authenticated;
grant execute on function public.service_recover_transient_dead_outbox(integer) to service_role;

comment on function public.service_recover_transient_dead_outbox(integer) is
  'Bounded one-shot revival of Telegram enquiry alerts and future Calendar projections dead-lettered by a genuine backend outage. Returns counts only.';
