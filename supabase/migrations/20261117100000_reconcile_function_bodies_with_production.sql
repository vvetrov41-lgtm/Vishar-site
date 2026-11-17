-- Reconcile six function bodies with the production database.
--
-- Production was found to run different bodies for these functions than the
-- repository's migrations produce. ACL, owner, search_path, SECURITY DEFINER
-- and volatility already match; only the bodies differ. Each statement below
-- is the exact pg_get_functiondef() output read from production on
-- 2026-11-17, so applying this migration to production rewrites each body
-- with itself and changes no behaviour there.
--
-- Behavioural difference (repository version was missing a guard):
--   public.gpt_send_communication_reply routes a WhatsApp conversation through
--   public.queue_whatsapp_message, which refuses free-form text once the
--   client's 24-hour customer-service window has closed (SQLSTATE 23514)
--   before any message or outbox row is created. The repository version
--   called public.queue_communication_message directly and skipped that check.
--
-- Comment and whitespace differences only (no behaviour change):
--   crm_private.client_ai_action_requests_attached_references
--   public.gpt_send_whatsapp_message
--   public.queue_whatsapp_message
--   public.retry_client_lifecycle_job
--   public.service_telegram_client_ai_digest
--
-- The comments that production lacks are kept in the earlier migrations that
-- introduced these functions; supabase/function-manifest.json now records the
-- full definition of every function so later drift is caught in CI and after
-- each release.

