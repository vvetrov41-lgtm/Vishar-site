-- Stage a new first-person consultation WhatsApp Utility card for Vladimir.
-- Only Meta approval may permit a later guarded activation; existing live
-- consultation v1 and all production appointments/messages remain untouched.
alter table crm_private.lifecycle_whatsapp_template_candidates
  drop constraint lifecycle_whatsapp_template_candidates_purpose_check;
alter table crm_private.lifecycle_whatsapp_template_candidates
  add constraint lifecycle_whatsapp_template_candidates_purpose_check
  check (purpose in ('session_reminder_72h','session_reminder_24h','consultation_reminder'));

do $guard$
begin
  if not exists (
    select 1 from crm_private.lifecycle_whatsapp_template_registry r
    join public.artists a on a.id=r.artist_id
    where a.id='a1111111-1111-4111-8111-111111111111'::uuid
      and a.slug='vladimir'
      and r.purpose='consultation_reminder'
      and r.template_name='vishar_lifecycle_consultation_v1'
      and r.template_language='en_GB'
      and r.approval_status='APPROVED'
      and r.provider_template_id is not null
  ) then
    raise exception 'Vladimir WhatsApp consultation template drifted'
      using errcode='23514';
  end if;
end;
$guard$;

insert into crm_private.lifecycle_whatsapp_template_candidates
  (artist_id,purpose,template_name,template_language)
select artist_id,'consultation_reminder','vishar_lifecycle_consultation_v2','en_GB'
from crm_private.lifecycle_whatsapp_template_registry
where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  and purpose='consultation_reminder';
