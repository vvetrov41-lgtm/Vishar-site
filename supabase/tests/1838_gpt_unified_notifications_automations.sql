-- 1838_gpt_unified_notifications_automations.sql
--
-- Unified GPT v2 Communications remainder, Notifications/Templates and
-- Automations wrappers: closed surface, the automations ceiling, Artist-scoped
-- notification inbox, template and rule ownership.

begin;
select no_plan();

select ok(
  (select bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')
     and p.prosecdef)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'gpt_edit_email_draft', 'gpt_dismiss_failed_email', 'gpt_get_conversation_link_suggestion',
     'gpt_snooze_follow_up', 'gpt_list_notifications', 'gpt_mark_notification_read',
     'gpt_mark_all_notifications_read', 'gpt_get_notification_preferences', 'gpt_set_notification_preference',
     'gpt_list_attention_acknowledgements', 'gpt_acknowledge_attention_item', 'gpt_list_message_templates',
     'gpt_list_template_purposes', 'gpt_list_template_variables', 'gpt_upsert_message_template',
     'gpt_set_message_template_active', 'gpt_list_lifecycle_rules', 'gpt_create_lifecycle_rule',
     'gpt_update_lifecycle_rule_timing', 'gpt_set_lifecycle_rule_enabled', 'gpt_list_lifecycle_preview_sessions',
     'gpt_preview_lifecycle_rule', 'gpt_list_lifecycle_execution_history', 'gpt_list_lifecycle_configuration_history',
     'gpt_get_lifecycle_health', 'gpt_retry_lifecycle_job', 'gpt_list_workspace_automation_defaults',
     'gpt_apply_workspace_automation_defaults')),
  'every notification and automation wrapper is an authenticated-only SECURITY DEFINER function'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'gpt_edit_email_draft', 'gpt_dismiss_failed_email', 'gpt_get_conversation_link_suggestion',
     'gpt_snooze_follow_up', 'gpt_list_notifications', 'gpt_mark_notification_read',
     'gpt_mark_all_notifications_read', 'gpt_get_notification_preferences', 'gpt_set_notification_preference',
     'gpt_list_attention_acknowledgements', 'gpt_acknowledge_attention_item', 'gpt_list_message_templates',
     'gpt_list_template_purposes', 'gpt_list_template_variables', 'gpt_upsert_message_template',
     'gpt_set_message_template_active', 'gpt_list_lifecycle_rules', 'gpt_create_lifecycle_rule',
     'gpt_update_lifecycle_rule_timing', 'gpt_set_lifecycle_rule_enabled', 'gpt_list_lifecycle_preview_sessions',
     'gpt_preview_lifecycle_rule', 'gpt_list_lifecycle_execution_history', 'gpt_list_lifecycle_configuration_history',
     'gpt_get_lifecycle_health', 'gpt_retry_lifecycle_job', 'gpt_list_workspace_automation_defaults',
     'gpt_apply_workspace_automation_defaults')),
  28,
  'all twenty-eight wrappers of this stage exist'
);

