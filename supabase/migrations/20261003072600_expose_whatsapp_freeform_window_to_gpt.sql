-- Reconcile the historical production migration that exposes the WhatsApp
-- free-form service-window state to GPT callers.
create or replace function public.gpt_ensure_whatsapp_conversation(
  p_enquiry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
declare
  v_artist_id uuid;
  v_record_artist uuid;
  v_result jsonb;
  v_conversation_id uuid;
  v_last_inbound_at timestamptz;
  v_freeform_allowed boolean;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;

  select e.artist_id into v_record_artist
  from public.enquiries e
  where e.id = p_enquiry_id;

  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;

  v_result := public.ensure_whatsapp_conversation_for_enquiry(p_enquiry_id);
  v_conversation_id := (v_result ->> 'conversation_id')::uuid;

  select c.last_inbound_at
    into v_last_inbound_at
  from public.communication_conversations c
  where c.id = v_conversation_id
    and c.artist_id = v_artist_id
    and c.channel = 'whatsapp'::public.communication_channel;

  v_freeform_allowed := v_last_inbound_at is not null
    and v_last_inbound_at >= now() - interval '24 hours';

  return jsonb_build_object(
    'conversation_id', v_result ->> 'conversation_id',
    'client_id', v_result ->> 'client_id',
    'created', coalesce((v_result ->> 'created')::boolean, false),
    'last_inbound_at', v_last_inbound_at,
    'freeform_allowed', v_freeform_allowed,
    'requires_template', not v_freeform_allowed
  );
end;
$function$;
