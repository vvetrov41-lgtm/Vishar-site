-- Replace 51 repeated timeline/acknowledgement scans with one artist-scoped scan.
-- Booking evidence, operator overrides, stage and conflicts keep their canonical helpers.
create function crm_private.pulse_attention_batch(p_artist_id uuid, p_now timestamptz default null)
returns table(client_id uuid, a jsonb)
language sql stable security definer
set search_path = pg_catalog, public, crm_private
as $batch$
with active as materialized (
  select client_id from crm_private.pulse_active_clients(p_artist_id)
), items as materialized (
  select v.client_id, 'communication'::text source, m.id source_id, m.direction::text direction,
    coalesce(m.provider_timestamp,m.created_at) occurred_at
  from public.communication_messages m
  join public.communication_conversations v on v.id=m.conversation_id and v.artist_id=m.artist_id
  join active ac on ac.client_id=v.client_id
  where m.artist_id=p_artist_id
    and ((m.direction='outbound' and m.status in ('sent','delivered','read'))
      or (m.direction='inbound' and crm_private.communication_event_is_actionable(m.message_type)))
  union all
  select x.client_id,'email',x.id,'outbound',x.sent_at
  from public.email_messages x join active ac on ac.client_id=x.client_id
  where x.artist_id=p_artist_id and x.status='sent' and x.sent_at is not null
  union all
  select g.client_id,'gmail',g.id,g.direction,g.occurred_at
  from crm_private.gmail_client_ai_excerpts g join active ac on ac.client_id=g.client_id
  where g.artist_id=p_artist_id and g.direction in ('inbound','outbound') and g.occurred_at is not null
  union all
  select e.client_id,'enquiry',e.id,'inbound',e.created_at
  from public.enquiries e join active ac on ac.client_id=e.client_id
  where e.artist_id=p_artist_id and e.archived_at is null and e.status='new'
), inbound as materialized (
  select distinct on (client_id) client_id,occurred_at,source,source_id
  from items where direction='inbound' and occurred_at is not null
  order by client_id,occurred_at desc
), outbound as (
  select client_id,max(occurred_at) at from items where direction='outbound' group by client_id
), marks as (
  select distinct on (m.client_id) m.client_id,m.reply_state,m.source
  from crm_private.client_reply_marks m join inbound i on i.client_id=m.client_id
  where m.artist_id=p_artist_id and m.message_at>=i.occurred_at
  order by m.client_id,m.created_at desc
), ack_rows as materialized (
  select c.client_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a
  join public.communication_conversations c on c.id=a.entity_id and c.artist_id=a.artist_id
  where a.artist_id=p_artist_id and a.item_kind='conversation_reply'
  union all
  select a.entity_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a where a.artist_id=p_artist_id and a.item_kind='gmail_reply'
  union all
  select e.client_id,a.observed_at,a.acknowledged_at
  from public.attention_acknowledgements a join public.enquiries e on e.id=a.entity_id and e.artist_id=a.artist_id
  where a.artist_id=p_artist_id and a.item_kind='new_enquiry'
), ack as (
  select r.client_id,max(r.observed_at) at,
    min(r.acknowledged_at) filter(where r.observed_at>=i.occurred_at) clicked_at
  from ack_rows r left join inbound i on i.client_id=r.client_id group by r.client_id
), booked as materialized (
  select i.client_id,crm_private.inbound_message_handled_by_booking(i.source_id) at
  from inbound i where i.source='communication'
), facts as materialized (
  select ac.client_id,i.occurred_at last_inbound_at,i.source last_inbound_source,
    o.at last_outbound_at,b.at booked_at,a.at ack_at,a.clicked_at ack_clicked_at,
    case when m.source='operator' or m.reply_state<>'reply_required'
      or (b.at is null and not coalesce(a.at>=i.occurred_at,false)) then m.reply_state end mark_state
  from active ac left join inbound i using(client_id) left join outbound o using(client_id)
  left join marks m using(client_id) left join ack a using(client_id) left join booked b using(client_id)
), comm as materialized (
  select f.*,
    case when f.last_inbound_at is null and f.last_outbound_at is null then 'none'
      when f.last_outbound_at is null or f.last_inbound_at>f.last_outbound_at then 'client' else 'studio' end last_speaker,
    case when f.mark_state is not null then f.mark_state
      when f.ack_at is not null and f.last_inbound_at is not null and f.ack_at>=f.last_inbound_at then 'handled'
      when f.booked_at is not null then 'handled' else 'unknown' end reply_state,
    case when f.mark_state is null and f.ack_at is not null and f.last_inbound_at is not null and f.ack_at>=f.last_inbound_at
      then greatest(f.ack_clicked_at,f.last_inbound_at)
      when f.mark_state is null and f.booked_at is not null then f.booked_at end handled_at
  from facts f
), stages as materialized (
  select ac.client_id,s.workflow_stage from active ac
  cross join lateral crm_private.attention_stage_facts(p_artist_id,ac.client_id) s
), confirmed as (
  select distinct s.client_id from public.sessions s
  where s.artist_id=p_artist_id and s.status='confirmed' and s.cancelled_at is null
    and s.end_at>=coalesce(p_now,clock_timestamp())
)
select c.client_id,jsonb_build_object(
  'client_id',c.client_id,'last_outbound_at',c.last_outbound_at,'workflow_stage',s.workflow_stage,
  'sla_state',l.sla_state,'sla_reason',l.sla_reason,
  'conflicts',to_jsonb(crm_private.pulse_conflicts(p_artist_id,c.client_id))
) a
from comm c join stages s using(client_id) left join confirmed cf using(client_id)
cross join lateral crm_private.attention_sla(
  case when c.reply_state='handled' then 'studio' else c.last_speaker end,c.reply_state,c.last_inbound_at,
  case when c.reply_state='handled' then greatest(c.last_outbound_at,c.handled_at) else c.last_outbound_at end,
  case when cf.client_id is not null and s.workflow_stage not in ('booked','aftercare','dormant') then 'booked' else s.workflow_stage end,
  coalesce(p_now,clock_timestamp())
) l;
$batch$;
revoke all on function crm_private.pulse_attention_batch(uuid,timestamptz) from public, anon, authenticated, service_role;

-- Fail closed if an intervening release changed the assembly we measured.
do $patch$
declare definition text;
begin
  if (select md5(prosrc) from pg_proc where oid='crm_private.pulse_items(uuid,boolean,boolean,timestamptz)'::regprocedure) <> '3365f03ceb342b39ac17da6209004981' then
    raise exception 'pulse_items drifted since the Today critical-path baseline';
  end if;
  definition := pg_get_functiondef('crm_private.pulse_items(uuid,boolean,boolean,timestamptz)'::regprocedure);
  if position($old$att as (
    select ac.client_id, crm_private.pulse_client_attention(p_artist_id, ac.client_id, (select t from now_)) as a
    from crm_private.pulse_active_clients(p_artist_id) ac
  )$old$ in definition)=0 then
    raise exception 'Expected Today attention assembly is missing';
  end if;
  execute replace(definition, $old$att as (
    select ac.client_id, crm_private.pulse_client_attention(p_artist_id, ac.client_id, (select t from now_)) as a
    from crm_private.pulse_active_clients(p_artist_id) ac
  )$old$, $new$att as materialized (
    select * from crm_private.pulse_attention_batch(p_artist_id, (select t from now_))
  )$new$);
end;
$patch$;
