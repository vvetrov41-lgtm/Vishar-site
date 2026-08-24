-- 0092_automation_client_message_action.sql
--
-- PostgreSQL does not allow a newly-added enum value to be used safely by
-- subsequent statements in the same transaction on every supported migration
-- path. Keep this enum expansion isolated so 0093 can use it normally.

alter type public.automation_action_type add value if not exists 'send_client_message';
