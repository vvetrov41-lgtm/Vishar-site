-- 20261119130000_review_request_followups.sql
--
-- Google review request, phase 2b (specs/google-review-request): after the
-- healing question, show the client's reply to the artist and let the artist
-- ask for a Google review, or close the request. Nothing is sent
-- automatically; the review message is sent only when the artist presses
-- Send, with text the artist can edit.
--
-- * public.review_requests gains reply_message_id and review_message_id.
-- * crm_private.review_request_reply(request): the client's latest inbound
--   message in the healing question's conversation, after the question and
--   at most 21 days later. Computed on read; there is no trigger.
-- * crm_private.review_request_draft(url): the editable review text.
-- * public.list_review_followups(artist): requests waiting for a reply and
--   requests the client answered, with the reply text, the draft and whether
--   the artist has a review link. Needs view_clients and view_communications.
--   Requests without a reply after 21 days drop off silently.
-- * public.ask_for_review(artist, request, operation, body): needs
--   send_communications and a configured review link; the request must be
--   healing_asked with a reply. Sends the text through
--   public.queue_whatsapp_message, so WhatsApp's 24-hour customer window is
--   enforced (23514 when it has closed). Idempotent per operation id.
-- * public.close_review_request(artist, request, operation): "don't ask" or
--   "needs attention" after a reply; no message is sent.

alter table public.review_requests
  add column reply_message_id uuid references public.communication_messages(id) on delete set null,
  add column review_message_id uuid references public.communication_messages(id) on delete set null;

create or replace function crm_private.review_request_reply(p_request_id uuid)
returns public.communication_messages
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
  select m.*
  from public.review_requests rr
  join public.communication_messages q on q.id = rr.healing_message_id
  join public.communication_messages m
    on m.conversation_id = q.conversation_id and m.artist_id = rr.artist_id
  where rr.id = p_request_id
    and m.direction = 'inbound'
    and m.created_at > rr.healing_asked_at
    and m.created_at <= rr.healing_asked_at + interval '21 days'
  order by m.created_at desc, m.id desc
  limit 1;
$fn$;

revoke all on function crm_private.review_request_reply(uuid) from public, anon, authenticated, service_role;

