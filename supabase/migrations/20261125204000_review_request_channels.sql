-- Multi-channel, artist-confirmed healing questions and Google review requests.
-- Existing WhatsApp RPCs remain callable during the staged rollout.
alter table public.review_requests
  add column healing_email_message_id uuid unique references public.email_messages(id) on delete set null,
  add column review_email_message_id uuid unique references public.email_messages(id) on delete set null;

create table crm_private.review_email_deliveries (
  email_message_id uuid primary key references public.email_messages(id) on delete cascade,
  review_request_id uuid not null references public.review_requests(id) on delete cascade,
  purpose text not null check (purpose in ('healing','review')),
  integration_key text not null,
  mailbox_email text not null,
  client_email text not null,
  provider_thread_id text,
  provider_message_id text,
  rfc822_message_id text,
  reply_provider_id text,
  reply_at timestamptz,
  reply_text text,
  checked_at timestamptz,
  unique (review_request_id,purpose)
);
alter table crm_private.review_email_deliveries enable row level security;
alter table crm_private.review_email_deliveries force row level security;
revoke all on crm_private.review_email_deliveries from public, anon, authenticated, service_role;

-- A fresh heartbeat from the upgraded Gmail worker is required before
-- email can be offered. A DB-first deploy cannot queue an untracked email.
create table crm_private.review_email_worker_ready (
  artist_id uuid primary key references public.artists(id) on delete cascade,
  integration_key text not null,
  checked_at timestamptz not null
);
alter table crm_private.review_email_worker_ready enable row level security;
alter table crm_private.review_email_worker_ready force row level security;
revoke all on crm_private.review_email_worker_ready from public, anon, authenticated, service_role;

create function crm_private.review_channel_routes(p_artist_id uuid,p_client_id uuid,p_stage text)
returns table(channel text, conversation_id uuid, available boolean, reason text, last_activity timestamptz)
language sql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
  with cl as (
    select c.* from public.clients c where c.id=p_client_id and c.archived_at is null
  ), candidates as (
    select ch.channel, c.id, c.last_message_at, c.last_inbound_at,
      c.external_contact_id,
      (select count(*) from public.artist_integrations i
        where i.artist_id=p_artist_id and i.integration_key=c.integration_key and i.is_enabled
          and ((ch.channel='whatsapp' and i.integration_type='whatsapp' and i.provider='meta_cloud_api')
            or (ch.channel='instagram' and i.integration_type='instagram' and i.provider='instagram_login'))) as route_count
    from (values ('whatsapp'),('instagram')) ch(channel)
    left join lateral (
      select cc.* from public.communication_conversations cc
      where cc.artist_id=p_artist_id and cc.client_id=p_client_id
        and cc.channel::text=ch.channel and cc.state='open' and cc.link_state='linked'
      order by cc.last_message_at desc nulls last,cc.created_at desc,cc.id limit 1
    ) c on true
  ), meta as (
    select x.channel,x.id,
      case
        when not exists(select 1 from cl) then 'client_unavailable'
        when exists(select 1 from public.communication_suppressions s
          where s.client_id=p_client_id and s.is_active and s.reason in ('unsubscribed','complained','blocked','manual'))
          or crm_private.client_send_block_reason(p_client_id,x.channel::public.message_template_channel,'service') is not null then 'suppressed'
        when x.id is null then 'no_conversation'
        when x.route_count<>1 then 'not_connected'
        when x.channel='whatsapp' and p_stage='healing'
          and exists(select 1 from crm_private.lifecycle_whatsapp_template_candidates t
            where t.artist_id=p_artist_id and t.purpose='healing_check'
              and crm_private.healing_check_template_ready(p_artist_id,t.template_name,t.template_language))
          and exists(select 1 from cl where char_length(split_part(btrim(full_name),' ',1)) between 1 and 60) then null
        when x.channel='instagram' and coalesce(x.external_contact_id,'') !~ '^[0-9]{5,40}$' then 'no_conversation'
        when x.last_inbound_at > now()-interval '24 hours'+interval '10 minutes' then null
        when x.channel='whatsapp' and p_stage='healing' then 'template_not_ready'
        else 'window_closed'
      end as reason,x.last_message_at
    from candidates x
  ), email as (
    select 'email'::text as channel,null::uuid as id,
      case
        when not exists(select 1 from cl) then 'client_unavailable'
        when exists(select 1 from public.communication_suppressions s
          where s.client_id=p_client_id and s.is_active and s.reason in ('unsubscribed','complained','blocked','manual'))
          or crm_private.client_send_block_reason(p_client_id,'email','service') is not null then 'suppressed'
        when not exists(select 1 from cl where lower(btrim(email)) ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+[.][^[:space:]@<>]+$') then 'no_email'
        when (select count(*) from public.artist_integrations i
          where i.artist_id=p_artist_id and i.integration_type='email' and i.provider='google' and i.is_enabled
            and nullif(btrim(i.external_account_label),'') is not null)<>1 then 'not_connected'
        when not exists(select 1 from crm_private.review_email_worker_ready w
          join public.artist_integrations i on i.artist_id=w.artist_id and i.integration_key=w.integration_key
          where w.artist_id=p_artist_id and i.integration_type='email' and i.provider='google' and i.is_enabled
            and w.checked_at>now()-interval '30 minutes') then 'email_sync_unavailable'
        else null
      end as reason,
      (select a.last_message_at from crm_private.gmail_client_email_activity a
        where a.artist_id=p_artist_id and a.client_id=p_client_id) as last_message_at
  )
  select m.channel,m.id,m.reason is null,m.reason,m.last_message_at from meta m
  union all
  select e.channel,e.id,e.reason is null,e.reason,e.last_message_at from email e;
$fn$;
revoke all on function crm_private.review_channel_routes(uuid,uuid,text) from public,anon,authenticated,service_role;

create function crm_private.review_channel_options(p_artist_id uuid,p_client_id uuid,p_stage text,p_preferred text default null)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('channel',r.channel,'available',r.available,'reason',r.reason)
    order by r.available desc,(r.channel=p_preferred) desc nulls last,r.last_activity desc nulls last,
      (r.channel=(select lower(c.preferred_contact) from public.clients c where c.id=p_client_id)) desc nulls last,
      case r.channel when 'whatsapp' then 1 when 'email' then 2 else 3 end),'[]'::jsonb)
  from crm_private.review_channel_routes(p_artist_id,p_client_id,p_stage) r;
