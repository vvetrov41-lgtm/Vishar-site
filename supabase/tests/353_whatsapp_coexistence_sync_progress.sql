-- No customer data can be stored during Meta's one-time Coexistence sync.
begin;
select no_plan();

select ok(to_regclass('crm_private.whatsapp_coexistence_sync_progress') is not null,
 'sync progress table exists');
select ok(not has_table_privilege('anon','crm_private.whatsapp_coexistence_sync_progress','SELECT')
 and not has_table_privilege('authenticated','crm_private.whatsapp_coexistence_sync_progress','SELECT')
 and not has_table_privilege('service_role','crm_private.whatsapp_coexistence_sync_progress','SELECT'),
 'sync claims invisible to customers and generic roles');
select ok(has_function_privilege('authenticated',
 'public.claim_whatsapp_coexistence_sync(uuid,text,text,text)','execute')
 and has_function_privilege('authenticated',
 'public.record_whatsapp_coexistence_sync_accepted(uuid,text)','execute'),
 'authorized artist CRM operator may use the bounded RPC');
select ok(not has_function_privilege('anon',
 'public.claim_whatsapp_coexistence_sync(uuid,text,text,text)','execute')
 and not has_function_privilege('anon',
 'public.record_whatsapp_coexistence_sync_accepted(uuid,text)','execute'),
 'anonymous users cannot initiate sync');

select ok(not exists (
  select 1 from information_schema.columns c
  where c.table_schema='crm_private'
    and c.table_name='whatsapp_coexistence_sync_progress'
    and c.column_name in ('message','messages','contact','contacts','history',
      'message_body','phone_contact','access_token','app_secret','webhook_payload')
), 'no contacts, messages, credentials, or history columns');

insert into crm_private.whatsapp_coexistence_sync_progress
  (artist_id,sync_type,waba_id,phone_number_id,state)
values ('a2222222-2222-4222-8222-222222222222'::uuid,
 'smb_app_state_sync','462106700328578','518907894641289','claimed');
select is((select count(*)::integer from crm_private.whatsapp_coexistence_sync_progress
 where artist_id='a2222222-2222-4222-8222-222222222222'::uuid),1,
 'one claimed sync per artist and sync type');
select throws_ok($test$insert into crm_private.whatsapp_coexistence_sync_progress
 (artist_id,sync_type,waba_id,phone_number_id,state)
 values ('a2222222-2222-4222-8222-222222222222'::uuid,
  'smb_app_state_sync','462106700328578','518907894641289','claimed')$test$,
 '23505',null,'duplicate once-only claim is rejected');
select throws_ok($test$insert into crm_private.whatsapp_coexistence_sync_progress
 (artist_id,sync_type,waba_id,phone_number_id,state)
 values ('a2222222-2222-4222-8222-222222222222'::uuid,
  'contacts','462106700328578','518907894641289','claimed')$test$,
 '23514',null,'unapproved sync type rejected');
select throws_ok($test$update crm_private.whatsapp_coexistence_sync_progress
 set state='accepted' where sync_type='smb_app_state_sync'$test$,
 '23514',null,'accepted state must carry acceptance timestamp');

update crm_private.whatsapp_coexistence_sync_progress
 set state='accepted', accepted_at=now()
 where sync_type='smb_app_state_sync';
select is((select state from crm_private.whatsapp_coexistence_sync_progress
  where sync_type='smb_app_state_sync'), 'accepted',
 'accepted receipt persists without provider payload');

select * from finish();
rollback;
