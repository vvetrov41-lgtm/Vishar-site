-- WIP: provider-side revalidation is not a substitute for serializing schedule
-- mutations with dispatch. Never deploy until concurrency and recovery tests pass.
create table crm_private.lifecycle_email_snapshots (
  email_message_id uuid primary key references public.email_messages(id) on delete restrict,
  job_id uuid not null unique references public.automation_jobs(id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete restrict,
  purpose text not null,
  members jsonb not null check (jsonb_typeof(members)='array' and jsonb_array_length(members)>0),
  created_at timestamptz not null default now()
);
revoke all on crm_private.lifecycle_email_snapshots from public,anon,authenticated,service_role;

create or replace function crm_private.lifecycle_email_members(p_session_id uuid,p_purpose text)
returns jsonb language sql stable security invoker
set search_path=pg_catalog,public,crm_private as $function$
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',s.calendar_version,
   'start',s.start_at,'end',s.end_at,'actual_end',s.actual_end_at,'status',s.status) order by s.id),'[]'::jsonb)
 from crm_private.session_lifecycle_block(p_session_id) b
 join public.sessions s on s.id=b.session_id
 where p_purpose<>'post_session_aftercare' or s.id=p_session_id;
$function$;
revoke all on function crm_private.lifecycle_email_members(uuid,text) from public,anon,authenticated,service_role;

create or replace function crm_private.capture_lifecycle_email_snapshot()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare v_job public.automation_jobs%rowtype; v_members jsonb;
begin
 if new.automation_job_id is null then return new; end if;
 select * into v_job from public.automation_jobs where id=new.automation_job_id;
 if not found or v_job.message_purpose is null or v_job.message_purpose not in ('session_reminder_72h','session_reminder_24h','post_session_aftercare','post_session_checkin') then return new; end if;
 if v_job.artist_id is distinct from new.artist_id then raise exception 'lifecycle artist mismatch' using errcode='23514'; end if;
 v_members:=crm_private.lifecycle_email_members(v_job.session_id,v_job.message_purpose);
 if jsonb_array_length(v_members)=0 then raise exception 'lifecycle block unavailable' using errcode='23514'; end if;
 insert into crm_private.lifecycle_email_snapshots(email_message_id,job_id,session_id,purpose,members)
 values(new.id,v_job.id,v_job.session_id,v_job.message_purpose,v_members);
 return new;
end;
$function$;
revoke all on function crm_private.capture_lifecycle_email_snapshot() from public,anon,authenticated,service_role;
create trigger email_messages_capture_lifecycle_snapshot after insert on public.email_messages
for each row execute function crm_private.capture_lifecycle_email_snapshot();

create or replace function crm_private.lifecycle_delivery_snapshot_current(p_email_message_id uuid)
returns boolean language plpgsql stable security invoker
set search_path=pg_catalog,public,crm_private as $function$
declare v_job public.automation_jobs%rowtype; v_snapshot crm_private.lifecycle_email_snapshots%rowtype; v_message public.email_messages%rowtype;
begin
 select * into v_message from public.email_messages where id=p_email_message_id;
 if not found or v_message.automation_job_id is null then return false; end if;
 select * into v_job from public.automation_jobs where id=v_message.automation_job_id;
 if not found then return false; end if;
 if v_job.message_purpose is null or v_job.message_purpose not in ('session_reminder_72h','session_reminder_24h','post_session_aftercare','post_session_checkin') then return true; end if;
 select * into v_snapshot from crm_private.lifecycle_email_snapshots where email_message_id=v_message.id and job_id=v_job.id;
 if not found or v_snapshot.session_id is distinct from v_job.session_id or v_snapshot.purpose is distinct from v_job.message_purpose then return false; end if;
 if v_job.artist_id is distinct from v_message.artist_id
    or crm_private.client_send_block_reason(v_message.client_id,'email','service') is not null then return false; end if;
 return v_snapshot.members=crm_private.lifecycle_email_members(v_job.session_id,v_job.message_purpose);
