-- A reply-ending acknowledgement in an ongoing exchange is not a new request.
-- Both Today and the unanswered-reply reminder use this internal function.

CREATE OR REPLACE FUNCTION crm_private.conversation_awaiting_reply_since(p_conversation_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  with latest as (
    select m.id as inbound_id, m.body as inbound_body, m.message_type as inbound_type,
           coalesce(m.provider_timestamp, m.created_at) as inbound_at
    from public.communication_messages m
    where m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
    limit 1
  )
  select case
    when x.inbound_at is not null
      and x.inbound_at > coalesce(s.studio_at, '-infinity'::timestamptz)
      and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
      and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
      and not (
        s.studio_at is not null
        and x.inbound_at <= s.studio_at + interval '24 hours'
        -- An explicit close in an ongoing exchange does not need a second reply.
        -- A classifier can still override ambiguous acknowledgements.
        and (a.is_explicit_close or crm_private.is_short_reply_acknowledgement(x.inbound_body))
        and not exists (
          select 1
          from public.communication_conversations c
          join crm_private.client_reply_marks m
            on m.artist_id = c.artist_id and m.client_id = c.client_id
          where c.id = p_conversation_id
            and c.client_id is not null
            and m.message_at = x.inbound_at
            and m.reply_state = 'reply_required'
            and (m.source is distinct from 'classifier' or not a.is_explicit_close)
        )
      )
    then x.inbound_at
  end
  from latest x
  cross join lateral (
    select crm_private.conversation_last_studio_reply_at(p_conversation_id) as studio_at
  ) s
  cross join lateral (
    select coalesce(
      x.inbound_type = 'text'
      and btrim(regexp_replace(lower(x.inbound_body), '[[:space:].!,]+', ' ', 'g'))
        ~ '^((ok(ay)? )?(mate )?(thanks|thank you|cheers)( mate)?|never mind i found (it|the (button|door|exit|entrance))( (ha ha|haha))?( (thanks|thank you|cheers))?)$',
      false
    ) as is_explicit_close
  ) a;
$function$
