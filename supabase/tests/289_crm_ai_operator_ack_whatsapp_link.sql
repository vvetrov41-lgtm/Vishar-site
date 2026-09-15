-- Regression coverage for false client-AI attention after operator acknowledgement
-- and for exact WhatsApp phone auto-linking.
begin;
select no_plan();

select ok(
  position($needle$v_status = 'new'$needle$ in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0,
  'new enquiries may still produce request_information');
select ok(
  position($needle$'declined'$needle$ in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0
  and position($needle$'converted'$needle$ in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0
  and position($needle$'closed'$needle$ in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0,
  'terminal enquiry states cannot reopen intake questions');
select ok(
  position($needle$t.source <> 'enquiry'$needle$ in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0
  and position('t.occurred_at > v_ack_at' in lower(pg_get_functiondef(
    'crm_private.client_request_information_is_actionable(uuid,uuid)'::regprocedure))) > 0,
  'after operator acknowledgement only a newer inbound interaction may reactivate intake attention');

select ok(
  position($needle$new.status := 'superseded'$needle$ in lower(pg_get_functiondef(
    'crm_private.guard_client_ai_next_action_truth()'::regprocedure))) > 0,
  'invalid request_information is suppressed rather than renamed to another notifying action');
select ok(
  position('client_request_information_is_actionable' in lower(pg_get_functiondef(
    'crm_private.guard_client_ai_next_action_truth()'::regprocedure))) > 0,
  'next-action persistence guard respects operator acknowledgement');
select ok(
  position('client_request_information_is_actionable' in lower(pg_get_functiondef(
    'crm_private.client_ai_notification_is_current(public.notifications)'::regprocedure))) > 0,
  'Telegram live-read guard rechecks operator acknowledgement before delivery');
select ok(
  position($needle$a.action_type = 'request_information'$needle$ in lower(pg_get_functiondef(
    'crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0
  and position($needle$set status = 'superseded'$needle$ in lower(pg_get_functiondef(
    'crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'changing enquiry workflow status immediately closes an existing intake request');

select ok(
  position('normalize_whatsapp_phone' in lower(pg_get_functiondef(
    'crm_private.unique_whatsapp_client_match(uuid,text)'::regprocedure))) > 0
  and position('v_count = 1' in lower(pg_get_functiondef(
    'crm_private.unique_whatsapp_client_match(uuid,text)'::regprocedure))) > 0,
  'WhatsApp auto-linking requires one unique normalized phone match');
select ok(
  position('client_in_artist_scope' in lower(pg_get_functiondef(
    'crm_private.unique_whatsapp_client_match(uuid,text)'::regprocedure))) > 0,
  'WhatsApp phone matching stays inside the artist scope');
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.communication_conversations'::regclass
      and tgname = 'communication_conversations_auto_link_whatsapp'
      and not tgisinternal
  ),
  'communication conversations have an exact-phone WhatsApp auto-link trigger');
select ok(
  position($needle$new.link_state := 'linked'$needle$ in lower(pg_get_functiondef(
    'crm_private.auto_link_whatsapp_conversation_client()'::regprocedure))) > 0
  and position('new.client_id := v_client_id' in lower(pg_get_functiondef(
    'crm_private.auto_link_whatsapp_conversation_client()'::regprocedure))) > 0,
  'a unique WhatsApp phone match becomes a linked client conversation');

select ok(
  not has_function_privilege('anon', 'crm_private.client_request_information_is_actionable(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.client_request_information_is_actionable(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.client_request_information_is_actionable(uuid,uuid)', 'EXECUTE'),
  'operator-ack helper is private');
select ok(
  not has_function_privilege('anon', 'crm_private.unique_whatsapp_client_match(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.unique_whatsapp_client_match(uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.unique_whatsapp_client_match(uuid,text)', 'EXECUTE'),
  'WhatsApp matching helper is private');
select ok(
  not has_function_privilege('anon', 'crm_private.auto_link_whatsapp_conversation_client()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.auto_link_whatsapp_conversation_client()', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.auto_link_whatsapp_conversation_client()', 'EXECUTE'),
  'WhatsApp auto-link trigger helper is private');

select * from finish();
rollback;