end;
$function$;
revoke all on function crm_private.lifecycle_delivery_snapshot_current(uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.service_resolve_gmail_outbox_target(p_outbox_id uuid, p_worker_id text)
 RETURNS TABLE(outbox_id uuid, email_message_id uuid, artist_id uuid, enquiry_id uuid, client_id uuid, client_email text, integration_key text, mailbox_email text, configuration jsonb, delivery_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.integration_outbox%rowtype;
  v_message public.email_messages%rowtype;
  v_client_email text;
  v_card_current boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail outbox target resolution is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  select o.* into v_job from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status and o.leased_by = p_worker_id
    and o.lease_expires_at > now();
  if not found then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  select m.* into v_message from public.email_messages m
  where m.id = v_job.email_message_id and m.status = 'approved'::public.email_message_status
    and m.artist_id = v_job.artist_id and m.client_id = v_job.client_id
    and m.enquiry_id is not distinct from v_job.enquiry_id
    and m.project_id is not distinct from v_job.project_id
    and m.sent_at is null and m.provider_message_id is null;
  if not found then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;
  select lower(btrim(c.email)) into v_client_email from public.clients c
  where c.id = v_job.client_id;
  if nullif(v_client_email, '') is null
     or v_client_email is distinct from lower(btrim(v_message.to_email)) then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  if v_message.booking_card_id is not null then
    -- Booking card mail is system mail for a session, often without an
    -- enquiry. Its authority is the card and its single Email delivery.
    if v_message.payment_request_id is not null
       or v_message.gmail_thread_context_id is not null
       or v_message.automation_job_id is not null
       or v_message.created_by_kind is distinct from 'system'
       or coalesce(v_message.template_key, '') not in ('booking_card_tattoo', 'booking_card_consultation')
       or v_job.dedupe_key is distinct from 'email:booking_card:' || v_message.booking_card_id::text
       or crm_private.client_send_block_reason(
         v_job.client_id,
         'email'::public.message_template_channel,
         'service'::public.message_classification
       ) is not null then
      raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
    end if;

    select (b.superseded_at is null and crm_private.booking_group_card_valid(b.id)) into v_card_current
    from crm_private.booking_cards b
    join crm_private.booking_card_deliveries d
      on d.booking_card_id = b.id
     and d.channel = 'email'::public.message_template_channel
     and d.email_message_id = v_message.id
    where b.id = v_message.booking_card_id
      and b.artist_id = v_job.artist_id
      and b.client_id = v_job.client_id
      and b.enquiry_id is not distinct from v_job.enquiry_id
      and b.project_id is not distinct from v_job.project_id
      and b.session_id is not distinct from v_job.session_id;
    if not found then
      raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
    end if;

    return query
    select v_job.id, v_message.id, v_job.artist_id, v_job.enquiry_id, v_job.client_id,
      v_client_email, i.integration_key, lower(btrim(i.external_account_label)), coalesce(i.configuration, '{}'::jsonb) || jsonb_build_object('booking_card_reply_in_existing_thread', true),
      coalesce(v_card_current, false)
    from public.artist_integrations i
    join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
    where i.artist_id = v_job.artist_id and i.integration_type = 'email'::public.artist_integration_type
      and i.provider = 'google' and i.is_enabled
      and nullif(btrim(i.external_account_label), '') is not null;
    if not found then
      raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
    end if;
    return;
  end if;

  if v_message.payment_request_id is null then
    -- Existing enquiry/GPT routing remains authoritative for non-payment mail.
    return query
    select v_job.id, v_message.id, t.artist_id, t.enquiry_id, t.client_id,
      t.client_email, t.integration_key, t.mailbox_email, t.configuration - 'booking_card_reply_in_existing_thread',
      case when v_message.automation_job_id is null then true
           else crm_private.lifecycle_delivery_snapshot_current(v_message.id) end
    from public.service_resolve_gmail_target(v_job.artist_id, v_job.enquiry_id, v_job.client_id) t;
    return;
  end if;

  if v_job.enquiry_id is not null or v_message.gmail_thread_context_id is not null
     or v_message.created_by_kind is distinct from 'system' or v_message.automation_job_id is not null
     or coalesce(v_message.template_key, '') not in ('deposit_request', 'deposit_confirmation')
     or not exists (
       select 1 from public.payment_requests r
       join public.projects p on p.id = r.project_id
       where r.id = v_message.payment_request_id and r.purpose = 'deposit'
         and r.artist_id = v_job.artist_id and r.client_id = v_job.client_id
         and r.project_id = v_job.project_id
         and r.session_id is not distinct from v_job.session_id
         and p.artist_id = r.artist_id and p.client_id = r.client_id
     )
     or crm_private.client_send_block_reason(v_job.client_id, 'email', 'service') is not null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select v_job.id, v_message.id, v_job.artist_id, v_job.enquiry_id, v_job.client_id,
    v_client_email, i.integration_key, lower(btrim(i.external_account_label)), i.configuration - 'booking_card_reply_in_existing_thread',
    not crm_private.gmail_deposit_email_obsolete(v_message.id)
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.artist_id = v_job.artist_id and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google' and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null;
  if not found then
    raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
  end if;
end;
$function$;
