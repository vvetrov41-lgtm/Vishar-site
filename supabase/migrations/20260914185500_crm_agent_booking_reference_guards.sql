-- Keep CRM AI recommendations aligned with authoritative booking and file state.
--
-- Two facts must remain true even when vision/model output is stale or missing:
--   1. a client with an active proposed/confirmed appointment must not be sent
--      back through the original intake questions;
--   2. a client who already attached reference files must not be asked for the
--      same generic references merely because vision analysis is absent.

create or replace function crm_private.client_has_scheduled_appointment(
  p_artist_id uuid,
  p_client_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.sessions s
    where s.artist_id = p_artist_id
      and s.client_id = p_client_id
      and s.status in ('proposed', 'confirmed')
      and s.cancelled_at is null
  );
$$;

create or replace function crm_private.client_has_reference_files(
  p_artist_id uuid,
  p_client_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.enquiries e
    join public.enquiry_files f on f.enquiry_id = e.id
    where e.artist_id = p_artist_id
      and e.client_id = p_client_id
      and e.archived_at is null
      and f.upload_state = 'ready'
      and f.category = 'reference'
  );
$$;

create or replace function crm_private.client_ai_action_requests_attached_references(
  p_reason text,
  p_draft_reply text,
  p_missing_information jsonb
) returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_text text := lower(coalesce(p_reason, '') || ' ' || coalesce(p_draft_reply, ''));
  v_missing jsonb := case
    when jsonb_typeof(coalesce(p_missing_information, '[]'::jsonb)) = 'array'
      then coalesce(p_missing_information, '[]'::jsonb)
    else '[]'::jsonb
  end;
begin
  if exists (
    select 1
    from jsonb_array_elements_text(v_missing) x(value)
    where lower(x.value) ~ '(^|[_ -])reference(s|[_ -]?(image|photo)s?)?([_ -]|$)'
  ) then
    return true;
  end if;

  -- Block only a generic request to send/upload the references that are
  -- already present. Requests for an explicitly additional/specific reference
  -- remain possible when the project genuinely needs one.
  if (
    v_text ~ '(send|provide|share|upload|attach|supply).{0,80}(reference|reference image|reference photo)'
    or v_text ~ '(reference|reference image|reference photo).{0,80}(send|provide|share|upload|attach|supply)'
  ) and v_text !~ '(additional|another|more|extra|specific|clearer|updated|different).{0,60}(reference|image|photo)' then
    return true;
  end if;

  return false;
end;
$$;

