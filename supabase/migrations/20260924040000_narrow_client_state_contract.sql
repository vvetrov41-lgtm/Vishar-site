-- 20260924040000_narrow_client_state_contract.sql
--
-- Phase 3 of the CRM AI architecture: the model stops owning workflow facts.
--
-- 1. The claimed context gains `attention`: the deterministic facts from
--    Phase 2 (last speaker, stage, SLA, conflicts, allowed actions). The
--    Worker passes them to the model as authoritative.
-- 2. Behind `crm_agent_config.deterministic_state` (default off):
--    - `client_ai_state.brief.stage` and `.waiting_on` are overwritten from
--      the deterministic layer on every write, whatever the Worker sent;
--    - a new next action whose type is not in `allowed_actions` is stored as
--      superseded with reason `rule_disallowed`, so it never reaches an
--      operator, and is counted.
-- 3. A narrow classifier result (does the latest client message need a
--    reply?) is recorded through `service_record_client_reply_state`, which
--    derives the message time server-side.
--
-- Existing rows stay readable: the brief keeps its shape, only the source of
-- two fields changes. The Phase 1 guards stay in place and keep firing; they
-- are demoted only once telemetry shows they never trigger.

alter table crm_private.crm_agent_config
  add column deterministic_state boolean not null default false;

alter table public.client_ai_next_actions
  add column superseded_reason text
    check (superseded_reason is null or superseded_reason in ('rule_disallowed'));

create or replace function crm_private.client_ai_context(
  p_artist_id uuid,
  p_client_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
set "TimeZone" = 'UTC'
as $$
  select jsonb_build_object(
    'client', jsonb_build_object(
      'full_name', c.full_name,
      'preferred_contact', c.preferred_contact
    ),
    'artist', jsonb_build_object(
      'display_name', a.display_name,
      'timezone', a.timezone
    ),
    'enquiries', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'reference', e.reference_number,
          'status', e.status,
          'project_type', left(e.project_type, 200),
          'placement', left(e.placement, 200),
          'approximate_size', left(e.approximate_size, 200),
          'cover_up', left(e.cover_up, 200),
          'preferred_timing', left(e.preferred_timing, 200),
          'idea', left(e.idea, 2000),
          'created_at', e.created_at
        ) as item,
        row_number() over (order by e.created_at desc, e.id desc) as rank
        from public.enquiries e
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
        order by e.created_at desc, e.id desc
        limit 5
      ) s
    ),
    'crm_facts', jsonb_build_object(
      'has_scheduled_appointment', crm_private.client_has_scheduled_appointment(p_artist_id, p_client_id),
      'scheduled_appointment_count', (
        select count(*)
        from public.sessions s
        where s.client_id = p_client_id
          and s.artist_id = p_artist_id
          and s.status in ('proposed', 'confirmed')
          and s.cancelled_at is null
      ),
      'references_attached', crm_private.client_has_reference_files(p_artist_id, p_client_id),
      'reference_file_count', (
        select count(*)
        from public.enquiries e
        join public.enquiry_files f on f.enquiry_id = e.id
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
          and f.upload_state = 'ready'
          and f.category = 'reference'
      ),
      'ready_file_count', (
        select count(*)
        from public.enquiries e
        join public.enquiry_files f on f.enquiry_id = e.id
        where e.client_id = p_client_id
          and e.artist_id = p_artist_id
          and e.archived_at is null
          and f.upload_state = 'ready'
      ),
      'reference_analysis_count', (
        select count(*)
        from public.enquiry_file_ai_analysis f
        where f.client_id = p_client_id
          and f.artist_id = p_artist_id
      ),
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', p.status,
          'deposit_status', p.deposit_status,
          'deposit_amount', p.deposit_amount,
          'estimated_sessions', p.estimated_sessions,
          'estimated_hours', p.estimated_hours,
          'estimate_total', p.estimate_total,
          'currency', p.currency
        ) order by p.created_at desc), '[]'::jsonb)
        from public.projects p
        where p.client_id = p_client_id
          and p.artist_id = p_artist_id
          and p.archived_at is null
      ),
      'sessions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', s.status,
          'appointment_type', s.appointment_type,
          'start_at', s.start_at,
          'end_at', s.end_at,
          'payment_status', s.payment_status,
          'price', s.price
        ) order by s.start_at desc), '[]'::jsonb)
        from public.sessions s
        where s.client_id = p_client_id
          and s.artist_id = p_artist_id
          and s.start_at > clock_timestamp() - interval '180 days'
      )
    ),
    'timeline', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'source', u.source,
          'direction', u.direction,
          'text', left(u.body, 1000),
          'occurred_at', u.occurred_at
        ) as item,
        row_number() over (order by u.occurred_at desc, u.source_id desc) as rank
        from crm_private.client_timeline_items(p_artist_id, p_client_id) u
        order by u.occurred_at desc, u.source_id desc
        limit 20
      ) s
    ),
    'reference_images', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'summary', f.summary,
        'analysis', f.analysis
      ) order by f.analyzed_at desc, f.id desc), '[]'::jsonb)
      from public.enquiry_file_ai_analysis f
      where f.client_id = p_client_id
        and f.artist_id = p_artist_id
    ),
    -- Phase 3: deterministic workflow facts. The model is told these are
    -- authoritative and chooses its recommendation from allowed_actions.
    'attention', crm_private.client_attention(p_artist_id, p_client_id),
    'previous_brief', (
      select jsonb_build_object('summary', st.summary, 'brief', st.brief)
      from public.client_ai_state st
      where st.artist_id = p_artist_id
        and st.client_id = p_client_id
    )
  )
  from public.clients c
  join public.artists a on a.id = p_artist_id
  where c.id = p_client_id
    and crm_private.client_ai_scope(p_artist_id, p_client_id) is not null;
