-- Server-proven reply policy. All existing routing and lease checks remain.
create or replace function public.service_resolve_gmail_outbox_target(
  p_outbox_id uuid,
  p_worker_id text
)
returns table(
  outbox_id uuid,
  email_message_id uuid,
  artist_id uuid,
  enquiry_id uuid,
  client_id uuid,
  client_email text,
  integration_key text,
  mailbox_email text,
  configuration jsonb,
  delivery_allowed boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
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

    select b.superseded_at is null into v_card_current
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
      t.client_email, t.integration_key, t.mailbox_email, t.configuration - 'booking_card_reply_in_existing_thread', true
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

revoke all on function public.service_resolve_gmail_outbox_target(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_gmail_outbox_target(uuid, text)
  to service_role;