CREATE OR REPLACE FUNCTION public.gpt_send_communication_reply(p_conversation_id uuid, p_body text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_conversation public.communication_conversations%rowtype;
begin
  v_conversation := crm_private.gpt_communication_conversation(p_conversation_id);

  if v_conversation.channel = 'whatsapp'::public.communication_channel then
    return public.queue_whatsapp_message(v_conversation.id, p_body, p_request_id);
  end if;

  return public.queue_communication_message(v_conversation.id, p_body, p_request_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.queue_whatsapp_message(p_conversation_id uuid, p_body text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_channel public.communication_channel;
  v_last_inbound_at timestamptz;
begin
  select c.channel, c.last_inbound_at
    into v_channel, v_last_inbound_at
  from public.communication_conversations c
  where c.id = p_conversation_id;

  if not found then
    raise exception 'whatsapp conversation was not found' using errcode = '23503';
  end if;

  if v_channel <> 'whatsapp'::public.communication_channel then
    raise exception 'whatsapp conversation was not found' using errcode = '23503';
  end if;

  -- Meta only allows arbitrary/free-form WhatsApp text while the customer
  -- service window opened by the client's most recent inbound message is live.
  -- Fail before creating a message/outbox row so callers never receive a false
  -- "queued" result for a request the provider will reject asynchronously.
  if v_last_inbound_at is null
     or v_last_inbound_at < now() - interval '24 hours' then
    raise exception 'WhatsApp free-form window is closed for this client'
      using errcode = '23514',
            detail = 'No client WhatsApp message has been received within the last 24 hours.',
            hint = 'Use an approved WhatsApp template to reopen the conversation, or contact the client by email. After the client replies on WhatsApp, free-form messages can be sent for 24 hours.';
  end if;

  return public.queue_communication_message(p_conversation_id, p_body, p_request_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.gpt_send_whatsapp_message(p_conversation_id uuid, p_body text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_artist_id uuid;
  v_conversation_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select wc.artist_id into v_conversation_artist
  from public.whatsapp_conversations wc where wc.id = p_conversation_id;
  if v_conversation_artist is distinct from v_artist_id then
    raise exception 'WhatsApp conversation is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.queue_whatsapp_message(p_conversation_id, p_body, p_request_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.retry_client_lifecycle_job(p_job_id uuid)
 RETURNS TABLE(job_id uuid, job_status automation_job_status, attempt_count integer, scheduled_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.automation_jobs%rowtype;
  v_rule public.automation_rules%rowtype;
  v_previous_error text;
begin
  select j.* into v_job
  from public.automation_jobs j
  where j.id = p_job_id
  for update;

  if not found then
    raise exception 'the lifecycle execution is unavailable'
      using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_job.artist_id, 'manage_automations');
  perform crm_private.require_active_artist(v_job.artist_id);

  select r.* into v_rule
  from public.automation_rules r
  where r.id = v_job.rule_id
    and r.artist_id = v_job.artist_id;

  if v_job.status <> 'failed'::public.automation_job_status
     or v_job.action_type <> 'send_client_message'::public.automation_action_type
     or v_job.schedule_anchor not in (
       'session_start'::public.automation_schedule_anchor,
       'session_end'::public.automation_schedule_anchor
     )
     or v_job.message_channel <> 'email'::public.message_template_channel
     or v_job.condition_appointment_type is null
     or v_job.message_purpose is null
     or v_job.session_id is null
     or not found
     or not v_rule.is_enabled
     or v_rule.version <> v_job.rule_version then
    raise exception 'the lifecycle execution is not retryable'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.email_messages m
    where m.automation_job_id = v_job.id
  ) then
    raise exception 'the lifecycle execution is not retryable'
      using errcode = '22023';
  end if;

  v_previous_error := v_job.last_error_category;

  update public.automation_jobs j
  set status = 'pending'::public.automation_job_status,
      last_error_category = null,
      completed_at = null,
      cancelled_at = null,
      updated_at = now()
  where j.id = v_job.id;

  perform crm_private.log_artist_activity(
    v_job.artist_id,
    'automation.job_requeued',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object(
      'job_id', v_job.id,
      'previous_failure_category', v_previous_error,
      'attempt_count', v_job.attempt_count
    )
  );

  return query
  select v_job.id,
         'pending'::public.automation_job_status,
         v_job.attempt_count,
         v_job.scheduled_at;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_telegram_client_ai_digest(p_chat_id text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_profile uuid;
  v_items jsonb;
  v_total integer := 0;
  v_stale integer := 0;
  v_requeue jsonb := '[]'::jsonb;
  v_state_stale integer := 0;
  v_state_requeue jsonb := '[]'::jsonb;
  v_row record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid Telegram chat id' using errcode = '22023';
  end if;

  select d.profile_id into v_profile
  from crm_private.telegram_destinations d
  join public.profiles p on p.id = d.profile_id and p.is_active
  join public.notification_preferences pref
    on pref.profile_id = d.profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where d.chat_id = p_chat_id
    and d.destination_kind = 'profile'
    and d.is_active;

  if not found then
    return jsonb_build_object(
      'status', 'empty', 'items', '[]'::jsonb, 'total', 0, 'refreshing', 0
    );
  end if;

  with candidates as (
    select a.id, a.artist_id, a.client_id, a.action_type, a.priority,
           a.created_at, a.source_watermark,
           left(c.full_name, 80) as client_name,
           left(ar.display_name, 80) as artist_name,
           left(a.reason, 300) as reason
    from public.client_ai_next_actions a
    join public.artists ar on ar.id = a.artist_id and ar.is_active
    join public.clients c on c.id = a.client_id and c.archived_at is null
    where a.status = 'open'
      and a.action_type not in ('no_action', 'await_client')
      and crm_private.profile_can_receive_notification(
        v_profile, a.artist_id, ar.workspace_id
      )
      and exists (
        select 1
        from public.artist_memberships am
        where am.artist_id = a.artist_id
          and am.profile_id = v_profile
          and am.is_active
      )
      and crm_private.client_ai_scope(a.artist_id, a.client_id) is not null
    order by
      case a.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      a.created_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ), measured as (
    select k.*,
           crm_private.client_ai_watermark(k.artist_id, k.client_id) as current_watermark
    from candidates k
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'client_name', m.client_name,
      'artist_name', m.artist_name,
      'action_type', m.action_type,
      'reason', m.reason,
      'priority', m.priority,
      'created_at', m.created_at
    ) order by
      case m.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      m.created_at desc) filter (
        where m.current_watermark is not distinct from m.source_watermark
      ), '[]'::jsonb),
    count(*) filter (
      where m.current_watermark is not distinct from m.source_watermark
    )::integer,
    count(*) filter (
      where m.current_watermark is distinct from m.source_watermark
    )::integer,
    coalesce(jsonb_agg(jsonb_build_array(
      m.artist_id, m.client_id, m.current_watermark
    )) filter (
      where m.current_watermark is distinct from m.source_watermark
    ), '[]'::jsonb)
  into v_items, v_total, v_stale, v_requeue
  from measured m;

  with state_candidates as (
    select st.artist_id, st.client_id, st.source_watermark,
           st.refreshed_at, ar.workspace_id
    from public.client_ai_state st
    join public.artists ar on ar.id = st.artist_id and ar.is_active
    join public.clients c on c.id = st.client_id and c.archived_at is null
    where crm_private.profile_can_receive_notification(
        v_profile, st.artist_id, ar.workspace_id
      )
      and exists (
        select 1
        from public.artist_memberships am
        where am.artist_id = st.artist_id
          and am.profile_id = v_profile
          and am.is_active
      )
      and crm_private.client_ai_scope(st.artist_id, st.client_id) is not null
      and not exists (
        select 1
        from public.client_ai_next_actions a
        where a.artist_id = st.artist_id
          and a.client_id = st.client_id
          and a.status = 'open'
          and a.action_type not in ('no_action', 'await_client')
      )
    order by st.refreshed_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ), measured_states as (
    select s.*,
           crm_private.client_ai_watermark(s.artist_id, s.client_id) as current_watermark
    from state_candidates s
  )
  select
    count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_array(
      s.artist_id, s.client_id, s.current_watermark
    )), '[]'::jsonb)
  into v_state_stale, v_state_requeue
  from measured_states s
  where s.current_watermark is distinct from s.source_watermark;

  v_stale := v_stale + coalesce(v_state_stale, 0);
  v_requeue := v_requeue || coalesce(v_state_requeue, '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_requeue) loop
    begin
      perform crm_private.schedule_client_ai_refresh(
        (v_row.value->>0)::uuid,
        (v_row.value->>1)::uuid,
        'stale:' || left(v_row.value->>2, 32)
      );
    exception when others then null;
    end;
  end loop;

  return jsonb_build_object(
    'status', case when v_total = 0 then 'empty' else 'ready' end,
    'items', v_items,
    'total', v_total,
    'refreshing', v_stale
  );
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.client_ai_action_requests_attached_references(p_reason text, p_draft_reply text, p_missing_information jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_text text := lower(coalesce(p_reason, '') || ' ' || coalesce(p_draft_reply, ''));
  v_missing jsonb := case
    when jsonb_typeof(coalesce(p_missing_information, '[]'::jsonb)) = 'array'
      then coalesce(p_missing_information, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_qualified boolean;
begin
  v_qualified := v_text ~ '(additional|another|more|extra|specific|clearer|updated|different).{0,60}(reference|image|photo)';

  if not v_qualified and exists (
    select 1
    from jsonb_array_elements_text(v_missing) x(value)
    where lower(x.value) ~ '(^|[_ -])reference(s|[_ -]?(image|photo)s?)?([_ -]|$)'
  ) then
    return true;
  end if;

  if not v_qualified and (
    v_text ~ '(send|provide|share|upload|attach|supply).{0,80}(reference|reference image|reference photo)'
    or v_text ~ '(reference|reference image|reference photo).{0,80}(send|provide|share|upload|attach|supply)'
  ) then
    return true;
  end if;

  return false;
end;
$function$;