$$;


revoke execute on function crm_private.client_ai_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function crm_private.client_ai_context(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Deterministic fields on write
-- ---------------------------------------------------------------------------

create function crm_private.client_ai_state_deterministic_fields()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_attention jsonb;
begin
  if not coalesce((select deterministic_state from crm_private.crm_agent_config where singleton), false) then
    return new;
  end if;
  v_attention := crm_private.client_attention(new.artist_id, new.client_id);
  if v_attention is null then
    return new;
  end if;
  new.brief := new.brief
    || jsonb_build_object('stage', v_attention ->> 'workflow_stage',
                          'waiting_on', v_attention ->> 'waiting_on_candidate');
  return new;
end;
$$;

create trigger client_ai_state_deterministic_fields
  before insert or update of brief on public.client_ai_state
  for each row execute function crm_private.client_ai_state_deterministic_fields();

create function crm_private.client_ai_next_action_allowed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_allowed jsonb;
begin
  if new.status <> 'open'
     or not coalesce((select deterministic_state from crm_private.crm_agent_config where singleton), false) then
    return new;
  end if;
  v_allowed := crm_private.client_attention(new.artist_id, new.client_id) -> 'allowed_actions';
  if v_allowed is not null and not (v_allowed ? new.action_type) then
    new.status := 'superseded';
    new.superseded_reason := 'rule_disallowed';
    new.draft_reply := null;
  end if;
  return new;
end;
$$;

-- Named to fire before the existing guard trigger (triggers run in name order).
create trigger client_ai_next_action_allowed
  before insert or update of action_type, status on public.client_ai_next_actions
  for each row execute function crm_private.client_ai_next_action_allowed();

revoke all on function crm_private.client_ai_state_deterministic_fields() from public, anon, authenticated, service_role;
revoke all on function crm_private.client_ai_next_action_allowed() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Narrow classifier result: does the latest client message need a reply?
-- ---------------------------------------------------------------------------

create function public.service_record_client_reply_state(p_job_id uuid, p_reply_state text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_inbound timestamptz;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_reply_state not in ('reply_required', 'no_reply_needed') then
    return jsonb_build_object('status', 'ignored');
  end if;

  select j.* into v_job from public.crm_agent_jobs j
  where j.id = p_job_id and j.job_type = 'refresh_client_ai_state' and j.status = 'succeeded';
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The mark answers the message the job actually saw: the latest inbound
  -- at the job's own watermark. A newer inbound would have made the job stale.
  select c.last_inbound_at into v_inbound
  from crm_private.attention_comm_facts(v_job.artist_id, v_job.client_id) c;
  if v_inbound is null then
    return jsonb_build_object('status', 'no_inbound');
  end if;

  insert into crm_private.client_reply_marks (artist_id, client_id, message_at, reply_state, source)
  values (v_job.artist_id, v_job.client_id, v_inbound, p_reply_state, 'classifier');
  return jsonb_build_object('status', 'recorded');
end;
$$;

revoke all on function public.service_record_client_reply_state(uuid, text) from public, anon, authenticated;
grant execute on function public.service_record_client_reply_state(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Evidence: how often each deterministic rule changed what the model said
-- ---------------------------------------------------------------------------

create function public.service_contract_rule_summary(p_hours integer default 168)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'rule_disallowed', count(*) filter (where superseded_reason = 'rule_disallowed'),
    'superseded_at_insert', count(*) filter (where status = 'superseded' and updated_at - created_at < interval '1 second'),
    'actions', count(*)
  )
  from public.client_ai_next_actions
  where crm_private.is_service_backend()
    and created_at > clock_timestamp() - make_interval(hours => least(greatest(coalesce(p_hours, 168), 1), 2160));
$$;

revoke all on function public.service_contract_rule_summary(integer) from public, anon, authenticated;
grant execute on function public.service_contract_rule_summary(integer) to service_role;