insert into auth.users (id, email) values
  ('de011111-1111-4111-8111-111111111111', 'gpt-auto-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('de011111-1111-4111-8111-111111111111', 'gpt-auto-owner@example.test', 'GPT Automation Owner', 'owner', true);

-- Notifications for the owner in both Artists. The Kristina alert is the
-- newest, so a limit applied before the Artist filter would hide Vladimir's.
insert into public.notifications (id, recipient_profile_id, artist_id, notification_type, title, body, status, dedupe_key, scheduled_at) values
  ('de021111-1111-4111-8111-111111111111', 'de011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'test.parity', 'Vladimir alert', 'Synthetic', 'delivered', 'gpt-parity-v', now() - interval '2 hours'),
  ('de023333-3333-4333-8333-333333333333', 'de011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'test.parity', 'Vladimir second alert', 'Synthetic', 'delivered', 'gpt-parity-v2', now() - interval '3 hours'),
  ('de022222-2222-4222-8222-222222222222', 'de011111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222', 'test.parity', 'Kristina alert', 'Synthetic', 'delivered', 'gpt-parity-k', now());

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"de011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-automation', true, true);
select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true);
select public.configure_gpt_full_management('vishar-unified-gpt', true, false, true);

select pg_temp.claims('{"sub":"de011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-automation"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');

-- --------------------------------------------- automations ceiling is off

select throws_ok($$select public.gpt_list_lifecycle_rules()$$, '42501', null,
  'lifecycle rules stay closed without the automations ceiling');
select throws_ok($$select public.gpt_list_message_templates()$$, '42501', null,
  'templates stay closed without the automations ceiling');

-- ------------------------------------------------ notifications per Artist

select is(
  (select count(*)::int from jsonb_array_elements(public.gpt_list_notifications(null, 50)) item
   where item ->> 'title' in ('Vladimir alert', 'Kristina alert')),
  1,
  'the notification inbox shows only the active Artist alerts'
);
select is(
  public.gpt_list_notifications(null, 1) -> 0 ->> 'title',
  'Vladimir alert',
  'the limit applies after the Artist filter, so a newer Kristina alert never empties the Vladimir inbox'
);
select throws_ok(
  $$select public.gpt_mark_notification_read('de022222-2222-4222-8222-222222222222')$$,
  '42501', null,
  'a Kristina notification cannot be marked from the Vladimir context'
);
select is(
  (public.gpt_mark_notification_read('de021111-1111-4111-8111-111111111111') ->> 'marked')::boolean,
  true,
  'a Vladimir notification is marked read'
);
select is(
  (public.gpt_mark_all_notifications_read() ->> 'marked')::int,
  1,
  'mark-all marks only the remaining unread Vladimir alert'
);
reset role;
select is(
  (select status::text from public.notifications where id = 'de022222-2222-4222-8222-222222222222'),
  'delivered',
  'mark-all from the Vladimir context leaves the Kristina alert unread'
);
set local role authenticated;
select lives_ok($$select public.gpt_set_notification_preference('telegram', false)$$,
  'the user changes their own notification channel');
select ok(
  public.gpt_get_notification_preferences() @> '[{"channel":"telegram","is_enabled":false}]'::jsonb,
  'the preference reads back for the signed-in user'
);
select lives_ok($$select public.gpt_list_attention_acknowledgements()$$, 'attention acknowledgements read');

select pg_temp.claims('{"sub":"de011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_unified_domain_access('vishar-unified-gpt', true, false, false);
select pg_temp.claims('{"sub":"de011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-automation"}');

-- ------------------------------------------------------ automations enabled

select lives_ok($$select public.gpt_list_lifecycle_rules()$$, 'lifecycle rules read with the ceiling');
select lives_ok($$select public.gpt_list_template_purposes()$$, 'template purposes read');
select lives_ok($$select public.gpt_list_template_variables()$$, 'template variables read');
select lives_ok($$select public.gpt_get_lifecycle_health()$$, 'lifecycle health reads');
select lives_ok($$select public.gpt_list_lifecycle_execution_history(10)$$, 'execution history reads');
select lives_ok($$select public.gpt_list_workspace_automation_defaults()$$, 'workspace defaults read');

create temporary table auto_rule as
select public.gpt_create_lifecycle_rule('Parity check-in', 'tattoo_session', 'post_session_checkin', 'session_end', 60, 'en') as result;
grant select on auto_rule to authenticated;
select ok((select result ? 'rule_id' from auto_rule), 'a lifecycle rule is created for the active Artist');
select lives_ok(
  $$select public.gpt_update_lifecycle_rule_timing((select (result ->> 'rule_id')::uuid from auto_rule), 'after_session_end', 2, 'hours')$$,
  'the rule timing changes through the CRM contract'
);
select lives_ok(
  $$select public.gpt_set_lifecycle_rule_enabled((select (result ->> 'rule_id')::uuid from auto_rule), false)$$,
  'the rule is turned off'
);

select public.gpt_artist_context('a2222222-2222-4222-8222-222222222222');
select throws_ok(
  $$select public.gpt_set_lifecycle_rule_enabled((select (result ->> 'rule_id')::uuid from auto_rule), true)$$,
  '42501', null,
  'a Vladimir rule cannot be changed from the Kristina context'
);
select throws_ok(
  $$select public.gpt_retry_lifecycle_job('de039999-9999-4999-8999-999999999999')$$,
  '42501', null,
  'an unknown automation job is refused as out of scope'
);
select throws_ok(
  $$select public.gpt_upsert_message_template('studio', 'post_session_checkin', 'email', 'Body', 'en', null)$$,
  '22023', null,
  'template scope is a closed choice'
);

select * from finish();
rollback;
