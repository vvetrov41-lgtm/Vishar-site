-- 20260924036000_client_ai_brief_convergence.sql
--
-- Phase 6a of the CRM AI architecture: briefs converge on current facts.
--
-- Production evidence (2026-09-25): 25 of 32 client AI briefs were stale and
-- none had a job queued. Their last jobs had succeeded; nothing about those
-- clients had changed. The cause: `client_ai_watermark` hashed the whole
-- `clients` row, and 20260923020000 added two columns to it, which changed
-- every watermark at once. Nothing re-enqueues a refresh after a schema
-- change, so the briefs stayed stale, the Phase 2 shadow compared rules with
-- week-old AI output, and Telegram withheld their recommendations as stale.
--
-- 1. The watermark hashes only the client fields the model is shown, so an
--    unrelated column can no longer invalidate every brief.
-- 2. `service_converge_client_ai_briefs` is a bounded sweep the TattooAI
--    drain calls: it enqueues an ordinary refresh for a few stale briefs that
--    have no job pending, at most a fixed number per hour, oldest first. The
--    source event is derived from the current watermark, so a failing client
--    is not retried for the same facts until they change.
--
-- (1) changes every watermark once more; (2) is what brings them back.

create or replace function crm_private.client_ai_watermark(
  p_artist_id uuid,
  p_client_id uuid
) returns text
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
set "TimeZone" = 'UTC'
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'artist', p_artist_id,
          -- Only what the model is shown (client_ai_context: full_name,
          -- preferred_contact) plus what changes its scope. Hashing the whole
          -- row made every brief stale whenever a column was added to clients
          -- (20260923020000 did exactly that, silently, for 25 of 32 briefs).
          'client', jsonb_build_object(
            'id', c.id,
            'full_name', c.full_name,
            'preferred_contact', c.preferred_contact,
            'archived_at', c.archived_at
          ),
          'enquiries', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', e.id,
              'status', e.status,
              'intake_state', e.intake_state,
              'archived_at', e.archived_at,
              'project_type', e.project_type,
              'placement', e.placement,
              'approximate_size', e.approximate_size,
              'cover_up', e.cover_up,
              'preferred_timing', e.preferred_timing,
              'idea', e.idea
            ) order by e.id), '[]'::jsonb)
            from public.enquiries e
            where e.client_id = p_client_id
              and e.artist_id = p_artist_id
          ),
          'projects', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id,
              'status', p.status,
              'deposit_status', p.deposit_status,
              'estimate_total', p.estimate_total,
              'estimated_sessions', p.estimated_sessions,
              'estimated_hours', p.estimated_hours,
              'hourly_rate', p.hourly_rate,
              'deposit_amount', p.deposit_amount,
              'currency', p.currency,
              'archived_at', p.archived_at
            ) order by p.id), '[]'::jsonb)
            from public.projects p
            where p.client_id = p_client_id
              and p.artist_id = p_artist_id
          ),
          'sessions', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', s.id,
              'status', s.status,
              'appointment_type', s.appointment_type,
              'start_at', s.start_at,
              'end_at', s.end_at,
              'payment_status', s.payment_status,
              'price', s.price,
              'cancelled_at', s.cancelled_at
            ) order by s.id), '[]'::jsonb)
            from public.sessions s
            where s.client_id = p_client_id
              and s.artist_id = p_artist_id
          ),
          'reference_files', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', f.id,
              'enquiry_id', f.enquiry_id,
              'category', f.category,
              'mime_type', f.mime_type,
              'byte_size', f.byte_size,
              'checksum', f.checksum,
              'upload_state', f.upload_state,
              'uploaded_at', f.uploaded_at
            ) order by f.id), '[]'::jsonb)
            from public.enquiries e
            join public.enquiry_files f on f.enquiry_id = e.id
            where e.client_id = p_client_id
              and e.artist_id = p_artist_id
              and f.upload_state = 'ready'
          ),
          'messages', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', m.id,
              'direction', m.direction,
              'body', m.body,
              'occurred_at', coalesce(m.provider_timestamp, m.created_at)
            ) order by m.id), '[]'::jsonb)
            from public.communication_messages m
            join public.communication_conversations v
              on v.id = m.conversation_id and v.artist_id = m.artist_id
            where v.client_id = p_client_id
              and m.artist_id = p_artist_id
          ),
          'emails', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.id,
              'subject', x.subject,
              'body', x.body,
              'sent_at', x.sent_at
            ) order by x.id), '[]'::jsonb)
            from public.email_messages x
            where x.client_id = p_client_id
              and x.artist_id = p_artist_id
              and x.status = 'sent'
          ),
          'gmail', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', g.id,
              'last_provider_message_id', g.last_provider_message_id,
              'updated_at', g.updated_at
            ) order by g.id), '[]'::jsonb)
            from crm_private.gmail_thread_contexts g
            where g.client_id = p_client_id
              and g.artist_id = p_artist_id
          ),
          'gmail_excerpts', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.provider_message_id,
              'body', x.body_excerpt
            ) order by x.provider_message_id), '[]'::jsonb)
            from crm_private.gmail_client_ai_excerpts x
            where x.client_id = p_client_id
              and x.artist_id = p_artist_id
          ),
          'notes', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', n.id,
              'updated_at', n.updated_at
            ) order by n.id), '[]'::jsonb)
            from public.internal_notes n
            where n.client_id = p_client_id
          ),
          'images', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', f.id,
              'analyzed_at', f.analyzed_at
            ) order by f.id), '[]'::jsonb)
            from public.enquiry_file_ai_analysis f
            where f.client_id = p_client_id
              and f.artist_id = p_artist_id
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.clients c
  where c.id = p_client_id
    and crm_private.client_ai_scope(p_artist_id, p_client_id) is not null;
