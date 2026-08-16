-- 1835_gpt_foundation_restore.sql
--
-- Restore the exact migration-defined GPT surface after the legacy pre-GPT
-- compatibility tests. This runs before the dedicated GPT tests so they exercise
-- the real grants and metadata state rather than the compatibility fixture used
-- by 050/100.

select no_plan();

grant execute on function public.configure_gpt_action_client(text,text,boolean,boolean)
  to authenticated;
grant execute on function public.gpt_search_clients(text,integer)
  to authenticated;
grant execute on function public.gpt_list_appointments(timestamptz,timestamptz,integer)
  to authenticated;
grant execute on function public.gpt_get_appointment(uuid)
  to authenticated;
grant execute on function public.gpt_list_appointment_conflicts(timestamptz,timestamptz,uuid)
  to authenticated;
grant execute on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  to authenticated;
grant execute on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  to authenticated;
grant execute on function public.gpt_cancel_appointment(uuid,uuid,integer)
  to authenticated;
grant execute on function public.get_gpt_action_consent_summary(text)
  to authenticated;
grant execute on function public.configure_gpt_enquiry_read_access(text,boolean)
  to authenticated;
grant execute on function public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)
  to authenticated;
grant execute on function public.gpt_get_enquiry(uuid)
  to authenticated;

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
  (
    'a1111111-1111-4111-8111-111111111111',
    'gpt', 'openai_gpt_actions', 'vladimir-gpt-actions',
    'Vladimir private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'gpt', 'openai_gpt_actions', 'kristina-gpt-actions',
    'Kristina private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  )
on conflict (artist_id, integration_type, integration_key) do update
set provider = excluded.provider,
    external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled;

select is(
  (select count(*)::int
   from unnest(array[
     'public.configure_gpt_action_client(text,text,boolean,boolean)',
     'public.gpt_search_clients(text,integer)',
     'public.gpt_list_appointments(timestamptz,timestamptz,integer)',
     'public.gpt_get_appointment(uuid)',
     'public.gpt_list_appointment_conflicts(timestamptz,timestamptz,uuid)',
     'public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)',
     'public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)',
     'public.gpt_cancel_appointment(uuid,uuid,integer)',
     'public.get_gpt_action_consent_summary(text)',
     'public.configure_gpt_enquiry_read_access(text,boolean)',
     'public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)',
     'public.gpt_get_enquiry(uuid)'
   ]::text[]) as signature
   where has_function_privilege('authenticated', signature, 'EXECUTE')),
  12,
  'all twelve migration-defined authenticated GPT/consent/configuration grants are restored'
);

select is(
  (select count(*)::int
   from public.artist_integrations
   where integration_type = 'gpt'
     and provider = 'openai_gpt_actions'
     and integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions')
     and is_enabled = false),
  2,
  'both disabled private-GPT integration metadata rows are restored'
);

select * from finish(true);
