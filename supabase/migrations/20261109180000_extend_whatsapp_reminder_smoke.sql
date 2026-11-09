-- Owner-directed test of the two approved tattoo-session reminders.
-- No bookings, messages, clients, or Meta template approvals are fabricated.
-- Existing consultation tests and their consumed provider results stay intact.
do $guard$
begin
  if (select count(*) from pg_constraint
      where conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
        and conname in (
          'whatsapp_template_smoke_tests_purpose_check',
          'whatsapp_template_smoke_tests_body_parameters_check')) <> 2 then
    raise exception 'WhatsApp smoke test constraints drifted';
  end if;
end
$guard$;

alter table crm_private.whatsapp_template_smoke_tests
  drop constraint whatsapp_template_smoke_tests_purpose_check,
  drop constraint whatsapp_template_smoke_tests_body_parameters_check,
  add constraint whatsapp_template_smoke_tests_purpose_check
    check (purpose in ('consultation_reminder',
                       'session_reminder_72h','session_reminder_24h')),
  add constraint whatsapp_template_smoke_tests_body_parameters_check
    check (
      jsonb_typeof(body_parameters)='array'
      and jsonb_array_length(body_parameters)=case purpose
        when 'consultation_reminder' then 5
        when 'session_reminder_72h' then 4
        when 'session_reminder_24h' then 3
        else -1
      end
    );
