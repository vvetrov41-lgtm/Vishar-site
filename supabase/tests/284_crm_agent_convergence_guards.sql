-- Regression coverage for long-running client-state convergence.
begin;
select no_plan();

select ok(
  position('pg_current_xact_id()' in lower(pg_get_functiondef(
    'crm_private.enqueue_project_client_ai()'::regprocedure))) > 0,
  'project updates use mutation-unique refresh ids');
select ok(
  position('pg_current_xact_id()' in lower(pg_get_functiondef(
    'crm_private.enqueue_session_client_ai()'::regprocedure))) > 0,
  'session updates use mutation-unique refresh ids');
select ok(
  position('pg_current_xact_id()' in lower(pg_get_functiondef(
    'crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'enquiry edits use mutation-unique refresh ids');
select ok(
  position('project_ai_fingerprint(old) = v_new' in lower(pg_get_functiondef(
    'crm_private.enqueue_project_client_ai()'::regprocedure))) > 0,
  'project no-op detection still uses its state fingerprint');
select ok(
  position('session_ai_fingerprint(old) = v_new' in lower(pg_get_functiondef(
    'crm_private.enqueue_session_client_ai()'::regprocedure))) > 0,
  'session no-op detection still uses its state fingerprint');

select ok(
  position('new.direction not in (''inbound'', ''outbound'')' in lower(pg_get_functiondef(
    'crm_private.enqueue_communication_client_ai()'::regprocedure))) > 0,
  'linked communication refresh accepts inbound and outbound content');
select ok(
  position('update of direction, body, provider_timestamp' in lower(pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.communication_messages'::regclass
      and tgname = 'communication_messages_enqueue_client_ai'
      and not tgisinternal
  )))) > 0,
  'communication content corrections also converge');

select ok(
  position('x.status = ''sent''' in lower(pg_get_functiondef(
    'crm_private.client_ai_watermark(uuid,uuid)'::regprocedure))) > 0,
  'client watermark excludes unsent CRM email');
select ok(
  position('''body'', x.body' in lower(pg_get_functiondef(
    'crm_private.client_ai_watermark(uuid,uuid)'::regprocedure))) > 0,
  'sent CRM email body participates in the watermark');
select ok(
  position('x.status = ''sent''' in lower(pg_get_functiondef(
    'crm_private.client_timeline_items(uuid,uuid)'::regprocedure))) > 0,
  'client timeline excludes CRM email drafts');
select ok(
  position('|| x.body' in lower(pg_get_functiondef(
    'crm_private.client_timeline_items(uuid,uuid)'::regprocedure))) > 0,
  'sent CRM email body is available to bounded client context');
select ok(
  position('new.status <> ''sent''' in lower(pg_get_functiondef(
    'crm_private.enqueue_sent_email_client_ai()'::regprocedure))) > 0,
  'email refresh ignores drafts and other unsent states');
select ok(
  position('pg_current_xact_id()' in lower(pg_get_functiondef(
    'crm_private.enqueue_sent_email_client_ai()'::regprocedure))) > 0,
  'corrections to already-sent email use mutation-unique refresh ids');
select ok(
  position('update of status, subject, body, sent_at' in lower(pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.email_messages'::regclass
      and tgname = 'email_messages_enqueue_client_ai'
      and not tgisinternal
  )))) > 0,
  'email trigger covers every sent-email field used by client memory');

select ok(
  not has_function_privilege('anon', 'crm_private.enqueue_sent_email_client_ai()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.enqueue_sent_email_client_ai()', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.enqueue_sent_email_client_ai()', 'EXECUTE'),
  'new trigger helper is not callable through API roles');

select * from finish();
rollback;
