-- Reconcile the historical production migration that routes GPT WhatsApp sends
-- through queue_whatsapp_message, which enforces Meta's 24-hour window.
create or replace function public.gpt_send_whatsapp_message(
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
  v_artist_id uuid;
  v_conversation_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

  select wc.artist_id into v_conversation_artist
  from public.whatsapp_conversations wc
  where wc.id = p_conversation_id;

  if v_conversation_artist is distinct from v_artist_id then
    raise exception 'WhatsApp conversation is outside this GPT artist scope' using errcode = '42501';
  end if;

  return public.queue_whatsapp_message(p_conversation_id, p_body, p_request_id);
end;
$function$;
