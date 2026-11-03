-- Today reply alerts must respect the existing per-message "no_reply_needed"
-- verdict from the CRM's operator/classifier. Never blanket-hide a booked client:
-- a different newer inbound requiring a response still appears normally.
-- No client data, messages, appointments, booking cards or payment rows change.
CREATE OR REPLACE FUNCTION crm_private.conversation_awaiting_reply_since(p_conversation_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  select case
    when x.inbound_at is not null
     and x.inbound_at > coalesce(crm_private.conversation_last_studio_reply_at(p_conversation_id), '-infinity'::timestamptz)
     and crm_private.inbound_message_handled_by_booking(x.inbound_id) is null
     and crm_private.studio_reaction_acknowledged_at(x.inbound_id) is null
     -- Today's reply list must respect the same classifier/operator verdict
     -- already used by client_attention and its SLA. Match the exact newest
     -- inbound timestamp, so an earlier acknowledgement cannot hide a new
     -- client question, and another client's mark cannot mask this thread.
     and coalesce((
       select mark.reply_state
       from public.communication_conversations c
       join crm_private.client_reply_marks mark
         on mark.artist_id = c.artist_id and mark.client_id = c.client_id
       where c.id = p_conversation_id
         and mark.message_at = x.inbound_at
       order by (mark.source = 'operator') desc, mark.created_at desc, mark.id desc
       limit 1
     ), 'reply_required') <> 'no_reply_needed'
    then x.inbound_at
  end
  from (
    select m.id as inbound_id, coalesce(m.provider_timestamp, m.created_at) as inbound_at
    from public.communication_messages m
    where m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
      and crm_private.communication_event_is_actionable(m.message_type)
    order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
    limit 1
  ) x;
$function$
;
