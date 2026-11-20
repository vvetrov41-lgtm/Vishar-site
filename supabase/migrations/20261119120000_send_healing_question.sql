-- 20261119120000_send_healing_question.sql
--
-- Google review request, phase 2a (specs/google-review-request): the artist
-- presses "Ask" on a healing suggestion and the CRM queues the Meta-approved
-- Utility template vishar_healing_check_v1 on the client's WhatsApp
-- conversation. Nothing is sent automatically; this only adds the button's
-- server side.
--
-- * public.review_requests gains healing_message_id (the queued question).
-- * crm_private.healing_check_whatsapp_payloads holds the template name,
--   language and the single body parameter (client first name) for the
--   trusted WhatsApp drain. No browser role can read or write it.
-- * crm_private.healing_check_template_ready: the artist's healing_check
--   candidate is Meta APPROVED, matches name/language and was verified
--   recently. The maintenance poller re-verifies candidates every 24 hours,
--   so 48 hours of freshness tolerates one late poll; Meta still refuses a
--   paused template at send time.
-- * public.send_healing_question(artist, anchor visit, operation): requires
--   send_communications, sends only for a visit that is currently suggested
--   (same rules and list as list_review_suggestions), refuses suppressed or
--   archived clients, a missing open WhatsApp conversation, an ambiguous
--   WhatsApp route or an unapproved template. Idempotent per operation id
--   and serialised per visit with the phase 1 advisory lock.
-- * public.service_resolve_whatsapp_lifecycle_payload also resolves healing
--   payloads (purpose healing_check) and re-checks the same conditions at
--   send time. Automated lifecycle payloads are resolved exactly as before.

alter table public.review_requests
  add column healing_message_id uuid unique references public.communication_messages(id) on delete set null;

