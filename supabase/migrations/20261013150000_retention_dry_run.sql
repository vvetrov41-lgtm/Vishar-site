-- Retention, phase 1: automated dry run, audit and fail-closed guard.
--
-- 0010 shipped retention settings and holds with no executor; 20260923090000
-- recorded the owner decision: an enquiry that never became a project, and its
-- files, are kept for 1825 days after the last activity. Nothing applied it.
--
-- This migration makes the policy observable without deleting anything:
--
--   * crm_private.retention_enquiry_assessment(as_of) classifies every enquiry
--     as a candidate or as excluded, with the reason. The last activity is the
--     latest contact with the CLIENT across enquiries, activity, Gmail (the
--     30-day snapshot and the durable activity, outbound, thread and excerpt
--     records), reply marks, WhatsApp, communication threads, notes,
--     follow-ups and files. A client with any project, session, booking card,
--     invoice, payment request or deposit request is excluded entirely. An active retention hold excludes.
--   * public.retention_runs records each dry run: policy version, cutoff,
--     counts by reason and candidate ids/dates only (no names or contact data).
--   * public.service_run_retention_dry_run() runs at most once per 20 hours,
--     called by the existing CRM agent drain (no new cron). Candidates found
--     are written to the activity log as retention.candidates_found.
--   * public.run_retention_dry_run() lets the owner run one on demand.
--   * system_settings may not leave dry-run-only mode while no deletion
--     executor exists, so "enabled" cannot promise a deletion nothing performs.
--
-- Nothing here deletes enquiries, clients, files or Storage objects.

-- ---------------------------------------------------------------------------
-- 1. Fail-closed guard: no executor, so dry-run only
-- ---------------------------------------------------------------------------

alter table public.system_settings
  drop constraint if exists system_settings_dry_run_until_executor;
alter table public.system_settings
  add constraint system_settings_dry_run_until_executor check (retention_dry_run_only);

comment on constraint system_settings_dry_run_until_executor on public.system_settings is
  'No retention deletion executor exists yet (phase 2, specs/crm-retention). Drop only in the migration that adds one.';

-- ---------------------------------------------------------------------------
-- 2. Assessment
-- ---------------------------------------------------------------------------

