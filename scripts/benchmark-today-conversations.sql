-- Internal read-only benchmark; not a migration or public RPC.
-- Run only using an authorized DB operator. Returns aggregates/plans only.
-- 2026-11-28 initial experiment: 210 open conversations; 0 mismatches;
-- 75 waiting in both implementations; 538.962ms vs 76.725ms.
-- These are single-run component timings, not production Today speedups.
-- Repeat, test edge cases and per-artist access, and verify full pulse equality
-- before replacing any existing helper. Do not grant access to this query.
begin transaction read only;
set local statement_timeout = '15s';

with scope as materialized (
  select c.id from public.communication_conversations c
  join public.artists a on a.id=c.artist_id and a.is_active
  where c.state='open'
),
original as materialized (
  select s.id, crm_private.conversation_awaiting_reply_since(s.id) as awaiting_since
  from scope s
),
latest as materialized (
  select c.id as conversation_id, m.id as inbound_id, m.body as inbound_body,
         m.message_type as inbound_type, coalesce(m.provider_timestamp,m.created_at) as inbound_at
  from scope c join lateral (
    select m.* from public.communication_messages m
    where m.conversation_id=c.id and m.direction='inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp,m.created_at) desc,m.id desc limit 1
  ) m on true
), studio as materialized (
  select x.*,crm_private.conversation_last_studio_reply_at(x.conversation_id) as studio_at,
    coalesce(x.inbound_type='text' and
      btrim(regexp_replace(lower(x.inbound_body),'[[:space:].!,]+',' ','g')) ~ '^((ok(ay)? )?(mate )?(thanks|thank you|cheers)( mate)?|never mind i found (it|the (button|door|exit|entrance))( (ha ha|haha))?( (thanks|thank you|cheers))?)$',false) as close_candidate
  from latest x
), candidate as materialized (
  select x.conversation_id,
    case when x.inbound_at is not null
      and x.inbound_at > coalesce(x.studio_at,'-infinity'::timestamptz)
      and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
      and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
      and not (
        x.studio_at is not null and x.inbound_at <= x.studio_at + interval '24 hours'
        and (x.close_candidate or crm_private.is_short_reply_acknowledgement(x.inbound_body))
        and not exists (
          select 1 from public.communication_conversations c
          join crm_private.client_reply_marks m on m.artist_id=c.artist_id and m.client_id=c.client_id
          where c.id=x.conversation_id and c.client_id is not null
            and m.message_at=x.inbound_at and m.reply_state='reply_required'
            and (m.source is distinct from 'classifier' or not x.close_candidate)
        )
      ) then x.inbound_at end as awaiting_since
  from studio x
)
select count(*) as tested_conversations,
  count(*) filter (where o.awaiting_since is distinct from c.awaiting_since) as mismatches,
  count(o.awaiting_since) as old_waiting, count(c.awaiting_since) as new_waiting
from original o left join candidate c on c.conversation_id=o.id;

explain (analyze,timing off,summary on,format json)
with scope as materialized (
  select c.id from public.communication_conversations c
  join public.artists a on a.id=c.artist_id and a.is_active
  where c.state='open'
),
original as materialized (
  select s.id, crm_private.conversation_awaiting_reply_since(s.id) as awaiting_since
  from scope s
)
select count(awaiting_since) from original;

explain (analyze,timing off,summary on,format json)
with scope as materialized (
  select c.id from public.communication_conversations c
  join public.artists a on a.id=c.artist_id and a.is_active
  where c.state='open'
),
latest as materialized (
  select c.id as conversation_id, m.id as inbound_id, m.body as inbound_body,
         m.message_type as inbound_type, coalesce(m.provider_timestamp,m.created_at) as inbound_at
  from scope c join lateral (
    select m.* from public.communication_messages m
    where m.conversation_id=c.id and m.direction='inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp,m.created_at) desc,m.id desc limit 1
  ) m on true
), studio as materialized (
  select x.*,crm_private.conversation_last_studio_reply_at(x.conversation_id) as studio_at,
    coalesce(x.inbound_type='text' and
      btrim(regexp_replace(lower(x.inbound_body),'[[:space:].!,]+',' ','g')) ~ '^((ok(ay)? )?(mate )?(thanks|thank you|cheers)( mate)?|never mind i found (it|the (button|door|exit|entrance))( (ha ha|haha))?( (thanks|thank you|cheers))?)$',false) as close_candidate
  from latest x
), candidate as materialized (
  select x.conversation_id,
    case when x.inbound_at is not null
      and x.inbound_at > coalesce(x.studio_at,'-infinity'::timestamptz)
      and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
      and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
      and not (
        x.studio_at is not null and x.inbound_at <= x.studio_at + interval '24 hours'
        and (x.close_candidate or crm_private.is_short_reply_acknowledgement(x.inbound_body))
        and not exists (
          select 1 from public.communication_conversations c
          join crm_private.client_reply_marks m on m.artist_id=c.artist_id and m.client_id=c.client_id
          where c.id=x.conversation_id and c.client_id is not null
            and m.message_at=x.inbound_at and m.reply_state='reply_required'
            and (m.source is distinct from 'classifier' or not x.close_candidate)
        )
      ) then x.inbound_at end as awaiting_since
  from studio x
)
select count(awaiting_since) from candidate;

rollback;
