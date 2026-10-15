-- Reject obsolete group snapshots at each provider's last pre-send boundary.
CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(outbox_id uuid, artist_id uuid, email_message_id uuid, client_id uuid, enquiry_id uuid, integration_key text, mailbox_email text, to_email text, subject text, body text, html_body text, thread_context_id uuid, attempt_count integer, max_attempts integer, job_valid boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_limit integer := coalesce(p_limit, 10);
  v_lease_seconds integer := coalesce(p_lease_seconds, 120);
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 20 or v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'invalid email claim bounds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind = 'approved_email'::public.outbox_kind
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ), leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id, l.artist_id, l.email_message_id, l.client_id, l.enquiry_id,
    i.integration_key, lower(btrim(i.external_account_label)),
    m.to_email, m.subject, m.body, m.html_body, m.gmail_thread_context_id,
    l.attempt_count, l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and m.client_id = l.client_id
      and m.status = 'approved'::public.email_message_status
      and lower(btrim(m.to_email)) = lower(btrim(cl.email))
      and i.id is not null
      and i.provider = 'google'
      and i.is_enabled
      and (
        m.booking_card_id is null
        or exists (
          select 1
          from crm_private.booking_cards bc
          join public.sessions s on s.id = bc.session_id
          where bc.id = m.booking_card_id
            and bc.superseded_at is null
            and crm_private.booking_group_card_valid(bc.id)
            and s.artist_id = bc.artist_id
            and s.client_id = bc.client_id
            and s.status = 'confirmed'::public.session_status
            and s.calendar_version = bc.calendar_version
            and s.start_at > now()
        )
      )
      and (m.gmail_thread_context_id is null or exists (
        select 1 from crm_private.gmail_thread_contexts gc
        where gc.id = m.gmail_thread_context_id
          and gc.artist_id = l.artist_id
          and gc.client_id = l.client_id
          and gc.enquiry_id = l.enquiry_id
      ))
    ) as job_valid
  from leased l
  left join public.email_messages m on m.id = l.email_message_id
  left join public.clients cl on cl.id = l.client_id
  left join public.artist_integrations i
    on i.artist_id = l.artist_id
   and i.integration_type = 'email'::public.artist_integration_type
   and i.provider = 'google'
   and i.is_enabled
  order by l.next_attempt_at, l.created_at, l.id;
end;
$function$;

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