create or replace function crm_private.retention_enquiry_assessment(p_as_of timestamptz)
returns table (
  enquiry_id uuid,
  artist_id uuid,
  client_id uuid,
  last_activity_at timestamptz,
  file_count integer,
  exclusion text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with settings as (
    select s.enquiry_retention_days as days,
           s.enquiry_retention_scope as scope
    from public.system_settings s
    where s.id
  ),
  -- Any commercial relationship makes the whole client out of scope.
  commercial_clients as (
    select p.client_id from public.projects p where p.client_id is not null
    union select se.client_id from public.sessions se where se.client_id is not null
    union select i.client_id from public.invoices i where i.client_id is not null
    union select pr.client_id from public.payment_requests pr where pr.client_id is not null
    union select d.client_id from public.project_deposit_requests d where d.client_id is not null
    union select b.client_id from crm_private.booking_cards b where b.client_id is not null
  ),
  held as (
    select h.client_id, h.enquiry_id, h.project_id
    from public.retention_holds h
    where h.released_at is null
  ),
  client_activity as (
    select x.client_id, max(x.at) as at
    from (
      select e.client_id, greatest(e.created_at, e.updated_at,
                                   coalesce(e.last_action_at, '-infinity'),
                                   coalesce(e.archived_at, '-infinity')) as at
        from public.enquiries e
      union all select c.id, greatest(c.created_at, c.updated_at, coalesce(c.archived_at, '-infinity'))
        from public.clients c
      union all select a.client_id, greatest(a.created_at, coalesce(a.occurred_at, '-infinity'))
        from public.activity_log a where a.client_id is not null
      union all select e.client_id, greatest(a.created_at, coalesce(a.occurred_at, '-infinity'))
        from public.activity_log a join public.enquiries e on e.id = a.enquiry_id
      union all select cc.client_id, greatest(cc.created_at, cc.updated_at, coalesce(cc.last_message_at, '-infinity'))
        from public.communication_conversations cc where cc.client_id is not null
      union all select cc.client_id, m.created_at
        from public.communication_messages m
        join public.communication_conversations cc on cc.id = m.conversation_id
        where cc.client_id is not null
      union all select w.client_id, greatest(w.created_at, w.updated_at, coalesce(w.last_message_at, '-infinity'))
        from public.whatsapp_conversations w where w.client_id is not null
      union all select w.client_id, wm.created_at
        from public.whatsapp_messages wm
        join public.whatsapp_conversations w on w.id = wm.conversation_id
        where w.client_id is not null
      union all select em.client_id, greatest(em.created_at, em.updated_at)
        from public.email_messages em where em.client_id is not null
      union all select g.client_id, coalesce(g.last_message_at, '-infinity')
        from public.gmail_client_metadata_snapshots g where g.client_id is not null
      -- Durable Gmail activity outlives the 30-day snapshot above.
      union all select ga.client_id, greatest(ga.updated_at, coalesce(ga.last_message_at, '-infinity'))
        from crm_private.gmail_client_email_activity ga
      union all select go.client_id, greatest(go.sent_at, go.recorded_at)
        from crm_private.gmail_client_outbound_messages go
      union all select gt.client_id, greatest(gt.created_at, gt.updated_at)
        from crm_private.gmail_thread_contexts gt where gt.client_id is not null
      union all select gx.client_id, greatest(gx.created_at, coalesce(gx.occurred_at, '-infinity'))
        from crm_private.gmail_client_ai_excerpts gx where gx.client_id is not null
      union all select rm.client_id, greatest(rm.created_at, coalesce(rm.message_at, '-infinity'))
        from crm_private.client_reply_marks rm where rm.client_id is not null
      union all select n.client_id, greatest(n.created_at, n.updated_at)
        from public.internal_notes n where n.client_id is not null
      union all select f.client_id, greatest(f.created_at, f.updated_at)
        from public.follow_ups f where f.client_id is not null
      union all select e.client_id, greatest(ef.created_at, coalesce(ef.uploaded_at, '-infinity'))
        from public.enquiry_files ef join public.enquiries e on e.id = ef.enquiry_id
    ) x
    where x.client_id is not null
    group by x.client_id
  )
  select
    e.id,
    e.artist_id,
    e.client_id,
    ca.at,
    (select count(*)::integer from public.enquiry_files ef where ef.enquiry_id = e.id),
    case
      -- Fail closed: no recorded decision, or a scope this code does not know.
      when st.days is null or st.scope is distinct from 'never_converted_after_last_activity'
        then 'policy_inactive'
      when e.client_id is null or ca.at is null
        then 'activity_unknown'
      when exists (select 1 from public.projects p where p.enquiry_id = e.id)
        then 'converted_to_project'
      when exists (select 1 from public.sessions se where se.enquiry_id = e.id)
        then 'has_session'
      when e.client_id in (select cl.client_id from commercial_clients cl)
        then 'client_has_commercial_records'
      when exists (select 1 from held h where h.enquiry_id = e.id or h.client_id = e.client_id)
        then 'retention_hold'
      when ca.at >= p_as_of - make_interval(days => st.days)
        then 'recent_activity'
      else null
    end
  from public.enquiries e
  cross join settings st
  left join client_activity ca on ca.client_id = e.client_id;
$$;

revoke all on function crm_private.retention_enquiry_assessment(timestamptz)
  from public, anon, authenticated, service_role;

comment on function crm_private.retention_enquiry_assessment(timestamptz) is
  'Read-only. One row per enquiry: exclusion NULL means a deletion candidate under the recorded 1825-day never-converted policy. Fails closed (policy_inactive / activity_unknown).';

-- ---------------------------------------------------------------------------
-- 3. Audit of dry runs
-- ---------------------------------------------------------------------------

create table if not exists public.retention_runs (
  id               uuid primary key default gen_random_uuid(),
  mode             text not null default 'dry_run',
  trigger          text not null,
  policy_version   integer not null,
  retention_days   integer,
  as_of            timestamptz not null,
  cutoff           timestamptz,
  enquiries_total  integer not null,
  candidate_count  integer not null,
  candidate_files  integer not null,
  exclusions       jsonb not null default '{}'::jsonb,
  -- Ids and dates only: enquiry_id, artist_id, client_id, last_activity_at, file_count.
  candidates       jsonb not null default '[]'::jsonb,
  oldest_activity_at timestamptz,
  created_at       timestamptz not null default clock_timestamp(),

  constraint retention_runs_mode check (mode = 'dry_run'),
  constraint retention_runs_trigger check (trigger in ('scheduled', 'owner')),
  constraint retention_runs_counts check (candidate_count >= 0 and candidate_files >= 0 and enquiries_total >= 0)
);

create index if not exists retention_runs_created_idx on public.retention_runs (created_at desc);

alter table public.retention_runs enable row level security;
alter table public.retention_runs force row level security;
revoke all on public.retention_runs from anon, authenticated, service_role;
grant select on public.retention_runs to authenticated;

drop policy if exists retention_runs_select_owner on public.retention_runs;
create policy retention_runs_select_owner on public.retention_runs
  for select using (public.is_owner() or crm_private.is_service_backend());

comment on table public.retention_runs is
  'Append-only audit of retention dry runs. Written only by security-definer RPCs; never contains names, contact data or file paths.';

create or replace function crm_private.record_retention_dry_run(p_trigger text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_as_of timestamptz := clock_timestamp();
  v_settings public.system_settings%rowtype;
  v_id uuid;
  v_total integer;
  v_candidates integer;
  v_files integer;
  v_exclusions jsonb;
  v_list jsonb;
  v_oldest timestamptz;
begin
  select * into v_settings from public.system_settings s where s.id;

  select count(*),
         count(*) filter (where a.exclusion is null),
         coalesce(sum(a.file_count) filter (where a.exclusion is null), 0),
         min(a.last_activity_at)
    into v_total, v_candidates, v_files, v_oldest
  from crm_private.retention_enquiry_assessment(v_as_of) a;

  select coalesce(jsonb_object_agg(x.exclusion, x.n), '{}'::jsonb) into v_exclusions
  from (select a.exclusion, count(*) as n
        from crm_private.retention_enquiry_assessment(v_as_of) a
        where a.exclusion is not null group by a.exclusion) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'enquiry_id', a.enquiry_id, 'artist_id', a.artist_id, 'client_id', a.client_id,
           'last_activity_at', a.last_activity_at, 'file_count', a.file_count)
           order by a.last_activity_at), '[]'::jsonb)
    into v_list
  from crm_private.retention_enquiry_assessment(v_as_of) a
  where a.exclusion is null;

  insert into public.retention_runs (
    trigger, policy_version, retention_days, as_of, cutoff,
    enquiries_total, candidate_count, candidate_files, exclusions, candidates, oldest_activity_at
  ) values (
    p_trigger, v_settings.retention_policy_version, v_settings.enquiry_retention_days, v_as_of,
    case when v_settings.enquiry_retention_days is not null
         then v_as_of - make_interval(days => v_settings.enquiry_retention_days) end,
    v_total, v_candidates, v_files, v_exclusions, v_list, v_oldest
  ) returning id into v_id;

  perform crm_private.log_activity(
    'retention.dry_run_completed', case when p_trigger = 'owner' then 'owner' else 'system' end, p_actor,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('run_id', v_id, 'trigger', p_trigger, 'candidates', v_candidates,
                       'candidate_files', v_files, 'enquiries_total', v_total,
                       'policy_version', v_settings.retention_policy_version)
  );
  if v_candidates > 0 then
    perform crm_private.log_activity(
      'retention.candidates_found', 'system', null,
      null, null, null, null, null, null, null, null,
      jsonb_build_object('run_id', v_id, 'candidates', v_candidates, 'candidate_files', v_files)
    );
  end if;

  return jsonb_build_object('status', 'recorded', 'run_id', v_id, 'candidates', v_candidates,
                            'candidate_files', v_files, 'enquiries_total', v_total, 'exclusions', v_exclusions);
end;
$$;

revoke all on function crm_private.record_retention_dry_run(text, uuid)
  from public, anon, authenticated, service_role;

-- Scheduled: at most once per 20 hours, called by the CRM agent drain.
create or replace function public.service_run_retention_dry_run()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.retention_runs'));

  if exists (select 1 from public.retention_runs r
             where r.trigger = 'scheduled'
               and r.created_at > clock_timestamp() - interval '20 hours') then
    return jsonb_build_object('status', 'throttled');
  end if;

  return crm_private.record_retention_dry_run('scheduled', null);
end;
$$;

revoke all on function public.service_run_retention_dry_run() from public, anon, authenticated;
grant execute on function public.service_run_retention_dry_run() to service_role;

-- Owner, on demand.
create or replace function public.run_retention_dry_run()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner');
  perform pg_advisory_xact_lock(hashtext('public.retention_runs'));
  return crm_private.record_retention_dry_run('owner', auth.uid());
end;
$$;

revoke all on function public.run_retention_dry_run() from public, anon, authenticated, service_role;
grant execute on function public.run_retention_dry_run() to authenticated;