create or replace function crm_private.review_request_draft(p_review_url text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select 'So glad to hear it healed well! If you have a minute, a Google review would mean a lot to me: '
         || p_review_url;
$fn$;

revoke all on function crm_private.review_request_draft(text) from public, anon, authenticated, service_role;

create or replace function public.list_review_followups(p_artist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_now timestamptz := clock_timestamp();
  v_url text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  perform crm_private.require_artist_access(p_artist_id, 'view_communications');

  select rs.google_review_url into v_url
  from crm_private.artist_review_settings rs where rs.artist_id = p_artist_id;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'review_url_configured', v_url is not null,
    'items', coalesce((
      select jsonb_agg(item order by (item ->> 'replied_at') desc nulls last,
                                    (item ->> 'healing_asked_at') desc)
      from (
        select jsonb_build_object(
          'review_request_id', rr.id,
          'client_id', rr.client_id,
          'client_name', c.full_name,
          'anchor_session_id', rr.anchor_session_id,
          'healing_asked_at', rr.healing_asked_at,
          'healing_message_status', q.status,
          'conversation_id', q.conversation_id,
          'status', case when r.id is null then 'awaiting_reply' else 'replied' end,
          'replied_at', r.created_at,
          'reply_message_id', r.id,
          'reply_text', left(r.body, 1000),
          'reply_attachment_count', coalesce(jsonb_array_length(r.attachments), 0),
          'draft_message', case when r.id is not null and v_url is not null
                                then crm_private.review_request_draft(v_url) end
        ) as item
        from public.review_requests rr
        join public.clients c on c.id = rr.client_id and c.archived_at is null
        join public.communication_messages q on q.id = rr.healing_message_id
        left join lateral crm_private.review_request_reply(rr.id) r on r.id is not null
        where rr.artist_id = p_artist_id
          and rr.state = 'healing_asked'
          and (r.id is not null or rr.healing_asked_at > v_now - interval '21 days')
        limit 100
      ) x
    ), '[]'::jsonb)
  );
end;
$fn$;

revoke all on function public.list_review_followups(uuid) from public, anon, service_role;
grant execute on function public.list_review_followups(uuid) to authenticated;

-- Shared guard for the two decisions after a reply: permission, lock,
-- idempotent replay and the request row. Returns the recorded result for a
-- replay, else null with the locked row in p_row.
create or replace function crm_private.review_followup_begin(
  p_artist_id uuid,
  p_request_id uuid,
  p_operation_id uuid,
  p_action text,
  out p_replay jsonb,
  out p_row public.review_requests
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
begin
  perform crm_private.require_artist_access(p_artist_id, 'send_communications');
  if p_request_id is null or p_operation_id is null then
    raise exception 'a review request and an operation id are required' using errcode = '22023';
  end if;

  select * into p_row from public.review_requests
  where id = p_request_id and artist_id = p_artist_id;
  if not found then
    raise exception 'review request was not found' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('review_request:' || p_row.anchor_session_id::text, 0));

  select o.result into p_replay
  from crm_private.review_request_operations o
  where o.operation_id = p_operation_id;
  if found then
    if p_replay ->> 'id' <> p_request_id::text
       or (select o.action from crm_private.review_request_operations o
           where o.operation_id = p_operation_id) <> p_action then
      raise exception 'operation id was used for another decision' using errcode = '22023';
    end if;
    return;
  end if;

  select * into p_row from public.review_requests where id = p_request_id for update;
  if p_row.state <> 'healing_asked' then
    raise exception 'this review request is already decided' using errcode = '55000';
  end if;
end;
$fn$;

revoke all on function crm_private.review_followup_begin(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.ask_for_review(
  p_artist_id uuid,
  p_review_request_id uuid,
  p_operation_id uuid,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_now timestamptz := clock_timestamp();
  v_begin record;
  v_row public.review_requests%rowtype;
  v_reply public.communication_messages%rowtype;
  v_conversation_id uuid;
  v_sent jsonb;
  v_result jsonb;
begin
  select * into v_begin from crm_private.review_followup_begin(
    p_artist_id, p_review_request_id, p_operation_id, 'ask_review');
  if v_begin.p_replay is not null then
    return v_begin.p_replay;
  end if;
  v_row := v_begin.p_row;

  if not exists (select 1 from crm_private.artist_review_settings rs where rs.artist_id = p_artist_id) then
    raise exception 'no Google review link is set for this artist' using errcode = '55000';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then
    raise exception 'the review message must be 1 to 1000 characters' using errcode = '22023';
  end if;

  v_reply := crm_private.review_request_reply(v_row.id);
  if v_reply.id is null then
    raise exception 'the client has not replied to the healing question' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.communication_suppressions cs
    where cs.client_id = v_row.client_id and cs.is_active
      and cs.reason in ('unsubscribed', 'complained', 'blocked', 'manual')
  ) then
    raise exception 'client does not accept messages' using errcode = '55000';
  end if;

  select q.conversation_id into v_conversation_id
  from public.communication_messages q where q.id = v_row.healing_message_id;

  -- The client's reply opened WhatsApp's 24-hour window; once it has closed
  -- queue_whatsapp_message refuses with 23514 and nothing is recorded.
  v_sent := public.queue_whatsapp_message(v_conversation_id, btrim(p_body), p_operation_id);

  update public.review_requests set
    state = 'review_asked',
    replied_at = v_reply.created_at,
    reply_message_id = v_reply.id,
    review_asked_at = v_now,
    review_message_id = (v_sent ->> 'message_id')::uuid,
    last_operation_id = p_operation_id,
    version = version + 1,
    updated_by = auth.uid(),
    updated_at = v_now
  where id = v_row.id
  returning * into v_row;

  v_result := to_jsonb(v_row) - 'created_by' - 'updated_by';
  insert into crm_private.review_request_operations (operation_id, review_request_id, action, result)
  values (p_operation_id, v_row.id, 'ask_review', v_result);
  return v_result;
end;
$fn$;

revoke all on function public.ask_for_review(uuid, uuid, uuid, text) from public, anon, service_role;
grant execute on function public.ask_for_review(uuid, uuid, uuid, text) to authenticated;

create or replace function public.close_review_request(
  p_artist_id uuid,
  p_review_request_id uuid,
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
  v_begin record;
  v_row public.review_requests%rowtype;
  v_reply public.communication_messages%rowtype;
  v_result jsonb;
begin
  select * into v_begin from crm_private.review_followup_begin(
    p_artist_id, p_review_request_id, p_operation_id, 'close');
  if v_begin.p_replay is not null then
    return v_begin.p_replay;
  end if;
  v_row := v_begin.p_row;
  v_reply := crm_private.review_request_reply(v_row.id);

  update public.review_requests set
    state = 'closed',
    replied_at = v_reply.created_at,
    reply_message_id = v_reply.id,
    closed_at = v_now,
    last_operation_id = p_operation_id,
    version = version + 1,
    updated_by = auth.uid(),
    updated_at = v_now
  where id = v_row.id
  returning * into v_row;

  v_result := to_jsonb(v_row) - 'created_by' - 'updated_by';
  insert into crm_private.review_request_operations (operation_id, review_request_id, action, result)
  values (p_operation_id, v_row.id, 'close', v_result);
  return v_result;
end;
$fn$;

revoke all on function public.close_review_request(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.close_review_request(uuid, uuid, uuid) to authenticated;
