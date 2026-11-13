-- Production regressions, strictly rollback-only. Never send a message or
-- create production contacts. Uses synthetic contacts in the local pgTAP stack.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(crm_private.is_short_reply_acknowledgement('Cool 👌🏼')
    and crm_private.is_short_reply_acknowledgement('Okay 👍🏻')
    and not crm_private.is_short_reply_acknowledgement('Cool?')
    and not crm_private.is_short_reply_acknowledgement('Cool, can you move it'),
    'short acknowledgements are strictly bounded, not arbitrary messages');

create function pg_temp.seed_reply_case(p_n integer, p_body text,
    p_has_studio boolean default true, p_reaction_origin text default null)
returns uuid language plpgsql as $fn$
declare
  v_client uuid := format('c3860000-0000-4000-8000-%s', lpad(p_n::text,12,'0'))::uuid;
  v_conv uuid := format('d3860000-0000-4000-8000-%s', lpad(p_n::text,12,'0'))::uuid;
  v_artist uuid := 'a1111111-1111-4111-8111-111111111111';
begin
  insert into public.clients (id, workspace_id, full_name, email)
  values (v_client, (select workspace_id from public.artists where id=v_artist),
    'Ack case '||p_n,'ack-386-'||p_n||'@example.test');
  insert into public.communication_conversations
    (id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state)
  values (v_conv,v_artist,'whatsapp','ack-test-386','synthetic-386-'||p_n,v_client,'linked','open');
  if p_has_studio then
    insert into public.communication_messages
      (conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp,sent_at,created_at)
    values (v_conv,v_artist,'whatsapp','outbound','provider_app','sent','text',
      'Studio reply',now()-interval '5 minutes',now()-interval '5 minutes',now()-interval '5 minutes');
  end if;
  insert into public.communication_messages
    (conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp,created_at)
  values (v_conv,v_artist,'whatsapp','inbound','contact','received','text',
    p_body,now()-interval '4 minutes',now()-interval '4 minutes');
  if p_reaction_origin is not null then
    insert into public.communication_messages
      (conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp,sent_at,created_at)
    values (v_conv,v_artist,'whatsapp','outbound',p_reaction_origin::public.communication_origin,'sent',
      'reaction','',now()-interval '3 minutes',now()-interval '3 minutes',now()-interval '3 minutes');
  end if;
  return v_conv;
end;
$fn$;

create temp table ack_cases (n integer primary key, id uuid not null) on commit drop;
insert into ack_cases select 1,pg_temp.seed_reply_case(1,'Cool 👌🏼');
insert into ack_cases select 2,pg_temp.seed_reply_case(2,'I have tank tops (vests) I bought specifically for this',true,'provider_app');
insert into ack_cases select 3,pg_temp.seed_reply_case(3,'Sweet, see you tomorrow',true,'provider_app');
insert into ack_cases select 4,pg_temp.seed_reply_case(4,'Can you move my appointment to Friday?',true,'provider_app');
insert into ack_cases select 5,pg_temp.seed_reply_case(5,'Please move my booking to Friday',true,'provider_app');
insert into ack_cases select 6,pg_temp.seed_reply_case(6,'I have tank tops (vests) I bought specifically for this',true,null);
insert into ack_cases select 7,pg_temp.seed_reply_case(7,'Cool 👌🏼',false,null);
insert into ack_cases select 8,pg_temp.seed_reply_case(8,'I have tank tops (vests) I bought specifically for this',true,'automation');
insert into ack_cases select 9,pg_temp.seed_reply_case(9,'Cool 👌🏼',true,null);

-- An explicit human/AI "reply_required" mark overrides an otherwise short ack.
insert into crm_private.client_reply_marks (artist_id,client_id,message_at,reply_state,source)
select c.artist_id,c.client_id,m.provider_timestamp,'reply_required','operator'
from public.communication_conversations c
join public.communication_messages m on m.conversation_id=c.id and m.direction='inbound'
where c.id=(select id from ack_cases where n=9);