CREATE OR REPLACE FUNCTION public.service_resolve_whatsapp_booking_card_payload(p_outbox_id uuid, p_worker_id text)
 RETURNS TABLE(is_booking_card boolean, booking_card_id uuid, communication_message_id uuid, artist_id uuid, template_name text, template_language text, body_parameters jsonb, location_name text, location_address text, location_latitude numeric, location_longitude numeric, confirm_payload text, reschedule_payload text, delivery_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp booking card resolution is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null
     or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'valid WhatsApp lease identity is required'
      using errcode = '22023';
  end if;

  return query
  select
    m.message_type = 'template' as is_booking_card,
    p.booking_card_id,
    m.id,
    o.artist_id,
    p.template_name,
    p.template_language,
    p.body_parameters,
    p.location_name,
    p.location_address,
    p.location_latitude,
    p.location_longitude,
    p.confirm_payload,
    p.reschedule_payload,
    case
      when m.message_type <> 'template' then true
      else (
        p.booking_card_id is not null
        and b.superseded_at is null
        and crm_private.booking_group_card_valid(b.id)
        and b.artist_id = o.artist_id
        and b.client_id is not distinct from o.client_id
        and s.status = 'confirmed'::public.session_status
        and s.calendar_version = b.calendar_version
        and s.start_at > now()
        and m.status = 'queued'::public.communication_status
        and settings.whatsapp_enabled
        and settings.whatsapp_template_language = p.template_language
        and (
          (b.card_kind = 'tattoo_deposit_paid'
            and settings.whatsapp_tattoo_template_name = p.template_name)
          or
          (b.card_kind = 'consultation_booked'
            and settings.whatsapp_consultation_template_name = p.template_name)
        )
      )
    end as delivery_allowed
  from public.integration_outbox o
  join public.communication_messages m
    on m.id = o.communication_message_id
  left join crm_private.booking_card_whatsapp_payloads p
    on p.communication_message_id = m.id
  left join crm_private.booking_cards b
    on b.id = p.booking_card_id
  left join public.sessions s
    on s.id = b.session_id
  left join crm_private.booking_card_artist_settings settings
    on settings.artist_id = b.artist_id
  where o.id = p_outbox_id
    and o.kind = 'whatsapp_message'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status
    and o.leased_by = p_worker_id
    and o.lease_expires_at > now()
    and m.artist_id = o.artist_id
    and m.channel = 'whatsapp'::public.communication_channel;
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_instagram_booking_card_payload(p_outbox_id uuid, p_worker_id text)
 RETURNS TABLE(is_booking_card boolean, booking_card_id uuid, communication_message_id uuid, artist_id uuid, message_text text, confirm_payload text, reschedule_payload text, delivery_allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram booking card resolution is backend-only' using errcode = '42501';
  end if;
  if p_outbox_id is null or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'valid Instagram lease identity is required' using errcode = '22023';
  end if;

  return query
  select
    p.booking_card_id is not null,
    p.booking_card_id,
    m.id,
    o.artist_id,
    p.message_text,
    p.confirm_payload,
    p.reschedule_payload,
    case
      when p.booking_card_id is null then true
      else (
        b.superseded_at is null
        and crm_private.booking_group_card_valid(b.id)
        and b.artist_id = o.artist_id
        and b.client_id is not distinct from o.client_id
        and s.status = 'confirmed'::public.session_status
        and s.calendar_version = b.calendar_version
        and s.start_at > now()
        and m.status = 'queued'::public.communication_status
        and coalesce(settings.instagram_enabled, false)
      )
    end
  from public.integration_outbox o
  join public.communication_messages m on m.id = o.communication_message_id
  left join crm_private.booking_card_instagram_payloads p on p.communication_message_id = m.id
  left join crm_private.booking_cards b on b.id = p.booking_card_id
  left join public.sessions s on s.id = b.session_id
  left join crm_private.booking_card_artist_settings settings on settings.artist_id = b.artist_id
  where o.id = p_outbox_id
    and o.kind = 'instagram_message'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status
    and o.leased_by = p_worker_id
    and o.lease_expires_at > now()
    and m.artist_id = o.artist_id
    and m.channel = 'instagram'::public.communication_channel;
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.guard_booking_card_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_expected_template text;
begin
  if new.booking_card_id is null then
    return new;
  end if;

  if new.created_by_kind <> 'system'
     or new.created_by is not null
     or new.approved_by is not null
     or new.automation_job_id is not null
     or new.payment_request_id is not null then
    raise exception 'booking card email provenance must be system-only'
      using errcode = '23514';
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = new.booking_card_id;

  if not found then
    raise exception 'booking card email has no canonical card'
      using errcode = '23503';
  end if;

  v_expected_template := case v_card.card_kind
    when 'tattoo_deposit_paid' then 'booking_card_tattoo'
    when 'consultation_booked' then 'booking_card_consultation'
    else null
  end;

  if v_expected_template is null
     or new.template_key is distinct from v_expected_template
     or new.artist_id is distinct from v_card.artist_id
     or new.client_id is distinct from v_card.client_id
     or new.enquiry_id is distinct from v_card.enquiry_id
     or new.project_id is distinct from v_card.project_id
     or new.gmail_thread_context_id is not null then
    raise exception 'booking card email links do not match canonical facts'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if v_card.superseded_at is not null
       or not crm_private.booking_group_card_valid(v_card.id)
       or not exists (
         select 1
         from public.sessions s
         where s.id = v_card.session_id
           and s.artist_id = v_card.artist_id
           and s.client_id = v_card.client_id
           and s.status = 'confirmed'::public.session_status
           and s.calendar_version = v_card.calendar_version
           and s.start_at > now()
       ) then
      raise exception 'booking card email is obsolete'
        using errcode = '23514';
    end if;
  else
    if new.booking_card_id is distinct from old.booking_card_id
       or new.artist_id is distinct from old.artist_id
       or new.client_id is distinct from old.client_id
       or new.enquiry_id is distinct from old.enquiry_id
       or new.project_id is distinct from old.project_id
       or new.to_email is distinct from old.to_email
       or new.subject is distinct from old.subject
       or new.body is distinct from old.body
       or new.html_body is distinct from old.html_body
       or new.template_key is distinct from old.template_key
       or new.template_version is distinct from old.template_version
       or new.created_by_kind is distinct from old.created_by_kind
       or new.created_by is distinct from old.created_by
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'booking card email content and provenance are immutable'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;
