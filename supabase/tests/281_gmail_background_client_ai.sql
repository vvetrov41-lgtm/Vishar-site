-- No real customer mail or provider traffic. Rollback isolates all test changes.
begin;
select no_plan();

select has_table('crm_private','gmail_background_ai_capture_config',
  'Background capture config lives in private schema');
select has_function('public','service_select_background_gmail_ai_candidates',
  array['uuid','text','jsonb'],'Background selector exists');
select has_function('public','service_record_background_gmail_ai_message',
  array['uuid','uuid','text','text','text','text','text','text','timestamp with time zone'],
  'Background capture writer exists');

select ok(not has_function_privilege('anon',
  'public.service_select_background_gmail_ai_candidates(uuid,text,jsonb)','EXECUTE'),
  'Anonymous cannot select Gmail candidate IDs');
select ok(not has_function_privilege('authenticated',
  'public.service_select_background_gmail_ai_candidates(uuid,text,jsonb)','EXECUTE'),
  'CRM browser cannot select Gmail candidate IDs');
select ok(has_function_privilege('service_role',
  'public.service_select_background_gmail_ai_candidates(uuid,text,jsonb)','EXECUTE'),
  'Only service backend has selector capability');

select ok(not has_function_privilege('anon',
  'public.service_record_background_gmail_ai_message(uuid,uuid,text,text,text,text,text,text,timestamptz)','EXECUTE'),
  'Anonymous cannot persist mailbox content');
select ok(not has_function_privilege('authenticated',
  'public.service_record_background_gmail_ai_message(uuid,uuid,text,text,text,text,text,text,timestamptz)','EXECUTE'),
  'CRM browser cannot persist mailbox content');
select ok(has_function_privilege('service_role',
  'public.service_record_background_gmail_ai_message(uuid,uuid,text,text,text,text,text,text,timestamptz)','EXECUTE'),
  'Backend alone may record bounded customer excerpts');

select is((select enabled from crm_private.gmail_background_ai_capture_config where singleton),
  true, 'Migration activates capture with independent kill switch');
select ok((select activated_at <= clock_timestamp() from crm_private.gmail_background_ai_capture_config where singleton),
  'Activation cutoff is fixed at migration apply time');
select is((select count(*)::int from crm_private.crm_agent_config where singleton),
  1, 'Client AI config remains present without enabling it in test fixtures');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select is(
  public.service_select_background_gmail_ai_candidates(
    '11111111-1111-4111-8111-111111111111','not-connected@example.test','[]'::jsonb
  ),
  '[]'::jsonb,
  'Disconnected mailbox can never claim any full-message read');
reset role;

update crm_private.gmail_background_ai_capture_config set enabled=false,updated_at=now() where singleton;
set local role service_role;
select is(
  public.service_select_background_gmail_ai_candidates(
    '11111111-1111-4111-8111-111111111111','not-connected@example.test','[]'::jsonb
  ),
  '[]'::jsonb,
  'Disabling the independent gate returns no candidates');
reset role;

select * from finish();
rollback;