$fn$;
revoke all on function crm_private.review_channel_options(uuid,uuid,text,text) from public,anon,authenticated,service_role;

create or replace function public.list_review_suggestions(p_artist_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id,'view_clients');
  perform crm_private.require_artist_access(p_artist_id,'view_sessions');
  v_result:=crm_private.review_suggestions(p_artist_id,clock_timestamp());
  if not crm_private.has_artist_capability(p_artist_id,'view_communications') then return v_result; end if;
  return jsonb_set(v_result,'{suggestions}',coalesce((
    select jsonb_agg(s.value||jsonb_build_object('channels',
      crm_private.review_channel_options(p_artist_id,(s.value->>'client_id')::uuid,'healing')) order by s.ordinality)
    from jsonb_array_elements(v_result->'suggestions') with ordinality s(value,ordinality)
  ),'[]'::jsonb));
end;
$fn$;

-- A human explicitly pressed Send; create one approved mail and one outbox
-- row atomically. The review request, rather than an invented enquiry,
-- is the authority for the target. The Gmail resolver re-checks it below.
create function crm_private.queue_review_email(p_request_id uuid,p_purpose text,p_body text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare
  v_row public.review_requests%rowtype;
  v_session public.sessions%rowtype;
  v_integration public.artist_integrations%rowtype;
  v_email text;
  v_id uuid;
begin
  select * into strict v_row from public.review_requests where id=p_request_id for update;
  perform crm_private.require_artist_access(v_row.artist_id,'send_communications');
  perform crm_private.require_active_artist(v_row.artist_id);
  if v_row.state<>'healing_asked' or p_purpose not in ('healing','review')
      or char_length(btrim(coalesce(p_body,''))) not between 1 and 1000 then
    raise exception 'invalid review email' using errcode='22023';
  end if;
  if not exists(select 1 from crm_private.review_channel_routes(v_row.artist_id,v_row.client_id,p_purpose) r
      where r.channel='email' and r.available) then
    raise exception 'selected channel is unavailable' using errcode='23514';
  end if;
  select * into strict v_session from public.sessions
    where id=v_row.anchor_session_id and artist_id=v_row.artist_id;
  select lower(btrim(c.email)) into strict v_email from public.clients c where c.id=v_row.client_id;
  select * into strict v_integration from public.artist_integrations i
    where i.artist_id=v_row.artist_id and i.integration_type='email' and i.provider='google' and i.is_enabled;
  insert into public.email_messages(artist_id,client_id,enquiry_id,project_id,to_email,subject,body,
    status,created_by,created_by_kind,approved_by,approved_at)
  values(v_row.artist_id,v_row.client_id,null,v_session.project_id,v_email,
    case p_purpose when 'healing' then 'How has your tattoo healed?' else 'A quick favour' end,
    btrim(p_body),'approved',auth.uid(),'human',auth.uid(),now())
  returning id into v_id;
  insert into crm_private.review_email_deliveries(email_message_id,review_request_id,purpose,integration_key,mailbox_email,client_email)
  values(v_id,v_row.id,p_purpose,v_integration.integration_key,lower(btrim(v_integration.external_account_label)),v_email);
  insert into public.integration_outbox(kind,dedupe_key,payload,artist_id,client_id,project_id,email_message_id)
  values('approved_email','email:review_request:'||p_purpose||':'||v_row.id,
    jsonb_build_object('email_message_id',v_id),v_row.artist_id,v_row.client_id,v_session.project_id,v_id);
  perform crm_private.log_artist_activity(v_row.artist_id,'email.review_request_queued',
    case when public.is_owner() then 'owner' else 'staff' end,auth.uid(),v_row.client_id,null,
    v_session.project_id,v_row.anchor_session_id,null,jsonb_build_object('email_message_id',v_id,'purpose',p_purpose));
  return v_id;
end;
$fn$;
revoke all on function crm_private.queue_review_email(uuid,text,text) from public,anon,authenticated,service_role;

-- New entry point. Cross-channel actions share the original visit lock and
-- operation ledger. A known replay cannot change the original channel.
create function public.send_healing_question_v2(p_artist_id uuid,p_anchor_session_id uuid,p_operation_id uuid,p_channel text)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare
  v_s jsonb; v_result jsonb; v_row public.review_requests%rowtype;
  v_route record; v_client uuid; v_message uuid; v_email uuid; v_body text;
  v_now timestamptz:=clock_timestamp();
begin
  perform crm_private.require_artist_access(p_artist_id,'send_communications');
  perform crm_private.require_active_artist(p_artist_id);
  if p_operation_id is null or p_anchor_session_id is null or coalesce(p_channel,'') not in ('whatsapp','instagram','email') then
    raise exception 'invalid healing channel or operation' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('review_request:'||p_anchor_session_id::text,0));
  select o.result into v_result from crm_private.review_request_operations o where o.operation_id=p_operation_id;
  if found then
    if v_result->>'anchor_session_id' is distinct from p_anchor_session_id::text
      or v_result->>'artist_id' is distinct from p_artist_id::text
      or v_result->>'state' is distinct from 'healing_asked'
      or coalesce(v_result->>'channel','whatsapp') is distinct from p_channel then
      raise exception 'operation id was used for another decision' using errcode='22023';
    end if;
    return v_result;
  end if;
  select s into v_s from jsonb_array_elements(crm_private.review_suggestions(p_artist_id,v_now)->'suggestions') s
    where s->>'anchor_session_id'=p_anchor_session_id::text;
  if v_s is null then raise exception 'this visit is not a current healing suggestion' using errcode='55000'; end if;
  v_client:=(v_s->>'client_id')::uuid;
  select * into v_route from crm_private.review_channel_routes(p_artist_id,v_client,'healing') r where r.channel=p_channel;
  if v_route.available is distinct from true then
    raise exception 'selected channel is unavailable: %',v_route.reason using errcode='23514';
  end if;
  -- Keep the existing approved WhatsApp template path where possible.
  if p_channel='whatsapp' and exists(select 1 from crm_private.lifecycle_whatsapp_template_candidates t
      where t.artist_id=p_artist_id and t.purpose='healing_check'
      and crm_private.healing_check_template_ready(p_artist_id,t.template_name,t.template_language))
    and exists(select 1 from public.clients c where c.id=v_client and char_length(split_part(btrim(c.full_name),' ',1)) between 1 and 60) then
    return public.send_healing_question(p_artist_id,p_anchor_session_id,p_operation_id);
  end if;
  v_body:=v_s->>'draft_message';
  insert into public.review_requests(artist_id,client_id,anchor_session_id,state,healing_asked_at,last_operation_id,created_by,updated_by)
    values(p_artist_id,v_client,p_anchor_session_id,'healing_asked',v_now,p_operation_id,auth.uid(),auth.uid())
    on conflict(anchor_session_id) do update set state='healing_asked',snoozed_until=null,
      healing_asked_at=v_now,last_operation_id=p_operation_id,version=review_requests.version+1,updated_at=v_now,updated_by=auth.uid()
    returning * into v_row;
  if p_channel='email' then
    v_email:=crm_private.queue_review_email(v_row.id,'healing',v_body);
  elsif p_channel='whatsapp' then
    v_message:=(public.queue_whatsapp_message(v_route.conversation_id,v_body,p_operation_id)->>'message_id')::uuid;
  else
    v_message:=(public.queue_communication_message(v_route.conversation_id,v_body,p_operation_id)->>'message_id')::uuid;
  end if;
  update public.review_requests set healing_message_id=v_message,healing_email_message_id=v_email
    where id=v_row.id returning * into v_row;
  v_result:=(to_jsonb(v_row)-'created_by'-'updated_by')||jsonb_build_object('channel',p_channel);
  insert into crm_private.review_request_operations(operation_id,review_request_id,action,result)
    values(p_operation_id,v_row.id,'ask_healing',v_result);
  return v_result;