select is(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=1)),
  null::timestamptz, 'Cool after a studio answer does not request a second reply');
select is(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=2)),
  null::timestamptz, 'a manual reaction closes a non-question confirmation (Donovan)');
select is(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=3)),
  null::timestamptz, 'a manual reaction closes See you tomorrow (Aaron)');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=4)) is not null,
  'a manual reaction does not hide an explicit appointment-change question');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=5)) is not null,
  'a manual reaction does not hide a booking change without a question mark');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=6)) is not null,
  'an informational message without a human reaction still waits');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=7)) is not null,
  'a first-contact Cool without prior studio reply still waits');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=8)) is not null,
  'an automation reaction cannot dismiss a client message');
select ok(crm_private.conversation_awaiting_reply_since((select id from ack_cases where n=9)) is not null,
  'explicit reply_required evidence wins over a short acknowledgement');

select ok(not has_function_privilege('anon','crm_private.is_short_reply_acknowledgement(text)','execute')
    and not has_function_privilege('authenticated','crm_private.is_short_reply_acknowledgement(text)','execute')
    and not has_function_privilege('authenticated','crm_private.conversation_awaiting_reply_since(uuid)','execute')
    and not has_function_privilege('authenticated','crm_private.studio_reaction_acknowledged_at(uuid)','execute'),
    'none of the internal reply helpers is exposed to browser clients');

-- The original artist/client RLS boundaries remain, but archived clients must
-- be invisible to the inbox regardless of stored provider metadata.
select ok(exists (
  select 1 from pg_policies
  where schemaname='public' and tablename='gmail_client_metadata_snapshots'
    and policyname='gmail_client_metadata_snapshots_select'
    and qual ilike '%can_access_artist%'
    and qual ilike '%can_access_client%'
    and qual ilike '%archived_at%'
), 'Gmail inbox RLS preserves artist/client scope and excludes archived clients');

insert into public.gmail_client_metadata_snapshots (artist_id,client_id,subject,last_message_at,direction)
values ('a1111111-1111-4111-8111-111111111111',
 (select client_id from public.communication_conversations where id=(select id from ack_cases where n=1)),
 'Active inbox entry', now(),'inbound'),
 ('a1111111-1111-4111-8111-111111111111',
 (select client_id from public.communication_conversations where id=(select id from ack_cases where n=2)),
 'Archived inbox entry', now(),'inbound');

update public.clients set archived_at=now()
where id=(select client_id from public.communication_conversations where id=(select id from ack_cases where n=2));

insert into auth.users(id,email) values
  ('f3860000-0000-4000-8000-000000000001','ack-manager-386@example.test');
insert into public.profiles(id,email,role,is_active) values
  ('f3860000-0000-4000-8000-000000000001','ack-manager-386@example.test','booking_manager',true);
insert into public.artist_memberships(profile_id,artist_id,access_level,can_manage_sessions,can_manage_integrations,is_active)
values ('f3860000-0000-4000-8000-000000000001','a1111111-1111-4111-8111-111111111111','manager',true,false,true);

select set_config('request.jwt.claims',
  '{"sub":"f3860000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*)::integer from public.gmail_client_metadata_snapshots
   where artist_id='a1111111-1111-4111-8111-111111111111'
    and client_id in ('c3860000-0000-4000-8000-000000000001','c3860000-0000-4000-8000-000000000002')),
  1, 'artist can see the active Gmail client, not the archived Test-like client');
select ok(exists(
  select 1 from public.gmail_client_metadata_snapshots
  where client_id='c3860000-0000-4000-8000-000000000001'
), 'the active client is still visible and available for reply');
reset role;

select is((select count(*)::integer from public.gmail_client_metadata_snapshots
    where client_id='c3860000-0000-4000-8000-000000000002'),
  1, 'the old snapshot is retained as historical evidence, not deleted');

select * from finish(true);
rollback;
