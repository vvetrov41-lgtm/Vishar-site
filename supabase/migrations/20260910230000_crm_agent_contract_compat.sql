-- Preserve the established service RPC contract while keeping the final
-- Gmail timestamp and Telegram stale-delivery guards.
--
-- 20260910220000 proved the safety changes but widened the public service RPC
-- from eight to nine arguments and eagerly superseded stale actions. Neither is
-- necessary. This migration restores the stable eight-argument RPC and keeps
-- stale recommendations visible to the CRM as historical/is_stale records while
-- the Telegram claim path from 22000 remains fail-closed on the live watermark.

-- ---------------------------------------------------------------------------
-- 1. Scheduling remains a queue operation, not an action-state mutation.
--
-- Telegram pull and push paths independently check the live watermark. Keeping
-- the old action open-but-stale preserves the audit/read semantics of
-- get_client_ai_state/list_client_ai_next_actions and avoids coupling source
-- ingestion to recommendation lifecycle transitions.
-- ---------------------------------------------------------------------------

create or replace function crm_private.schedule_client_ai_refresh(
  p_artist_id uuid,
  p_client_id uuid,
  p_source_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_id uuid;
begin
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return null;
  end if;
  if p_source_event_id is null or p_source_event_id !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    return null;
  end if;

  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    return null;
  end if;

  insert into public.crm_agent_jobs (
    artist_id, workspace_id, client_id, job_type, source_event_id
  )
  values (p_artist_id, v_workspace, p_client_id, 'refresh_client_ai_state', p_source_event_id)
  on conflict (artist_id, job_type, source_event_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function crm_private.schedule_client_ai_refresh(uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Restore the stable eight-argument Gmail RPC.
--
-- Provider time travels in a bounded versioned prefix inside the private RPC's
-- p_body transport value:
--
--   @vishar-crm-ai-occurred-at:2026-09-10T18:42:00.000Z\n<body>
--
-- The prefix is generated only by the trusted Gmail Worker, stripped before
-- storage/model context, and never shown to the artist. Plain p_body remains
-- accepted for backwards compatibility and SQL probes. The feature did not
-- exist in production before this branch, so there is no deployed legacy caller
-- that can silently create new excerpts without the prefix.
-- ---------------------------------------------------------------------------

drop function if exists public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text,timestamptz
);

create function public.service_record_gmail_client_message(
  p_artist_id uuid,
  p_client_id uuid,
  p_enquiry_id uuid,
  p_provider_thread_id text,
  p_provider_message_id text,
  p_direction text,
  p_subject text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_body text;
  v_id uuid;
  v_previous_message_id text;
  v_occurred_at timestamptz := clock_timestamp();
  v_prefix constant text := '@vishar-crm-ai-occurred-at:';
  v_first_line text;
  v_timestamp_text text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  if p_provider_thread_id is null or p_provider_thread_id !~ '^[A-Za-z0-9_-]{4,255}$'
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9_-]{1,255}$'
     or p_direction is null or p_direction not in ('inbound', 'outbound')
     or (p_subject is not null and length(p_subject) > 998) then
    raise exception 'invalid Gmail excerpt' using errcode = '22023';
  end if;

  -- Scope is checked before baseline detection so a caller cannot use response
  -- differences to probe whether another artist has already observed a thread.
  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;

  v_body := coalesce(p_body, '');
  if left(v_body, length(v_prefix)) = v_prefix then
    v_first_line := split_part(v_body, E'\n', 1);
    v_timestamp_text := substr(v_first_line, length(v_prefix) + 1);
    begin
      v_occurred_at := v_timestamp_text::timestamptz;
    exception when others then
      raise exception 'invalid Gmail excerpt' using errcode = '22023';
    end;
    if v_occurred_at < timestamptz '2000-01-01 00:00:00+00'
       or v_occurred_at > clock_timestamp() + interval '1 day' then
      raise exception 'invalid Gmail excerpt' using errcode = '22023';
    end if;
    v_body := substr(v_body, length(v_first_line) + 2);
  end if;

  v_body := btrim(regexp_replace(
    v_body, E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g'));
  if v_body = '' then
    return jsonb_build_object('status', 'ignored');
  end if;
  v_body := left(v_body, 4000);

  -- This RPC runs before service_observe_gmail_enquiry_ai. The stored context
  -- therefore still describes the previous provider message. No context means
  -- this is the first observation of a historical thread and is baseline only.
  select g.last_provider_message_id
  into v_previous_message_id
  from crm_private.gmail_thread_contexts g
  where g.artist_id = p_artist_id
    and g.client_id = p_client_id
    and g.provider_thread_id = p_provider_thread_id
  order by g.updated_at desc, g.id desc
  limit 1;

  if not found then
    return jsonb_build_object('status', 'baseline');
  end if;

  if v_previous_message_id is not distinct from p_provider_message_id then
    return jsonb_build_object('status', 'existing');
  end if;

  if p_enquiry_id is not null and not exists (
    select 1 from public.enquiries e
    where e.id = p_enquiry_id
      and e.artist_id = p_artist_id
      and e.client_id = p_client_id
  ) then
    p_enquiry_id := null;
  end if;

  insert into crm_private.gmail_client_ai_excerpts (
    artist_id, workspace_id, client_id, enquiry_id,
    provider_thread_id, provider_message_id, direction, subject,
    body_excerpt, occurred_at
  )
  values (
    p_artist_id, v_workspace, p_client_id, p_enquiry_id,
    p_provider_thread_id, p_provider_message_id, p_direction,
    nullif(left(btrim(coalesce(p_subject, '')), 500), ''),
    v_body, v_occurred_at
  )
  on conflict (artist_id, client_id, provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'existing');
  end if;

  -- Retention follows provider chronology when the Worker supplies it, never
  -- the moment an operator happened to open Gmail.
  delete from crm_private.gmail_client_ai_excerpts x
  where x.artist_id = p_artist_id
    and x.client_id = p_client_id
    and x.id not in (
      select y.id
      from crm_private.gmail_client_ai_excerpts y
      where y.artist_id = p_artist_id and y.client_id = p_client_id
      order by y.occurred_at desc, y.id desc
      limit 5
    );

  perform crm_private.schedule_client_ai_refresh(
    p_artist_id, p_client_id, 'gmail:' || p_provider_message_id
  );

  return jsonb_build_object('status', 'recorded', 'excerpt_id', v_id);
end;
$$;

revoke all on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text
) to service_role;

comment on function public.service_record_gmail_client_message(
  uuid,uuid,uuid,text,text,text,text,text
) is
  'Records only a Gmail message newer than an already-observed thread baseline. Trusted Worker payloads include provider time in a stripped versioned prefix; stored content remains bounded to five excerpts per artist/client and 4000 characters each.';