$$;

revoke execute on function crm_private.client_ai_watermark(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.service_converge_client_ai_briefs(p_limit integer default 4)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_budget integer;
  v_queued integer := 0;
  v_stale integer := 0;
  v_row record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;
  -- One sweep at a time; a concurrent drain simply skips.
  if not pg_try_advisory_xact_lock(hashtext('crm_private.converge_client_ai_briefs')) then
    return jsonb_build_object('status', 'busy');
  end if;

  -- An hourly budget, so a mass invalidation drains over hours rather than
  -- becoming a burst of model calls.
  v_budget := least(greatest(coalesce(p_limit, 4), 0), 10) - (
    select count(*)::integer from public.crm_agent_jobs j
    where j.source_event_id like 'converge:%'
      and j.created_at > clock_timestamp() - interval '1 hour');

  -- Nothing can be queued this hour: do not compute a single watermark.
  if v_budget <= 0 then
    return jsonb_build_object('status', 'budget_spent', 'queued', 0, 'budget', 0);
  end if;

  for v_row in
    select s.artist_id, s.client_id, w.watermark
    from public.client_ai_state s
    cross join lateral (select crm_private.client_ai_watermark(s.artist_id, s.client_id) as watermark) w
    where w.watermark is not null
      and s.source_watermark is distinct from w.watermark
      and not exists (select 1 from public.crm_agent_jobs j
                      where j.artist_id = s.artist_id and j.client_id = s.client_id
                        and j.job_type = 'refresh_client_ai_state'
                        and j.status in ('pending', 'processing'))
    order by s.updated_at asc, s.client_id
  loop
    v_stale := v_stale + 1;
    if crm_private.schedule_client_ai_refresh(
         v_row.artist_id, v_row.client_id, 'converge:' || left(v_row.watermark, 32)) is not null then
      v_queued := v_queued + 1;
    end if;
    -- Stop as soon as the budget is used; the rest waits for the next hour.
    exit when v_queued >= v_budget;
  end loop;

  return jsonb_build_object('status', 'ok', 'examined', v_stale, 'queued', v_queued, 'budget', v_budget);
end;
$$;

revoke all on function public.service_converge_client_ai_briefs(integer) from public, anon, authenticated;
grant execute on function public.service_converge_client_ai_briefs(integer) to service_role;

comment on function public.service_converge_client_ai_briefs(integer) is
  'Backend-only bounded sweep: enqueues an ordinary refresh for stale client AI briefs with no pending job, a few per hour, deduplicated by watermark.';