revoke execute on function crm_private.client_has_scheduled_appointment(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function crm_private.client_has_reference_files(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function crm_private.client_ai_action_requests_attached_references(text, text, jsonb)
  from public, anon, authenticated, service_role;

-- Feed the model explicit raw-file and booking facts. reference_images remains
-- the bounded Qwen/Workers AI analysis; references_attached remains true even
-- if that analysis is pending or unavailable.
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

-- Raw ready files and appointment_type now participate in the source watermark,
-- so a model completion that raced either mutation is rejected as stale.
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
          'client', to_jsonb(c) - 'notes_summary',
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
  from public, anon, authenticated;
grant execute on function crm_private.client_ai_watermark(uuid, uuid) to service_role;

create or replace function crm_private.session_ai_fingerprint(s public.sessions)
returns text
language sql
stable
set search_path = pg_catalog, extensions
set "TimeZone" = 'UTC'
as $$
  select left(encode(extensions.digest(convert_to(
    coalesce(s.status::text, '') || '|' ||
    coalesce(s.appointment_type::text, '') || '|' ||
    coalesce(s.start_at::text, '') || '|' ||
    coalesce(s.end_at::text, '') || '|' ||
    coalesce(s.payment_status::text, '') || '|' ||
    coalesce(s.price::text, '') || '|' ||
    coalesce(s.cancelled_at::text, ''),
    'UTF8'), 'sha256'), 'hex'), 16);
$$;

revoke execute on function crm_private.session_ai_fingerprint(public.sessions)
  from public, anon, authenticated, service_role;

-- Booking mutation first closes any intake-style request_information. Existing
-- notification withdrawal + final Telegram live-read guards then prevent a
-- queued stale recommendation from being delivered.
create or replace function crm_private.enqueue_session_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new text;
  v_event text;
begin
  if new.client_id is null then
    return new;
  end if;

  if new.status in ('proposed', 'confirmed') and new.cancelled_at is null then
    update public.client_ai_next_actions a
    set status = 'superseded', updated_at = clock_timestamp()
    where a.artist_id = new.artist_id
      and a.client_id = new.client_id
      and a.status = 'open'
      and a.action_type = 'request_information';
  end if;

  v_new := crm_private.session_ai_fingerprint(new);
  if tg_op = 'UPDATE' and crm_private.session_ai_fingerprint(old) = v_new then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event := 'session:' || new.id::text || ':' || v_new;
  else
    v_event := 'session:' || new.id::text || ':tx:'
      || pg_current_xact_id()::text || ':' || v_new;
  end if;

  begin
    perform crm_private.schedule_client_ai_refresh(new.artist_id, new.client_id, v_event);
  exception when others then null;
  end;
  return new;
end;
$$;

revoke execute on function crm_private.enqueue_session_client_ai()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_enqueue_client_ai on public.sessions;
create trigger sessions_enqueue_client_ai
after insert or update of status, appointment_type, start_at, end_at, payment_status, price, cancelled_at
on public.sessions
for each row execute function crm_private.enqueue_session_client_ai();

-- A ready file invalidates client state immediately, independently of whether
-- vision succeeds. Qwen/Workers AI analysis is still queued for supported image
-- types and enriches reference_images when it completes.
create or replace function crm_private.enqueue_enquiry_file_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_file_id uuid;
  v_enquiry_id uuid;
  v_artist uuid;
  v_client uuid;
  v_ready boolean;
  v_reference boolean;
  v_event text;
begin
  if tg_op = 'DELETE' then
    v_file_id := old.id;
    v_enquiry_id := old.enquiry_id;
    v_ready := false;
    v_reference := false;
  else
    v_file_id := new.id;
    v_enquiry_id := new.enquiry_id;
    v_ready := new.upload_state = 'ready';
    v_reference := v_ready and new.category = 'reference';
  end if;

  select e.artist_id, e.client_id
  into v_artist, v_client
  from public.enquiries e
  where e.id = v_enquiry_id;

  if v_artist is null or v_client is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if v_ready then
    begin
      perform crm_private.schedule_reference_image_analysis(v_file_id);
    exception when others then null;
    end;
  end if;

  if v_reference then
    update public.client_ai_next_actions a
    set status = 'superseded', updated_at = clock_timestamp()
    where a.artist_id = v_artist
      and a.client_id = v_client
      and a.status = 'open'
      and a.action_type = 'request_information'
      and crm_private.client_ai_action_requests_attached_references(
        a.reason, a.draft_reply, a.missing_information
      );
  end if;

  v_event := 'enquiry_file:' || v_file_id::text || ':' || lower(tg_op)
    || ':tx:' || pg_current_xact_id()::text;
  begin
    perform crm_private.schedule_client_ai_refresh(v_artist, v_client, v_event);
  exception when others then null;
  end;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function crm_private.enqueue_enquiry_file_client_ai()
  from public, anon, authenticated, service_role;

drop trigger if exists enquiry_files_enqueue_client_ai on public.enquiry_files;
create trigger enquiry_files_enqueue_client_ai
after insert or update of upload_state, category, mime_type, byte_size, checksum
on public.enquiry_files
for each row execute function crm_private.enqueue_enquiry_file_client_ai();

drop trigger if exists enquiry_files_delete_client_ai on public.enquiry_files;
create trigger enquiry_files_delete_client_ai
after delete on public.enquiry_files
for each row execute function crm_private.enqueue_enquiry_file_client_ai();

-- Final persistence boundary: even if a provider ignored the explicit facts,
-- an invalid request_information cannot remain client-facing.
create or replace function crm_private.guard_client_ai_next_action_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.status <> 'open' or new.action_type <> 'request_information' then
    return new;
  end if;

  if crm_private.client_has_scheduled_appointment(new.artist_id, new.client_id) then
    new.action_type := 'artist_review';
    new.reason := 'Client already has a scheduled appointment in CRM. Review the current booking and conversation before requesting more intake information.';
    new.draft_reply := null;
    new.missing_information := '[]'::jsonb;
    return new;
  end if;

  if crm_private.client_has_reference_files(new.artist_id, new.client_id)
     and crm_private.client_ai_action_requests_attached_references(
       new.reason, new.draft_reply, new.missing_information
     ) then
    new.action_type := 'artist_review';
    new.reason := 'Reference files are already attached in CRM. Review the existing references before requesting them again.';
    new.draft_reply := null;
    new.missing_information := '[]'::jsonb;
  end if;

  return new;
end;
$$;

revoke execute on function crm_private.guard_client_ai_next_action_truth()
  from public, anon, authenticated, service_role;

drop trigger if exists client_ai_next_actions_truth_guard on public.client_ai_next_actions;
create trigger client_ai_next_actions_truth_guard
before insert or update of action_type, reason, draft_reply, missing_information, status, artist_id, client_id
on public.client_ai_next_actions
for each row execute function crm_private.guard_client_ai_next_action_truth();

-- Reconcile any already-open stale recommendations. The existing status-change
-- trigger withdraws linked pending notifications, and the Telegram claim path
-- also performs a final live status read before sending.
update public.client_ai_next_actions a
set status = 'superseded', updated_at = clock_timestamp()
where a.status = 'open'
  and a.action_type = 'request_information'
  and (
    crm_private.client_has_scheduled_appointment(a.artist_id, a.client_id)
    or (
      crm_private.client_has_reference_files(a.artist_id, a.client_id)
      and crm_private.client_ai_action_requests_attached_references(
        a.reason, a.draft_reply, a.missing_information
      )
    )
  );
