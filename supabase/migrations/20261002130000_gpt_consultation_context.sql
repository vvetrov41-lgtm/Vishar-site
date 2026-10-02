-- 20261002130000_gpt_consultation_context.sql
--
-- One read-only answer to "prepare me for this consultation": the appointment,
-- the client, the enquiry and project it belongs to (or an explicitly marked
-- candidate), recent client-scoped communications, notes, the attention facts
-- and the AI state with freshness markers. Spec: specs/consultation-context/.
--
-- Nothing here writes. An unlinked appointment is never linked: a candidate
-- enquiry or project is returned only when exactly one qualifies, and it is
-- labelled as a candidate. Each section is gated by the same GPT ceiling and
-- Artist capability as the existing read RPC for that data; a section the
-- caller may not read is reported as unavailable instead of failing the call.
-- No structured contact field (email, phone, Instagram handle) is returned.

create or replace function public.gpt_get_consultation_context(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_client_row crm_private.gpt_action_clients%rowtype;
  v_artist uuid;
  v_session public.sessions%rowtype;
  v_client public.clients%rowtype;
  v_can_enquiries boolean;
  v_can_comms boolean;
  v_can_finance boolean;
  v_can_crm boolean;
  v_can_crm_read boolean;
  v_enquiry_id uuid;
  v_enquiry_status text;
  v_enquiry_rule text;
  v_enquiry_count integer := 0;
  v_enquiry_candidates jsonb := '[]'::jsonb;
  v_project_id uuid;
  v_project_status text;
  v_project_rule text;
  v_project_count integer := 0;
  v_project_candidates jsonb := '[]'::jsonb;
  v_enquiry jsonb;
  v_project jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_references jsonb;
  v_payments jsonb;
  v_notes jsonb;
  v_comms jsonb;
  v_messages jsonb := '[]'::jsonb;
  v_truncated boolean := false;
  v_snapshot record;
  v_latest_email_at timestamptz;
  v_email_incomplete boolean;
  v_attention jsonb;
  v_ai_full jsonb;
  v_ai jsonb;
  v_ai_status text;
  v_latest_fact timestamptz;
  v_gaps text[] := array[]::text[];
  v_job record;
  v_canonical_cover boolean;
  v_ai_cover boolean;
begin
  -- Same entry contract as the appointment reads, plus client visibility.
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments_read', 'view_sessions');
  v_artist := v_ctx.artist_id;
  perform crm_private.require_artist_access(v_artist, 'view_clients');
  select c.* into v_client_row from crm_private.gpt_action_clients c where c.id = v_ctx.gpt_client_id;

  select s.* into v_session from public.sessions s
  where s.id = p_appointment_id and s.artist_id = v_artist;
  if not found or not crm_private.gpt_client_in_artist_scope(v_session.client_id, v_artist) then
    -- One answer for missing and foreign appointments: existence is not disclosed.
    raise exception 'appointment is unavailable in the active GPT Artist scope' using errcode = '42501';
  end if;
  select cl.* into v_client from public.clients cl where cl.id = v_session.client_id;

  -- Section permissions mirror the existing read RPCs for the same data.
  v_can_enquiries := v_client_row.can_read_enquiries and crm_private.has_artist_capability(v_artist, 'view_enquiries');
  v_can_comms := v_client_row.can_manage_communications and crm_private.has_artist_capability(v_artist, 'manage');
  v_can_finance := v_client_row.can_manage_finance and crm_private.has_artist_capability(v_artist, 'manage_finance');
  -- Projects and internal notes: same as gpt_list_projects / gpt_list_internal_notes.
  v_can_crm := v_client_row.can_manage_crm and crm_private.has_artist_capability(v_artist, 'manage');
  -- Attention and AI state: same as gpt_get_today_pulse / gpt_get_client_ai_state
  -- (crm_read ceiling; view_clients is already required above).
  v_can_crm_read := v_client_row.can_manage_crm or v_client_row.can_read_enquiries;

  -- ------------------------------------------------------------ enquiry link
  -- An unlinked appointment's candidates are enquiry data: without enquiry
  -- read permission the link is reported as not_permitted, not searched.
  if v_session.enquiry_id is not null then
    v_enquiry_id := v_session.enquiry_id;
    v_enquiry_status := 'linked';
  elsif not v_can_enquiries then
    v_enquiry_status := 'not_permitted';
  else
    select count(*), (array_agg(e.id order by e.created_at desc))[1],
           coalesce(jsonb_agg(jsonb_build_object(
             'enquiry_id', e.id, 'reference_number', e.reference_number, 'status', e.status,
             'project_type', e.project_type, 'created_at', e.created_at) order by e.created_at desc), '[]'::jsonb)
      into v_enquiry_count, v_enquiry_id, v_enquiry_candidates
    from public.enquiries e
    where e.client_id = v_session.client_id and e.artist_id = v_artist
      and e.archived_at is null and e.intake_state = 'complete'
      and e.status not in ('declined', 'closed', 'converted');
    if v_enquiry_count = 1 then
      v_enquiry_status := 'candidate';
      v_enquiry_rule := 'single_open_enquiry_for_client';
    elsif v_enquiry_count > 1 then
      v_enquiry_status := 'ambiguous';
      v_enquiry_id := null;
    else
      v_enquiry_status := 'missing';
      v_enquiry_id := null;
    end if;
  end if;

  -- ------------------------------------------------------------ project link
  if v_session.project_id is not null then
    v_project_id := v_session.project_id;
    v_project_status := 'linked';
  elsif not v_can_crm then
    v_project_status := 'not_permitted';
  else
    select count(*), (array_agg(p.id order by p.created_at desc))[1],
           coalesce(jsonb_agg(jsonb_build_object(
             'project_id', p.id, 'status', p.status, 'title', left(p.title, 120),
             'created_at', p.created_at) order by p.created_at desc), '[]'::jsonb)
      into v_project_count, v_project_id, v_project_candidates
    from public.projects p
    where p.client_id = v_session.client_id and p.artist_id = v_artist
      and p.archived_at is null and p.status in ('draft', 'active', 'on_hold');
    if v_project_count = 1 then
      v_project_status := 'candidate';
      v_project_rule := 'single_open_project_for_client';
    elsif v_project_count > 1 then
      v_project_status := 'ambiguous';
      v_project_id := null;
    else
      v_project_status := 'missing';
      v_project_id := null;
    end if;
  end if;

  if v_enquiry_status <> 'linked' then v_gaps := array_append(v_gaps, 'enquiry_not_linked'); end if;
  if v_project_status <> 'linked' then v_gaps := array_append(v_gaps, 'project_not_linked'); end if;
  if v_enquiry_status = 'not_permitted' then v_gaps := array_append(v_gaps, 'enquiry_not_permitted'); end if;
  if v_project_status = 'not_permitted' then v_gaps := array_append(v_gaps, 'project_not_permitted'); end if;

  -- ------------------------------------------------------- enquiry and intake
  if v_enquiry_id is not null and v_can_enquiries then
    select jsonb_build_object(
      'provenance', v_enquiry_status,
      'enquiry_id', e.id, 'reference_number', e.reference_number, 'status', e.status,
      'intake_state', e.intake_state, 'project_type', e.project_type, 'placement', e.placement,
      'approximate_size', e.approximate_size, 'cover_up', e.cover_up,
      'preferred_timing', e.preferred_timing, 'idea', left(e.idea, 2000),
      'discovery_source', e.discovery_source, 'source', e.source,
      'created_at', e.created_at, 'last_action_at', e.last_action_at)
      into v_enquiry
    from public.enquiries e where e.id = v_enquiry_id and e.artist_id = v_artist;

    select jsonb_build_object(
      'enquiry_scope', v_enquiry_status,
      'ready_count', count(*),
      'by_category', coalesce(jsonb_object_agg(x.category, x.n) filter (where x.category is not null), '{}'::jsonb))
      into v_references
    from (select f.category::text as category, count(*) as n
          from public.enquiry_files f
          where f.enquiry_id = v_enquiry_id and f.upload_state = 'ready'
          group by f.category) x;
    v_references := jsonb_set(v_references, '{ready_count}',
      to_jsonb((select coalesce(sum((value)::int), 0) from jsonb_each_text(v_references -> 'by_category'))));

    -- Whitelisted, normalisable intake facts where the AI intake disagrees with
    -- the stored enquiry. The stored enquiry stays authoritative.
    select j.result, j.updated_at into v_job
    from public.enquiry_ai_jobs j
    where j.enquiry_id = v_enquiry_id and j.artist_id = v_artist and j.status = 'succeeded'
    order by j.created_at desc limit 1;
    if found then
      v_canonical_cover := case
        when lower(btrim(v_enquiry ->> 'cover_up')) in ('yes', 'true') then true
        when lower(btrim(v_enquiry ->> 'cover_up')) like 'no%' then false
        else null end;
      v_ai_cover := case v_job.result -> 'fields' -> 'cover_up' ->> 'value'
        when 'true' then true when 'false' then false else null end;
      if v_canonical_cover is not null and v_ai_cover is not null and v_canonical_cover <> v_ai_cover then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'field', 'cover_up', 'canonical_value', v_enquiry ->> 'cover_up',
          'ai_value', v_job.result -> 'fields' -> 'cover_up' -> 'value',
          'ai_status', v_job.result -> 'fields' -> 'cover_up' ->> 'status',
          'ai_updated_at', v_job.updated_at));
      end if;
      if nullif(btrim(v_enquiry ->> 'discovery_source'), '') is not null
         and nullif(btrim(v_job.result -> 'fields' -> 'discovery_source' ->> 'value'), '') is not null
         and lower(btrim(v_enquiry ->> 'discovery_source')) <> lower(btrim(v_job.result -> 'fields' -> 'discovery_source' ->> 'value')) then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'field', 'discovery_source', 'canonical_value', v_enquiry ->> 'discovery_source',
          'ai_value', v_job.result -> 'fields' -> 'discovery_source' -> 'value',
          'ai_status', v_job.result -> 'fields' -> 'discovery_source' ->> 'status',
          'ai_updated_at', v_job.updated_at));
      end if;
    end if;
  elsif v_enquiry_id is not null then
    v_gaps := array_append(v_gaps, 'enquiry_not_permitted');
  end if;

  -- ----------------------------------------------------------------- project
  if v_project_id is not null and v_can_crm then
    select jsonb_strip_nulls(jsonb_build_object(
      'provenance', v_project_status,
      'project_id', p.id, 'status', p.status, 'title', left(p.title, 120),
      'estimated_sessions', p.estimated_sessions, 'estimated_hours', p.estimated_hours,
      'estimate_total', case when v_can_finance then p.estimate_total end,
      'currency', case when v_can_finance then p.currency end,
      'deposit_amount', case when v_can_finance then coalesce(p.deposit_override_amount, p.deposit_amount) end,
      'deposit_status', case when v_can_finance then p.deposit_status end))
      into v_project
    from public.projects p where p.id = v_project_id and p.artist_id = v_artist;
  elsif v_project_id is not null then
    v_gaps := array_append(v_gaps, 'project_not_permitted');
  end if;

  -- ---------------------------------------------------------------- payments
  if v_can_finance then
    select jsonb_build_object('available', true, 'reason', null, 'requests', coalesce(jsonb_agg(x.r order by x.created_at desc), '[]'::jsonb))
      into v_payments
    from (select jsonb_build_object('purpose', pr.purpose, 'amount', pr.amount, 'currency', pr.currency,
                                    'status', pr.status, 'created_at', pr.created_at, 'expires_at', pr.expires_at) as r,
                 pr.created_at
          from public.payment_requests pr
          where pr.artist_id = v_artist
            and (pr.session_id = v_session.id or (v_project_id is not null and pr.project_id = v_project_id))
          order by pr.created_at desc limit 5) x;
  else
    v_payments := jsonb_build_object('available', false, 'reason', 'not_permitted', 'requests', '[]'::jsonb);
    v_gaps := array_append(v_gaps, 'finance_not_permitted');
  end if;

  -- ------------------------------------------------------------------- notes
  -- Only notes tied to this Artist's own records: the appointment, and the
  -- resolved enquiry/project. Client-only notes are excluded because a client
  -- can be shared between Artists.
  if v_can_crm then
    select coalesce(jsonb_agg(x.n order by x.at desc), '[]'::jsonb) into v_notes
    from (
      select jsonb_build_object('source', 'appointment', 'author', null, 'created_at', v_session.updated_at,
                                'body', left(v_session.notes, 1000)) as n, v_session.updated_at as at
      where nullif(btrim(v_session.notes), '') is not null
      union all
      select * from (
        select jsonb_build_object('source', 'internal', 'author', pf.display_name, 'created_at', n.created_at,
                                  'body', left(n.body, 500)) as n, n.created_at as at
        from public.internal_notes n
        left join public.profiles pf on pf.id = n.author_profile_id
        where n.session_id = v_session.id
           or (v_enquiry_id is not null and n.enquiry_id = v_enquiry_id)
           or (v_project_id is not null and n.project_id = v_project_id)
        order by n.created_at desc limit 5
      ) internal_rows
    ) x;
  else
    v_notes := null;
    v_gaps := array_append(v_gaps, 'notes_not_permitted');
  end if;

  -- ---------------------------------------------------------- communications
  if v_can_comms then
    -- Deterministic order (ties broken by channel and id); one extra row is
    -- read only to tell whether the 15-message cap actually dropped anything.
    select coalesce(jsonb_agg(m.msg order by m.rn) filter (where m.rn <= 15), '[]'::jsonb), count(*) > 15
      into v_messages, v_truncated
    from (
      select * from (
        select jsonb_build_object(
                 'channel', all_msgs.channel, 'direction', all_msgs.direction, 'at', all_msgs.at,
                 'body', all_msgs.body, 'attachment_count', all_msgs.attachment_count,
                 'status', all_msgs.status, 'source_id', all_msgs.source_id) as msg,
               row_number() over (order by all_msgs.at desc nulls last, all_msgs.channel, all_msgs.source_id) as rn
        from (
          select m.channel::text as channel, m.direction::text as direction,
                 coalesce(m.provider_timestamp, m.sent_at, m.created_at) as at,
                 left(m.body, 600) as body,
                 case when jsonb_typeof(m.attachments) = 'array' then jsonb_array_length(m.attachments) else 0 end as attachment_count,
                 case when m.direction = 'outbound' then m.status::text end as status,
                 m.id as source_id
          from public.communication_messages m
          join public.communication_conversations c on c.id = m.conversation_id
          where c.artist_id = v_artist and m.artist_id = v_artist
            and (c.client_id = v_session.client_id or (v_enquiry_id is not null and c.enquiry_id = v_enquiry_id))
          union all
          select 'email_crm', 'outbound', coalesce(em.sent_at, em.created_at), left(em.body, 600), 0, 'sent', em.id
          from public.email_messages em
          where em.artist_id = v_artist and em.client_id = v_session.client_id and em.status = 'sent'
          union all
          select 'email_gmail_ingested', gx.direction, gx.occurred_at, left(gx.body_excerpt, 600), 0, null, gx.id
          from crm_private.gmail_client_ai_excerpts gx
          where gx.artist_id = v_artist and gx.client_id = v_session.client_id
            and not exists (select 1 from public.email_messages em2
                            where em2.artist_id = v_artist and em2.provider_message_id is not null
                              and em2.provider_message_id = gx.provider_message_id)
        ) all_msgs
        order by all_msgs.at desc nulls last, all_msgs.channel, all_msgs.source_id
        limit 16
      ) limited
    ) m;

    select g.last_message_at, g.direction, g.refreshed_at into v_snapshot
    from public.gmail_client_metadata_snapshots g
    where g.artist_id = v_artist and g.client_id = v_session.client_id;

    select max((x ->> 'at')::timestamptz) into v_latest_email_at
    from jsonb_array_elements(v_messages) x
    where x ->> 'channel' in ('email_crm', 'email_gmail_ingested');

    -- Tri-state: true proven behind, false proven current, null unknown.
    if v_snapshot.last_message_at is null then
      v_email_incomplete := null;
    elsif v_latest_email_at is null or v_snapshot.last_message_at > v_latest_email_at + interval '1 minute' then
      v_email_incomplete := true;
    else
      v_email_incomplete := false;
    end if;
    if v_email_incomplete then v_gaps := array_append(v_gaps, 'email_history_incomplete'); end if;
    if jsonb_array_length(v_messages) = 0 then v_gaps := array_append(v_gaps, 'no_messages'); end if;

    v_comms := jsonb_build_object(
      'available', true, 'reason', null,
      'untrusted_content', true,
      'messages', v_messages,
      'per_channel', coalesce((
        select jsonb_object_agg(ch.channel, jsonb_build_object(
                 'last_inbound_at', ch.last_in, 'last_outbound_at', ch.last_out, 'message_count_returned', ch.n))
        from (select x ->> 'channel' as channel,
                     max((x ->> 'at')::timestamptz) filter (where x ->> 'direction' = 'inbound') as last_in,
                     max((x ->> 'at')::timestamptz) filter (where x ->> 'direction' = 'outbound') as last_out,
                     count(*) as n
              from jsonb_array_elements(v_messages) x group by 1) ch), '{}'::jsonb),
      'last_inbound_at', (select max((x ->> 'at')::timestamptz) from jsonb_array_elements(v_messages) x where x ->> 'direction' = 'inbound'),
      'last_outbound_at', (select max((x ->> 'at')::timestamptz) from jsonb_array_elements(v_messages) x where x ->> 'direction' = 'outbound'),
      'last_writer', case v_messages -> 0 ->> 'direction' when 'inbound' then 'client' when 'outbound' then 'studio' end,
      'email_snapshot', case when v_snapshot.last_message_at is null and v_snapshot.refreshed_at is null then null
                             else jsonb_build_object('last_message_at', v_snapshot.last_message_at,
                                                     'direction', v_snapshot.direction,
                                                     'refreshed_at', v_snapshot.refreshed_at) end,
      'email_history_incomplete', v_email_incomplete,
      'truncated', v_truncated);
  else
    v_comms := jsonb_build_object('available', false, 'reason', 'not_permitted', 'untrusted_content', true,
                                  'messages', '[]'::jsonb, 'email_history_incomplete', null);
    v_gaps := array_append(v_gaps, 'communications_not_permitted');
  end if;

  -- --------------------------------------------------------------- attention
  if v_can_crm_read then
  select jsonb_build_object(
    'workflow_stage', a ->> 'workflow_stage',
    'reply_state', a ->> 'reply_state',
    'last_speaker', a ->> 'last_speaker',
    'sla_state', a ->> 'sla_state',
    'sla_reason', a ->> 'sla_reason',
    'waiting_on', case
      when a ->> 'last_speaker' = 'client' and coalesce(a ->> 'reply_state', '') not in ('no_reply_needed', 'handled') then 'studio'
      when a ->> 'last_speaker' = 'studio' then 'client'
      else null end,
    'conflicts', coalesce(a -> 'conflicts', '[]'::jsonb))
    into v_attention
  from (select crm_private.client_attention(v_artist, v_session.client_id) as a) t;
  else
    v_attention := null;
    v_gaps := array_append(v_gaps, 'attention_not_permitted');
  end if;

  -- ---------------------------------------------------------------- AI state
  if v_can_crm_read then
    begin
      v_ai_full := public.get_client_ai_state(v_artist, v_session.client_id);
    exception when others then
      v_ai_full := jsonb_build_object('status', 'unavailable');
    end;
  else
    v_ai_full := jsonb_build_object('status', 'not_permitted');
  end if;
  v_ai_status := case
    when v_ai_full ->> 'status' = 'not_permitted' then 'not_permitted'
    when v_ai_full ->> 'status' = 'ready' then 'ready'
    when v_ai_full ->> 'status' = 'not_generated' and coalesce((v_ai_full ->> 'enabled')::boolean, false) then 'not_generated'
    when v_ai_full ->> 'status' = 'not_generated' then 'disabled'
    else 'unavailable' end;

  select max(t) into v_latest_fact from (
    select (x ->> 'at')::timestamptz as t from jsonb_array_elements(v_messages) x
    union all select (x ->> 'created_at')::timestamptz from jsonb_array_elements(coalesce(v_notes, '[]'::jsonb)) x
    union all select case when v_can_comms then v_snapshot.last_message_at end
  ) facts;

  v_ai := jsonb_build_object(
    'status', v_ai_status,
    'summary', case when v_ai_status = 'ready' then v_ai_full -> 'summary' end,
    'brief', case when v_ai_status = 'ready' then v_ai_full -> 'brief' end,
    'missing_information', case when v_ai_status = 'ready' then v_ai_full -> 'missing_information' end,
    'refreshed_at', case when v_ai_status = 'ready' then v_ai_full -> 'refreshed_at' end,
    'is_stale', case when v_ai_status = 'ready' then v_ai_full -> 'is_stale' end,
    -- Tri-state: null whenever there is no AI state or no comparable fact.
    'older_than_latest_fact', case
      when v_ai_status <> 'ready' or v_ai_full ->> 'refreshed_at' is null or v_latest_fact is null then null
      else (v_ai_full ->> 'refreshed_at')::timestamptz < v_latest_fact end,
    'next_action', case when v_ai_status = 'ready' and v_ai_full -> 'next_action' is not null
                          and jsonb_typeof(v_ai_full -> 'next_action') = 'object' then jsonb_build_object(
      'action_type', v_ai_full -> 'next_action' -> 'action_type',
      'reason', v_ai_full -> 'next_action' -> 'reason',
      'priority', v_ai_full -> 'next_action' -> 'priority',
      'created_at', v_ai_full -> 'next_action' -> 'created_at',
      'is_stale', v_ai_full -> 'next_action' -> 'is_stale',
      'has_draft', nullif(btrim(coalesce(v_ai_full -> 'next_action' ->> 'draft_reply', '')), '') is not null) end);

  return jsonb_build_object(
    'contract_version', 1,
    'generated_at', clock_timestamp(),
    'appointment', jsonb_build_object(
      'appointment_id', v_session.id, 'appointment_type', v_session.appointment_type,
      'status', v_session.status, 'start_at', v_session.start_at, 'end_at', v_session.end_at,
      'notes', case when v_can_crm then left(v_session.notes, 1000) end,
      'enquiry_id', v_session.enquiry_id, 'project_id', v_session.project_id,
      'client_response', v_session.client_response,
      'created_at', v_session.created_at, 'updated_at', v_session.updated_at),
    'client', jsonb_build_object(
      'client_id', v_client.id, 'name', v_client.full_name,
      'preferred_contact', v_client.preferred_contact, 'travelling_from', v_client.travelling_from),
    'enquiry_link', jsonb_build_object(
      'status', v_enquiry_status,
      'linked_enquiry_id', case when v_enquiry_status = 'linked' then v_enquiry_id end,
      'candidate_enquiry_id', case when v_enquiry_status = 'candidate' then v_enquiry_id end,
      'candidate_rule', v_enquiry_rule,
      'candidate_count', case when v_enquiry_status = 'linked' then 0 else v_enquiry_count end,
      'candidates', case when v_enquiry_status = 'ambiguous'
                         then (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_enquiry_candidates) x limit 5) y)
                         else '[]'::jsonb end),
    'enquiry', v_enquiry,
    'intake_ai_conflicts', v_conflicts,
    'project_link', jsonb_build_object(
      'status', v_project_status,
      'linked_project_id', case when v_project_status = 'linked' then v_project_id end,
      'candidate_project_id', case when v_project_status = 'candidate' then v_project_id end,
      'candidate_rule', v_project_rule,
      'candidate_count', case when v_project_status = 'linked' then 0 else v_project_count end,
      'candidates', case when v_project_status = 'ambiguous'
                         then (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_project_candidates) x limit 5) y)
                         else '[]'::jsonb end),
    'project', v_project,
    'payments', v_payments,
    'references', v_references,
    'notes', v_notes,
    'communications', v_comms,
    'attention', v_attention,
    'ai', v_ai,
    'gaps', to_jsonb(v_gaps));
end;
$$;

revoke all on function public.gpt_get_consultation_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_consultation_context(uuid) to authenticated;

comment on function public.gpt_get_consultation_context(uuid) is
  'Read-only consultation context for one appointment of the active GPT Artist: appointment, client (no contact fields), linked or explicitly candidate enquiry/project, intake facts the AI disagrees with, bounded client-scoped communications (untrusted content), notes, attention facts and AI state with tri-state freshness markers. Sections the caller may not read are reported as unavailable.';