create table crm_private.healing_check_whatsapp_payloads (
  communication_message_id uuid primary key references public.communication_messages(id) on delete cascade,
  review_request_id uuid not null unique references public.review_requests(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  template_name text not null check (template_name = 'vishar_healing_check_v1'),
  template_language text not null check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  body_parameters jsonb not null check (
    jsonb_typeof(body_parameters) = 'array' and jsonb_array_length(body_parameters) = 1
    and jsonb_typeof(body_parameters -> 0) = 'string'
    and char_length(body_parameters ->> 0) between 1 and 60),
  created_at timestamptz not null default now()
);

alter table crm_private.healing_check_whatsapp_payloads enable row level security;
alter table crm_private.healing_check_whatsapp_payloads force row level security;
revoke all on table crm_private.healing_check_whatsapp_payloads from public, anon, authenticated, service_role;

create or replace function crm_private.healing_check_template_ready(
  p_artist_id uuid,
  p_template_name text,
  p_template_language text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select exists (
    select 1 from crm_private.lifecycle_whatsapp_template_candidates c
    where c.artist_id = p_artist_id and c.purpose = 'healing_check'
      and c.template_name = p_template_name
      and c.template_language = p_template_language
      and c.approval_status = 'APPROVED' and c.provider_template_id is not null
      and c.verified_at > now() - interval '48 hours'
  );
$fn$;

revoke all on function crm_private.healing_check_template_ready(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.send_healing_question(
  p_artist_id uuid,
  p_anchor_session_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_now timestamptz := clock_timestamp();
  v_suggestion jsonb;
  v_client public.clients%rowtype;
  v_row public.review_requests%rowtype;
  v_result jsonb;
  v_template crm_private.lifecycle_whatsapp_template_candidates%rowtype;
  v_conversation public.communication_conversations%rowtype;
  v_route_count integer;
  v_first text;
  v_message_id uuid;
  v_outbox_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'send_communications');

  if p_operation_id is null or p_anchor_session_id is null then
    raise exception 'a visit and an operation id are required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('review_request:' || p_anchor_session_id::text, 0));

  select o.result into v_result
  from crm_private.review_request_operations o
  where o.operation_id = p_operation_id;
  if found then
    if v_result ->> 'anchor_session_id' <> p_anchor_session_id::text
       or v_result ->> 'artist_id' <> p_artist_id::text
       or v_result ->> 'state' <> 'healing_asked' then
      raise exception 'operation id was used for another decision' using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Only a visit the artist can currently see as a suggestion: the same
  -- eligibility rules as list_review_suggestions (attended, 28-180 days, no
  -- later booking, no suppression, not asked or dismissed, snooze expired).
  select s into v_suggestion
  from jsonb_array_elements(crm_private.review_suggestions(p_artist_id, v_now) -> 'suggestions') s
  where s ->> 'anchor_session_id' = p_anchor_session_id::text;
  if v_suggestion is null then
    raise exception 'this visit is not a current healing suggestion' using errcode = '55000';
  end if;

  select * into v_client from public.clients
  where id = (v_suggestion ->> 'client_id')::uuid and archived_at is null;
  if not found then
    raise exception 'client is not available' using errcode = '55000';
  end if;
  if crm_private.client_send_block_reason(v_client.id, 'whatsapp', 'service') is not null then
    raise exception 'client does not accept WhatsApp messages' using errcode = '55000';
  end if;

  select * into v_template from crm_private.lifecycle_whatsapp_template_candidates c
  where c.artist_id = p_artist_id and c.purpose = 'healing_check';
  if not found or not crm_private.healing_check_template_ready(
       p_artist_id, v_template.template_name, v_template.template_language) then
    raise exception 'the healing question template is not approved for this artist' using errcode = '55000';
  end if;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.artist_id = p_artist_id and c.client_id = v_client.id
    and c.channel = 'whatsapp' and c.link_state = 'linked' and c.state = 'open'
  order by c.last_message_at desc nulls last, c.created_at desc, c.id
  limit 1
  for update;
  if not found then
    raise exception 'client has no open WhatsApp conversation' using errcode = '55000';
  end if;

  select count(*) into v_route_count
  from public.artist_integrations i
  where i.artist_id = p_artist_id and i.integration_type = 'whatsapp'
    and i.provider = 'meta_cloud_api' and i.is_enabled
    and i.integration_key = v_conversation.integration_key;
  if v_route_count <> 1 then
    raise exception 'WhatsApp is not connected for this conversation' using errcode = '55000';
  end if;

  v_first := nullif(split_part(btrim(v_client.full_name), ' ', 1), '');
  if v_first is null or char_length(v_first) > 60 then
    raise exception 'client first name is not usable in the template' using errcode = '55000';
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, created_by
  ) values (
    v_conversation.id, p_artist_id, 'whatsapp', 'outbound', 'crm', 'queued',
    'template', crm_private.healing_question_draft(v_client.full_name), auth.uid()
  )
  returning id into v_message_id;

  select * into v_row from public.review_requests
  where anchor_session_id = p_anchor_session_id
  for update;
  if v_row.id is not null then
    update public.review_requests set
      state = 'healing_asked',
      snoozed_until = null,
      healing_asked_at = v_now,
      healing_message_id = v_message_id,
      last_operation_id = p_operation_id,
      version = version + 1,
      updated_by = auth.uid(),
      updated_at = v_now
    where id = v_row.id
    returning * into v_row;
  else
    insert into public.review_requests (
      artist_id, client_id, anchor_session_id, state, healing_asked_at,
      healing_message_id, last_operation_id, created_by, updated_by,
      created_at, updated_at
    ) values (
      p_artist_id, v_client.id, p_anchor_session_id, 'healing_asked', v_now,
      v_message_id, p_operation_id, auth.uid(), auth.uid(), v_now, v_now
    )
    returning * into v_row;
  end if;

  insert into crm_private.healing_check_whatsapp_payloads (
    communication_message_id, review_request_id, artist_id, client_id,
    template_name, template_language, body_parameters
  ) values (
    v_message_id, v_row.id, p_artist_id, v_client.id,
    v_template.template_name, v_template.template_language, jsonb_build_array(v_first)
  );

  insert into public.integration_outbox (
    kind, dedupe_key, payload, artist_id, client_id, project_id, communication_message_id
  ) values (
    'whatsapp_message', 'whatsapp:healing_check:' || v_row.id::text,
    jsonb_build_object('communication_message_id', v_message_id),
    p_artist_id, v_client.id, nullif(v_suggestion ->> 'project_id', '')::uuid, v_message_id
  )
  returning id into v_outbox_id;

  update public.communication_conversations
  set last_message_at = v_now, last_outbound_at = v_now
  where id = v_conversation.id;

  perform crm_private.log_artist_activity(
    p_artist_id, 'whatsapp.healing_question_queued',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), v_client.id, null, nullif(v_suggestion ->> 'project_id', '')::uuid,
    p_anchor_session_id, null,
    jsonb_build_object('review_request', v_row.id, 'communication_message_id', v_message_id,
                       'outbox', v_outbox_id)
  );

  v_result := to_jsonb(v_row) - 'created_by' - 'updated_by';
  insert into crm_private.review_request_operations (operation_id, review_request_id, action, result)
  values (p_operation_id, v_row.id, 'ask_healing', v_result);
  return v_result;
end;
$fn$;

revoke all on function public.send_healing_question(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.send_healing_question(uuid, uuid, uuid) to authenticated;

-- Patch the live resolver in place (as earlier allowlist migrations do), so
-- every automated-lifecycle condition stays byte-for-byte as deployed. Each
-- anchor must occur exactly once; otherwise the migration fails closed.
do $resolver$
declare
  v_signature constant text := 'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)';
  v_source text;
  v_old text[] := array[
    E' select p.automation_job_id is not null,m.id,o.artist_id,\n   p.template_name,p.template_language,p.purpose,p.body_parameters,\n   (\n',
    E'   ) as delivery_allowed\n',
    E' left join public.automation_jobs j on j.id=p.automation_job_id\n'
  ];
  v_new text[] := array[
    E' select (p.automation_job_id is not null or h.communication_message_id is not null),m.id,o.artist_id,\n'
    || E'   coalesce(p.template_name,h.template_name),\n'
    || E'   coalesce(p.template_language,h.template_language),\n'
    || E'   coalesce(p.purpose,case when h.communication_message_id is not null then ''healing_check'' end),\n'
    || E'   coalesce(p.body_parameters,h.body_parameters),\n'
    || E'   coalesce(case when h.communication_message_id is not null then (\n'
    || E'     -- Artist-initiated healing question (specs/google-review-request):\n'
    || E'     -- no automation job or lifecycle rollout gate; the artist pressed Ask.\n'
    || E'     m.message_type=''template''\n'
    || E'     and m.status=''queued''::public.communication_status\n'
    || E'     and m.artist_id=o.artist_id\n'
    || E'     and o.client_id=h.client_id\n'
    || E'     and rr.artist_id=o.artist_id and rr.client_id=h.client_id\n'
    || E'     and rr.state=''healing_asked'' and rr.healing_message_id=m.id\n'
    || E'     and exists (select 1 from public.clients cl\n'
    || E'       where cl.id=h.client_id and cl.archived_at is null)\n'
    || E'     and crm_private.client_send_block_reason(h.client_id,''whatsapp'',''service'') is null\n'
    || E'     -- The same suppressions that hide a healing suggestion.\n'
    || E'     and not exists (\n'
    || E'       select 1 from public.communication_suppressions cs\n'
    || E'       where cs.client_id=h.client_id and cs.is_active\n'
    || E'         and cs.reason in (''unsubscribed'',''complained'',''blocked'',''manual'')\n'
    || E'     )\n'
    || E'     and exists (\n'
    || E'       select 1 from public.communication_conversations c\n'
    || E'       where c.id=m.conversation_id and c.client_id=h.client_id\n'
    || E'         and c.artist_id=o.artist_id and c.channel=''whatsapp''\n'
    || E'         and c.state=''open'' and c.link_state=''linked''\n'
    || E'     )\n'
    || E'     and crm_private.healing_check_template_ready(o.artist_id,h.template_name,h.template_language)\n'
    || E'   ) else (\n',
    E'   ) end,false) as delivery_allowed\n',
    E' left join crm_private.healing_check_whatsapp_payloads h\n'
    || E'   on h.communication_message_id=m.id and h.artist_id=o.artist_id\n'
    || E' left join public.review_requests rr on rr.id=h.review_request_id\n'
    || E' left join public.automation_jobs j on j.id=p.automation_job_id\n'
  ];
  i integer;
begin
  select pg_get_functiondef(v_signature::regprocedure) into v_source;
  if v_source is null or position('healing_check_whatsapp_payloads' in v_source) > 0 then
    raise exception 'lifecycle resolver drift' using errcode = '23514';
  end if;
  for i in 1 .. array_length(v_old, 1) loop
    if (length(v_source) - length(replace(v_source, v_old[i], ''))) <> length(v_old[i]) then
      raise exception 'lifecycle resolver anchor % not found exactly once', i using errcode = '23514';
    end if;
    v_source := replace(v_source, v_old[i], v_new[i]);
  end loop;
  execute v_source;
end;
$resolver$;
