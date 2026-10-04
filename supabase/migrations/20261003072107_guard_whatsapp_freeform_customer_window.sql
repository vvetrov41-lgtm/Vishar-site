-- Reconcile the historical production migration that guards free-form WhatsApp sends.
-- The provider accepts arbitrary text only during the client's 24-hour service window.
create or replace function public.queue_whatsapp_message(
  p_conversation_id uuid,
  p_body text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
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