end;
$fn$;
revoke all on function public.send_healing_question_v2(uuid,uuid,uuid,text) from public,anon,service_role;
grant execute on function public.send_healing_question_v2(uuid,uuid,uuid,text) to authenticated;

create function crm_private.review_reply_evidence(p_request_id uuid)
returns table(message_id uuid,replied_at timestamptz,body text,attachment_count integer)
language sql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
  select m.id,coalesce(m.provider_timestamp,m.created_at),m.body,
    coalesce(jsonb_array_length(m.attachments),0)
  from crm_private.review_request_reply(p_request_id) m where m.id is not null
  union all
  select null::uuid,d.reply_at,d.reply_text,0
  from crm_private.review_email_deliveries d
  join public.review_requests rr on rr.id=d.review_request_id and rr.healing_email_message_id=d.email_message_id
  join public.email_messages e on e.id=d.email_message_id and e.status='sent'
  where rr.id=p_request_id and d.purpose='healing' and d.reply_at is not null
    and d.reply_at>rr.healing_asked_at and d.reply_at<=rr.healing_asked_at+interval '21 days';
$fn$;
revoke all on function crm_private.review_reply_evidence(uuid) from public,anon,authenticated,service_role;

create or replace function public.list_review_followups(p_artist_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare v_url text;
begin
  perform crm_private.require_artist_access(p_artist_id,'view_clients');
  perform crm_private.require_artist_access(p_artist_id,'view_communications');
  select rs.google_review_url into v_url from crm_private.artist_review_settings rs where rs.artist_id=p_artist_id;
  return jsonb_build_object('artist_id',p_artist_id,'review_url_configured',v_url is not null,'items',coalesce((
    select jsonb_agg(x.item order by (x.item->>'replied_at') desc nulls last,(x.item->>'healing_asked_at') desc)
    from (
      select jsonb_build_object('review_request_id',rr.id,'client_id',rr.client_id,'client_name',c.full_name,
        'anchor_session_id',rr.anchor_session_id,'healing_asked_at',rr.healing_asked_at,
        'healing_message_status',coalesce(q.status::text,e.status::text),'conversation_id',q.conversation_id,
        'healing_channel',coalesce(q.channel::text,'email'),
        'status',case when r.replied_at is null then 'awaiting_reply' else 'replied' end,
        'replied_at',r.replied_at,'reply_message_id',r.message_id,'reply_text',left(r.body,1000),
        'reply_attachment_count',coalesce(r.attachment_count,0),
        'draft_message',case when r.replied_at is not null and v_url is not null then crm_private.review_request_draft(v_url) end,
        'channels',case when r.replied_at is not null then crm_private.review_channel_options(p_artist_id,rr.client_id,'review',coalesce(q.channel::text,'email')) else '[]'::jsonb end
      ) as item
      from public.review_requests rr
      join public.clients c on c.id=rr.client_id and c.archived_at is null
      left join public.communication_messages q on q.id=rr.healing_message_id
      left join public.email_messages e on e.id=rr.healing_email_message_id
      left join lateral crm_private.review_reply_evidence(rr.id) r on true
      where rr.artist_id=p_artist_id and rr.state='healing_asked' and (q.id is not null or e.id is not null)
        and (r.replied_at is not null or rr.healing_asked_at>clock_timestamp()-interval '21 days')
      limit 100
    ) x),'[]'::jsonb));
end;
$fn$;

create function public.ask_for_review_v2(p_artist_id uuid,p_review_request_id uuid,p_operation_id uuid,p_body text,p_channel text)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare
  v_begin record; v_row public.review_requests%rowtype; v_reply record; v_route record;
  v_email uuid; v_message uuid; v_result jsonb;
begin
  if coalesce(p_channel,'') not in ('whatsapp','instagram','email') then raise exception 'invalid review channel' using errcode='22023'; end if;
  select * into v_begin from crm_private.review_followup_begin(p_artist_id,p_review_request_id,p_operation_id,'ask_review');
  if v_begin.p_replay is not null then
    if coalesce(v_begin.p_replay->>'channel','whatsapp') is distinct from p_channel then
      raise exception 'operation id was used for another decision' using errcode='22023';
    end if;
    return v_begin.p_replay;
  end if;
  v_row:=v_begin.p_row;
  perform crm_private.require_active_artist(p_artist_id);
  if not exists(select 1 from crm_private.artist_review_settings rs where rs.artist_id=p_artist_id) then
    raise exception 'no Google review link is set for this artist' using errcode='55000';
  end if;
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 1000 then
    raise exception 'the review message must be 1 to 1000 characters' using errcode='22023';
  end if;
  select * into v_reply from crm_private.review_reply_evidence(v_row.id);
  if not found then raise exception 'the client has not replied to the healing question' using errcode='55000'; end if;
  select * into v_route from crm_private.review_channel_routes(p_artist_id,v_row.client_id,'review') r where r.channel=p_channel;
  if v_route.available is distinct from true then
    raise exception 'selected channel is unavailable: %',v_route.reason using errcode='23514';
  end if;
  if p_channel='email' then
    v_email:=crm_private.queue_review_email(v_row.id,'review',p_body);
  elsif p_channel='whatsapp' then
    v_message:=(public.queue_whatsapp_message(v_route.conversation_id,btrim(p_body),p_operation_id)->>'message_id')::uuid;
  else
    v_message:=(public.queue_communication_message(v_route.conversation_id,btrim(p_body),p_operation_id)->>'message_id')::uuid;
  end if;
  update public.review_requests set state='review_asked',replied_at=v_reply.replied_at,reply_message_id=v_reply.message_id,
    review_asked_at=clock_timestamp(),review_message_id=v_message,review_email_message_id=v_email,
    last_operation_id=p_operation_id,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=v_row.id returning * into v_row;
  v_result:=(to_jsonb(v_row)-'created_by'-'updated_by')||jsonb_build_object('channel',p_channel);
  insert into crm_private.review_request_operations(operation_id,review_request_id,action,result)
    values(p_operation_id,v_row.id,'ask_review',v_result);
  return v_result;
end;
$fn$;
revoke all on function public.ask_for_review_v2(uuid,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.ask_for_review_v2(uuid,uuid,uuid,text,text) to authenticated;

-- Gmail delivery authority: only the exact leased job, message and request.
-- A private link is the discriminator; ordinary mail paths are unchanged.
create function crm_private.review_email_delivery_allowed(p_email_message_id uuid)
returns boolean language sql stable security definer
set search_path=pg_catalog,public,crm_private
as $fn$
  select exists(
    select 1 from crm_private.review_email_deliveries d
    join public.review_requests rr on rr.id=d.review_request_id
    join public.email_messages e on e.id=d.email_message_id and e.artist_id=rr.artist_id and e.client_id=rr.client_id
    join public.clients c on c.id=rr.client_id and c.archived_at is null and lower(btrim(c.email))=d.client_email
    join public.artist_integrations i on i.artist_id=rr.artist_id and i.integration_key=d.integration_key
      and i.integration_type='email' and i.provider='google' and i.is_enabled and lower(btrim(i.external_account_label))=d.mailbox_email
    join crm_private.artist_state st on st.artist_id=rr.artist_id and st.is_active
    where d.email_message_id=p_email_message_id and lower(btrim(e.to_email))=d.client_email
      and ((d.purpose='healing' and rr.state='healing_asked' and rr.healing_email_message_id=e.id)
        or (d.purpose='review' and rr.state='review_asked' and rr.review_email_message_id=e.id))
      and crm_private.client_send_block_reason(rr.client_id,'email','service') is null
      and not exists(select 1 from public.communication_suppressions s where s.client_id=rr.client_id and s.is_active
        and s.reason in ('unsubscribed','complained','blocked','manual'))
  );
$fn$;
revoke all on function crm_private.review_email_delivery_allowed(uuid) from public,anon,authenticated,service_role;

do $patch$
declare
  v_def text:=pg_get_functiondef('public.service_resolve_gmail_outbox_target(uuid,text)'::regprocedure);
  v_anchor text:='  if v_message.booking_card_id is not null then';
  v_insert text:=$body$
  if exists(select 1 from crm_private.review_email_deliveries d where d.email_message_id=v_message.id) then
    return query
    select v_job.id,v_message.id,v_job.artist_id,v_job.enquiry_id,v_job.client_id,v_client_email,
      i.integration_key,lower(btrim(i.external_account_label)),
      (coalesce(i.configuration,'{}'::jsonb)-'booking_card_reply_in_existing_thread')||jsonb_build_object('review_email',true),
      crm_private.review_email_delivery_allowed(v_message.id)
    from crm_private.review_email_deliveries d
    join public.artist_integrations i on i.artist_id=v_job.artist_id and i.integration_key=d.integration_key
      and i.integration_type='email' and i.provider='google' and i.is_enabled
      and lower(btrim(i.external_account_label))=d.mailbox_email
    where d.email_message_id=v_message.id and v_job.dedupe_key='email:review_request:'||d.purpose||':'||d.review_request_id;
    if not found then raise exception 'Gmail CRM target is unavailable' using errcode='22023'; end if;
    return;
  end if;

$body$;
begin
  if (length(v_def)-length(replace(v_def,v_anchor,'')))<>length(v_anchor) then
    raise exception 'review Gmail resolver anchor drift' using errcode='23514';
  end if;
  execute replace(v_def,v_anchor,v_insert||v_anchor);
end;
$patch$;

-- Atomic provider acknowledgement. Gmail already deduplicates by a stable
-- RFC Message-ID; if this acknowledgement fails, a retry finds the same mail.
create function public.service_record_review_email_sent(p_outbox_id uuid,p_worker_id text,p_provider_message_id text,p_provider_thread_id text,p_rfc822_message_id text)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare v_job public.integration_outbox%rowtype; v_d crm_private.review_email_deliveries%rowtype; v_result jsonb;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if coalesce(p_provider_message_id,'') !~ '^[A-Za-z0-9_-]{4,255}$'
    or coalesce(p_provider_thread_id,'') !~ '^[A-Za-z0-9_-]{4,255}$'
    or coalesce(p_rfc822_message_id,'') !~ '^<[^[:space:]<>]+>$'
    or length(p_rfc822_message_id)>998 then raise exception 'invalid Gmail delivery identifiers' using errcode='22023'; end if;
  select * into strict v_job from public.integration_outbox where id=p_outbox_id and kind='approved_email' for update;
  select * into strict v_d from crm_private.review_email_deliveries where email_message_id=v_job.email_message_id for update;
  if v_job.status='succeeded' then
    if v_d.provider_message_id is distinct from p_provider_message_id or v_d.provider_thread_id is distinct from p_provider_thread_id
      or v_d.rfc822_message_id is distinct from p_rfc822_message_id then raise exception 'review email acknowledgement mismatch' using errcode='23514'; end if;
  elsif v_job.status<>'leased' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'email outbox lease is not owned by this worker' using errcode='42501';
  end if;
  v_result:=public.record_email_outbox_result(p_outbox_id,p_worker_id,true,p_provider_message_id,null);
  update crm_private.review_email_deliveries set provider_message_id=p_provider_message_id,
    provider_thread_id=p_provider_thread_id,rfc822_message_id=p_rfc822_message_id where email_message_id=v_d.email_message_id;
  return v_result;
end;
$fn$;
revoke all on function public.service_record_review_email_sent(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.service_record_review_email_sent(uuid,text,text,text,text) to service_role;

-- Called only by the upgraded mailbox worker after authenticating the
-- exact configured account. Bound the polling workload and rotate oldest first.
create function public.service_list_review_email_checks(p_artist_id uuid,p_integration_key text,p_mailbox_email text)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if not exists(select 1 from public.artist_integrations i join crm_private.artist_state st on st.artist_id=i.artist_id and st.is_active
    where i.artist_id=p_artist_id and i.integration_key=p_integration_key and i.integration_type='email'
      and i.provider='google' and i.is_enabled and lower(btrim(i.external_account_label))=p_mailbox_email) then
    raise exception 'Gmail route unavailable' using errcode='42501';
  end if;
  insert into crm_private.review_email_worker_ready(artist_id,integration_key,checked_at)
    values(p_artist_id,p_integration_key,now()) on conflict(artist_id) do update
      set integration_key=excluded.integration_key,checked_at=excluded.checked_at;
  return coalesce((select jsonb_agg(to_jsonb(x)) from (
    select d.email_message_id,d.client_email,d.provider_thread_id,d.provider_message_id,d.rfc822_message_id,
      rr.healing_asked_at
    from crm_private.review_email_deliveries d
    join public.review_requests rr on rr.id=d.review_request_id and rr.healing_email_message_id=d.email_message_id
    join public.email_messages e on e.id=d.email_message_id and e.status='sent'
    join public.clients c on c.id=rr.client_id and c.archived_at is null and lower(btrim(c.email))=d.client_email
    where rr.artist_id=p_artist_id and rr.state='healing_asked' and d.purpose='healing'
      and d.integration_key=p_integration_key and d.mailbox_email=p_mailbox_email
      and d.provider_thread_id is not null and d.provider_message_id is not null and d.rfc822_message_id is not null
      and d.reply_at is null and rr.healing_asked_at>now()-interval '21 days'
    order by d.checked_at nulls first,rr.healing_asked_at,d.email_message_id limit 2
  ) x),'[]'::jsonb);
end;
$fn$;
revoke all on function public.service_list_review_email_checks(uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_list_review_email_checks(uuid,text,text) to service_role;

create function public.service_record_review_email_check(p_artist_id uuid,p_integration_key text,p_email_message_id uuid,p_thread_id text,p_reply_id text,p_reply_at timestamptz,p_reply_text text)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public,crm_private
as $fn$
declare v_d crm_private.review_email_deliveries%rowtype; v_rr public.review_requests%rowtype;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  select d.* into v_d from crm_private.review_email_deliveries d where d.email_message_id=p_email_message_id
    and d.purpose='healing' and d.integration_key=p_integration_key and d.provider_thread_id=p_thread_id for update;
  if not found then raise exception 'review email thread unavailable' using errcode='42501'; end if;
  select * into v_rr from public.review_requests rr where rr.id=v_d.review_request_id
    and rr.artist_id=p_artist_id and rr.healing_email_message_id=p_email_message_id and rr.state='healing_asked';
  if not found or not exists(select 1 from public.artist_integrations i join public.clients c on c.id=v_rr.client_id
    where i.artist_id=p_artist_id and i.integration_key=p_integration_key and i.integration_type='email'
      and i.provider='google' and i.is_enabled and lower(btrim(i.external_account_label))=v_d.mailbox_email
      and c.archived_at is null and lower(btrim(c.email))=v_d.client_email) then
    raise exception 'review email route unavailable' using errcode='42501';
  end if;
  if p_reply_id is null then
    if p_reply_at is not null or p_reply_text is not null then raise exception 'invalid empty reply' using errcode='22023'; end if;
    update crm_private.review_email_deliveries set checked_at=now() where email_message_id=p_email_message_id;
    return;
  end if;
  if p_reply_id !~ '^[A-Za-z0-9_-]{4,255}$' or p_reply_id=v_d.provider_message_id
    or p_reply_at is null or p_reply_at<=v_rr.healing_asked_at or p_reply_at>v_rr.healing_asked_at+interval '21 days'
    or p_reply_at>now()+interval '5 minutes' or p_reply_text is null or length(p_reply_text)>1000 then
    raise exception 'invalid reply evidence' using errcode='22023';
  end if;
  update crm_private.review_email_deliveries set checked_at=now(),reply_provider_id=p_reply_id,reply_at=p_reply_at,reply_text=p_reply_text
    where email_message_id=p_email_message_id and reply_at is null;
end;
$fn$;
revoke all on function public.service_record_review_email_check(uuid,text,uuid,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.service_record_review_email_check(uuid,text,uuid,text,text,timestamptz,text) to service_role;
