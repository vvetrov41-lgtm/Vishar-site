-- 045_legacy_gpt_fixture_compat.sql
--
-- Tests 050 and 100 predate the private-GPT foundation and intentionally
-- inventory the API surface / integration metadata that existed before
-- migrations 0032-0034. Keep those historical assertions meaningful without
-- weakening production ACLs or changing migration behavior: hide only the new
-- GPT surface for the legacy pgTAP files, then restore and verify it in
-- 1835_gpt_foundation_restore.sql immediately before the dedicated GPT tests.

select no_plan();

revoke execute on function public.configure_gpt_action_client(text,text,boolean,boolean)
  from authenticated;
revoke execute on function public.gpt_search_clients(text,integer)
  from authenticated;
revoke execute on function public.gpt_list_appointments(timestamptz,timestamptz,integer)
  from authenticated;
revoke execute on function public.gpt_get_appointment(uuid)
  from authenticated;
revoke execute on function public.gpt_list_appointment_conflicts(timestamptz,timestamptz,uuid)
  from authenticated;
revoke execute on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  from authenticated;
revoke execute on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  from authenticated;
revoke execute on function public.gpt_cancel_appointment(uuid,uuid,integer)
  from authenticated;
revoke execute on function public.get_gpt_action_consent_summary(text)
  from authenticated;

delete from public.artist_integrations
where integration_type = 'gpt'
  and provider = 'openai_gpt_actions'
  and integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions');

select pass('legacy ACL and integration-metadata tests run against their pre-GPT fixture surface');

select * from finish(true);
