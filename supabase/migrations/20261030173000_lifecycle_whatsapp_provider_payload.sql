-- Immutable Meta Utility payload, paired with a concrete automation job.
-- The existing WhatsApp communication outbox handles leases, provider intents,
-- acknowledgements and artist-scoped encrypted bindings.
create table crm_private.lifecycle_whatsapp_payloads (
  automation_job_id uuid primary key references public.automation_jobs(id) on delete restrict,
  communication_message_id uuid not null unique
    references public.communication_messages(id) on delete restrict,
  artist_id uuid not null references public.artists(id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete restrict,
  purpose text not null check (purpose in
    ('session_reminder_72h','session_reminder_24h',
     'post_session_aftercare','post_session_checkin')),
  template_name text not null check (template_name ~ '^[a-z0-9_]+),
  template_language text not null check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  body_parameters jsonb not null check (
    jsonb_typeof(body_parameters)='array'
    and jsonb_array_length(body_parameters) between 1 and 10
  ),
  members jsonb not null check (
    jsonb_typeof(members)='array' and jsonb_array_length(members)>0
  ),
  created_at timestamptz not null default now()
);
alter table crm_private.lifecycle_whatsapp_payloads enable row level security;
revoke all on crm_private.lifecycle_whatsapp_payloads from public,anon,authenticated,service_role;

-- Lease-bound, read-only final check before creating the durable send intent.
-- Unrelated free-form and booking-card jobs produce is_lifecycle=false.
create or replace function public.service_resolve_whatsapp_lifecycle_payload(
 p_outbox_id uuid,p_worker_id text
)
returns table(
 is_lifecycle boolean,communication_message_id uuid,artist_id uuid,
 template_name text,template_language text,purpose text,body_parameters jsonb,
 delivery_allowed boolean
)
language plpgsql stable security definer
set search_path=pg_catalog,public,crm_private as $function$
begin
 if not crm_private.is_service_backend() then
   raise exception 'lifecycle WhatsApp resolution is backend-only' using errcode='42501';
 end if;
 if p_outbox_id is null or coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$' then
   raise exception 'valid WhatsApp worker lease is required' using errcode='22023';
 end if;
 return query
 select p.automation_job_id is not null,m.id,o.artist_id,
   p.template_name,p.template_language,p.purpose,p.body_parameters,
   (
     p.automation_job_id is not null
     and m.message_type='template'
     and m.status='queued'::public.communication_status
     and m.artist_id=o.artist_id
     and o.client_id=s.client_id
     and j.id=p.automation_job_id and j.artist_id=o.artist_id
     and j.status='completed'::public.automation_job_status
     and j.message_purpose=p.purpose
     and j.session_id=p.session_id
     and s.artist_id=o.artist_id
     and s.appointment_type in ('tattoo_session','touch_up')
     and (
       (p.purpose in ('session_reminder_72h','session_reminder_24h')
         and s.status='confirmed'::public.session_status and s.start_at>now())
       or
       (p.purpose in ('post_session_aftercare','post_session_checkin')
         and s.status='completed'::public.session_status)
     )
     and p.members=crm_private.lifecycle_email_members(p.session_id,p.purpose)
     and crm_private.client_send_block_reason(s.client_id,'whatsapp','service') is null
     and exists (
       select 1 from crm_private.booking_card_conversation_evidence(s.client_id,o.artist_id) ev
       where ev.channel='whatsapp'
     )
     and exists (
       select 1 from crm_private.lifecycle_whatsapp_template_registry t
       where t.artist_id=o.artist_id and t.purpose=p.purpose
         and t.template_name=p.template_name
         and t.template_language=p.template_language
         and t.approval_status='APPROVED' and t.provider_template_id is not null
         and t.verified_at>now()-interval '24 hours'
     )
   ) as delivery_allowed
 from public.integration_outbox o
 join public.communication_messages m on m.id=o.communication_message_id
 left join crm_private.lifecycle_whatsapp_payloads p
   on p.communication_message_id=m.id and p.artist_id=o.artist_id
 left join public.automation_jobs j on j.id=p.automation_job_id
 left join public.sessions s on s.id=p.session_id
 where o.id=p_outbox_id
   and o.kind='whatsapp_message'::public.outbox_kind
   and o.status='leased'::public.outbox_status
   and o.leased_by=p_worker_id and o.lease_expires_at>now()
   and m.artist_id=o.artist_id;
end;
$function$;
revoke all on function public.service_resolve_whatsapp_lifecycle_payload(uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.service_resolve_whatsapp_lifecycle_payload(uuid,text)
 to service_role;
 and char_length(template_name) <= 512),
  template_language text not null check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  body_parameters jsonb not null check (
    jsonb_typeof(body_parameters)='array'
    and jsonb_array_length(body_parameters) between 1 and 10
  ),
  members jsonb not null check (
    jsonb_typeof(members)='array' and jsonb_array_length(members)>0
  ),
  created_at timestamptz not null default now()
);
alter table crm_private.lifecycle_whatsapp_payloads enable row level security;
revoke all on crm_private.lifecycle_whatsapp_payloads from public,anon,authenticated,service_role;

-- Lease-bound, read-only final check before creating the durable send intent.
-- Unrelated free-form and booking-card jobs produce is_lifecycle=false.
create or replace function public.service_resolve_whatsapp_lifecycle_payload(
 p_outbox_id uuid,p_worker_id text
)
returns table(
 is_lifecycle boolean,communication_message_id uuid,artist_id uuid,
 template_name text,template_language text,purpose text,body_parameters jsonb,
 delivery_allowed boolean
)
language plpgsql stable security definer
set search_path=pg_catalog,public,crm_private as $function$
begin
 if not crm_private.is_service_backend() then
   raise exception 'lifecycle WhatsApp resolution is backend-only' using errcode='42501';
 end if;
 if p_outbox_id is null or coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$' then
   raise exception 'valid WhatsApp worker lease is required' using errcode='22023';
 end if;
 return query
 select p.automation_job_id is not null,m.id,o.artist_id,
   p.template_name,p.template_language,p.purpose,p.body_parameters,
   (
     p.automation_job_id is not null
     and m.message_type='template'
     and m.status='queued'::public.communication_status
     and m.artist_id=o.artist_id
     and o.client_id=s.client_id
     and j.id=p.automation_job_id and j.artist_id=o.artist_id
     and j.status='completed'::public.automation_job_status
     and j.message_purpose=p.purpose
     and j.session_id=p.session_id
     and s.artist_id=o.artist_id
     and s.appointment_type in ('tattoo_session','touch_up')
     and (
       (p.purpose in ('session_reminder_72h','session_reminder_24h')
         and s.status='confirmed'::public.session_status and s.start_at>now())
       or
       (p.purpose in ('post_session_aftercare','post_session_checkin')
         and s.status='completed'::public.session_status)
     )
     and p.members=crm_private.lifecycle_email_members(p.session_id,p.purpose)
     and crm_private.client_send_block_reason(s.client_id,'whatsapp','service') is null
     and exists (
       select 1 from crm_private.booking_card_conversation_evidence(s.client_id,o.artist_id) ev
       where ev.channel='whatsapp'
     )
     and exists (
       select 1 from crm_private.lifecycle_whatsapp_template_registry t
       where t.artist_id=o.artist_id and t.purpose=p.purpose
         and t.template_name=p.template_name
         and t.template_language=p.template_language
         and t.approval_status='APPROVED' and t.provider_template_id is not null
         and t.verified_at>now()-interval '24 hours'
     )
   ) as delivery_allowed
 from public.integration_outbox o
 join public.communication_messages m on m.id=o.communication_message_id
 left join crm_private.lifecycle_whatsapp_payloads p
   on p.communication_message_id=m.id and p.artist_id=o.artist_id
 left join public.automation_jobs j on j.id=p.automation_job_id
 left join public.sessions s on s.id=p.session_id
 where o.id=p_outbox_id
   and o.kind='whatsapp_message'::public.outbox_kind
   and o.status='leased'::public.outbox_status
   and o.leased_by=p_worker_id and o.lease_expires_at>now()
   and m.artist_id=o.artist_id;
end;
$function$;
revoke all on function public.service_resolve_whatsapp_lifecycle_payload(uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.service_resolve_whatsapp_lifecycle_payload(uuid,text)
 to service_role;
