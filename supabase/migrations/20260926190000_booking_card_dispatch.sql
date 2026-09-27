-- 20260926190000_booking_card_dispatch.sql
--
-- Shared Email + WhatsApp booking-card dispatch.
--
-- Safety:
--   * channel flags default false, so applying this migration is inert;
--   * each delivery channel gets a two-action capability pair with shared semantics;
--   * Email and WhatsApp queue independently inside subtransactions;
--   * provider delivery remains in the existing durable outboxes/workers;
--   * dispatch failures never roll back appointment/payment state;
--   * superseded cards cancel queued client messages before provider claim;
--   * a bounded reconciliation helper can backfill current cards after rollout.

-- ---------------------------------------------------------------------------
-- 1. WhatsApp message/payload materialization
-- ---------------------------------------------------------------------------

create or replace function crm_private.create_booking_card_whatsapp(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client public.clients%rowtype;
  v_artist public.artists%rowtype;
  v_phone text;
  v_contact_wa_id text;
  v_integration_key text;
  v_integration_count integer;
  v_conversation public.communication_conversations%rowtype;
  v_conversation_id uuid;
  v_message_id uuid;
  v_template_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_body text;
  v_parameters jsonb;
  v_deposit text;
  v_remaining text;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('booking-card-whatsapp:' || p_booking_card_id::text, 0)
  );

  select p.communication_message_id
    into v_message_id
  from crm_private.booking_card_whatsapp_payloads p
  where p.booking_card_id = p_booking_card_id;

  if found then
    return v_message_id;
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return null;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id
    and s.whatsapp_enabled;

  if not found then
    return null;
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_card.client_id
    and c.archived_at is null;

  select a.* into v_artist
  from public.artists a
  where a.id = v_card.artist_id
    and a.is_active;

  if v_client.id is null or v_artist.id is null then
    return null;
  end if;

  if crm_private.client_send_block_reason(
    v_card.client_id,
    'whatsapp'::public.message_template_channel,
    'service'::public.message_classification
  ) is not null then
    return null;
  end if;

  v_phone := crm_private.normalize_whatsapp_phone(v_client.phone);
  if v_phone is null or v_phone !~ '^\+[0-9]{6,20}$' then
    return null;
  end if;
  v_contact_wa_id := substring(v_phone from 2);

  select count(*), min(i.integration_key)
    into v_integration_count, v_integration_key
  from public.artist_integrations i
  where i.artist_id = v_card.artist_id
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.provider = 'meta_cloud_api'
    and i.is_enabled;

  if v_integration_count <> 1 or v_integration_key is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_card.artist_id::text || ':whatsapp:' || v_contact_wa_id, 0)
  );

  select c.* into v_conversation
  from public.communication_conversations c
  where c.artist_id = v_card.artist_id
    and c.channel = 'whatsapp'::public.communication_channel
    and c.external_contact_id = v_contact_wa_id
  for update;

  if found then
    if v_conversation.state <> 'open'::public.communication_conversation_state
       or (v_conversation.client_id is not null
           and v_conversation.client_id <> v_card.client_id) then
      return null;
    end if;

    update public.communication_conversations c
    set client_id = coalesce(c.client_id, v_card.client_id),
        enquiry_id = coalesce(c.enquiry_id, v_card.enquiry_id),
        link_state = 'linked'::public.communication_link_state,
        integration_key = v_integration_key,
        updated_at = now()
    where c.id = v_conversation.id
    returning c.id into v_conversation_id;
  else
    insert into public.communication_conversations (
      artist_id,
      channel,
      integration_key,
      external_contact_id,
      client_id,
      enquiry_id,
      link_state,
      state
    ) values (
      v_card.artist_id,
      'whatsapp'::public.communication_channel,
      v_integration_key,
      v_contact_wa_id,
      v_card.client_id,
      v_card.enquiry_id,
      'linked'::public.communication_link_state,
      'open'::public.communication_conversation_state
    )
    returning id into v_conversation_id;
  end if;

  v_first_name := split_part(btrim(v_client.full_name), ' ', 1);
  if nullif(v_first_name, '') is null then
    return null;
  end if;

  v_date := to_char(
    v_card.start_at at time zone v_card.timezone,
    'FMDay, FMDD FMMonth YYYY'
  );
  v_time := to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_template_name := v_settings.whatsapp_tattoo_template_name;
    v_deposit := crm_private.booking_card_money(v_card.deposit_paid, v_card.currency);
    v_remaining := crm_private.booking_card_money(v_card.remaining_balance, v_card.currency);
    v_parameters := jsonb_build_array(
      v_first_name,
      v_artist.display_name,
      v_date,
      v_time,
      v_deposit,
      v_remaining
    );
    v_body :=
      'Your tattoo session is booked. '
      || 'Deposit paid: ' || v_deposit
      || '. Remaining balance: ' || v_remaining || '.';
  elsif v_card.card_kind = 'consultation_booked' then
    v_template_name := v_settings.whatsapp_consultation_template_name;
    v_parameters := jsonb_build_array(
      v_first_name,
      v_artist.display_name,
      v_date,
      v_time
    );
    v_body := 'Your consultation is booked.';
  else
    return null;
  end if;

  if v_template_name is null then
    return null;
  end if;

  insert into public.communication_messages (
    conversation_id,
    artist_id,
    channel,
    direction,
    origin,
    status,
    message_type,
    body,
    created_by
  ) values (
    v_conversation_id,
    v_card.artist_id,
    'whatsapp'::public.communication_channel,
    'outbound'::public.communication_direction,
    'automation'::public.communication_origin,
    'queued'::public.communication_status,
    'template',
    v_body,
    null
  )
  returning id into v_message_id;

  insert into crm_private.booking_card_whatsapp_payloads (
    booking_card_id,
    communication_message_id,
    template_name,
    template_language,
    body_parameters,
    location_name,
    location_address,
    location_latitude,
    location_longitude,
    confirm_payload,
    reschedule_payload
  ) values (
    v_card.id,
    v_message_id,
    v_template_name,
    v_settings.whatsapp_template_language,
    v_parameters,
    v_settings.studio_name,
    v_settings.studio_address,
    v_settings.location_latitude,
    v_settings.location_longitude,
    'booking_action:' || p_confirm_token,
    'booking_action:' || p_reschedule_token
  );

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now(),
      updated_at = now()
  where c.id = v_conversation_id;

  return v_message_id;
end;
$$;

revoke all on function crm_private.create_booking_card_whatsapp(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-channel queue helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.queue_booking_card_email(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_email_message_id uuid;
  v_outbox_id uuid;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return null;
  end if;

  select d.email_message_id
    into v_email_message_id
  from crm_private.booking_card_deliveries d
  where d.booking_card_id = v_card.id
    and d.channel = 'email'::public.message_template_channel;

  if found then
    return v_email_message_id;
  end if;

  v_email_message_id := crm_private.create_booking_card_email(
    v_card.id,
    p_confirm_token,
    p_reschedule_token
  );

  if v_email_message_id is null then
    return null;
  end if;

  v_outbox_id := crm_private.enqueue_outbox(
    'approved_email'::public.outbox_kind,
    'email:booking_card:' || v_card.id::text,
    jsonb_build_object('email_message_id', v_email_message_id),
    v_card.client_id,
    v_card.enquiry_id,
    v_card.project_id,
    v_card.session_id,
    v_email_message_id
  );

  -- NULL means the durable dedupe row already existed, which is still a
  -- successful idempotent queue outcome.
  insert into crm_private.booking_card_deliveries (
    booking_card_id,
    channel,
    status,
    email_message_id,
    queued_at
  ) values (
    v_card.id,
    'email'::public.message_template_channel,
    'queued',
    v_email_message_id,
    now()
  )
  on conflict (booking_card_id, channel) do nothing;

  return v_email_message_id;
end;
$$;

revoke all on function crm_private.queue_booking_card_email(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.queue_booking_card_whatsapp(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_message_id uuid;
  v_outbox_id uuid;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return null;
  end if;

  select d.communication_message_id
    into v_message_id
  from crm_private.booking_card_deliveries d
  where d.booking_card_id = v_card.id
    and d.channel = 'whatsapp'::public.message_template_channel;

  if found then
    return v_message_id;
  end if;

  v_message_id := crm_private.create_booking_card_whatsapp(
    v_card.id,
    p_confirm_token,
    p_reschedule_token
  );

  if v_message_id is null then
    return null;
  end if;

  insert into public.integration_outbox (
    kind,
    dedupe_key,
    payload,
    artist_id,
    client_id,
    enquiry_id,
    project_id,
    session_id,
    communication_message_id
  ) values (
    'whatsapp_message'::public.outbox_kind,
    'whatsapp:booking_card:' || v_card.id::text,
    jsonb_build_object('communication_message_id', v_message_id),
    v_card.artist_id,
    v_card.client_id,
    v_card.enquiry_id,
    v_card.project_id,
    v_card.session_id,
    v_message_id
  )
  on conflict (dedupe_key) do nothing
  returning id into v_outbox_id;

  insert into crm_private.booking_card_deliveries (
    booking_card_id,
    channel,
    status,
    communication_message_id,
    queued_at
  ) values (
    v_card.id,
    'whatsapp'::public.message_template_channel,
    'queued',
    v_message_id,
    now()
  )
  on conflict (booking_card_id, channel) do nothing;

  return v_message_id;
end;
$$;

revoke all on function crm_private.queue_booking_card_whatsapp(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Channel-scoped capability pairs, independent channel subtransactions
-- ---------------------------------------------------------------------------

create or replace function crm_private.dispatch_booking_card(p_booking_card_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_need_email boolean := false;
  v_need_whatsapp boolean := false;
  v_confirm_token text;
  v_reschedule_token text;
  v_message_id uuid;
  v_error_constraint text;
  v_error_table text;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null
  for update;

  if not found then
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id;

  if not found
     or (not v_settings.email_enabled and not v_settings.whatsapp_enabled)
     or (
       v_settings.appointment_start_from is not null
       and v_card.start_at < v_settings.appointment_start_from
     ) then
    return;
  end if;

  v_need_email := v_settings.email_enabled and not exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = v_card.id
      and d.channel = 'email'::public.message_template_channel
  );

  v_need_whatsapp := v_settings.whatsapp_enabled and not exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = v_card.id
      and d.channel = 'whatsapp'::public.message_template_channel
  );

  if not v_need_email and not v_need_whatsapp then
    return;
  end if;

  if v_need_email then
    begin
      select
        max(a.raw_token) filter (
          where a.action = 'confirm_attendance'::public.appointment_client_action
        ),
        max(a.raw_token) filter (
          where a.action = 'request_reschedule'::public.appointment_client_action
        )
      into v_confirm_token, v_reschedule_token
      from crm_private.issue_booking_card_client_actions(v_card.id) a;

      if v_confirm_token is null
         or v_reschedule_token is null
         or v_confirm_token !~ '^[0-9a-f]{64}$'
         or v_reschedule_token !~ '^[0-9a-f]{64}$'
         or v_confirm_token = v_reschedule_token then
        raise exception 'booking card Email action issuance failed'
          using errcode = '23514';
      end if;

      v_message_id := crm_private.queue_booking_card_email(
        v_card.id,
        v_confirm_token,
        v_reschedule_token
      );
      if v_message_id is null then
        -- Raising inside this exception block rolls back the just-issued token
        -- pair as well as any partial Email materialization.
        raise exception 'booking card Email channel is unavailable'
          using errcode = '23514';
      end if;
    exception when others then
      get stacked diagnostics v_error_constraint = constraint_name,
                              v_error_table = table_name;
      raise warning 'booking card Email queue failed, sqlstate=% constraint=% table=%',
        sqlstate, coalesce(v_error_constraint, '-'), coalesce(v_error_table, '-');
    end;
  end if;

  v_confirm_token := null;
  v_reschedule_token := null;
  v_message_id := null;

  if v_need_whatsapp then
    begin
      select
        max(a.raw_token) filter (
          where a.action = 'confirm_attendance'::public.appointment_client_action
        ),
        max(a.raw_token) filter (
          where a.action = 'request_reschedule'::public.appointment_client_action
        )
      into v_confirm_token, v_reschedule_token
      from crm_private.issue_booking_card_client_actions(v_card.id) a;

      if v_confirm_token is null
         or v_reschedule_token is null
         or v_confirm_token !~ '^[0-9a-f]{64}$'
         or v_reschedule_token !~ '^[0-9a-f]{64}$'
         or v_confirm_token = v_reschedule_token then
        raise exception 'booking card WhatsApp action issuance failed'
          using errcode = '23514';
      end if;

      v_message_id := crm_private.queue_booking_card_whatsapp(
        v_card.id,
        v_confirm_token,
        v_reschedule_token
      );
      if v_message_id is null then
        -- The subtransaction rollback keeps already queued Email links valid.
        raise exception 'booking card WhatsApp channel is unavailable'
          using errcode = '23514';
      end if;
    exception when others then
      get stacked diagnostics v_error_constraint = constraint_name,
                              v_error_table = table_name;
      raise warning 'booking card WhatsApp queue failed, sqlstate=% constraint=% table=%',
        sqlstate, coalesce(v_error_constraint, '-'), coalesce(v_error_table, '-');
    end;
  end if;
end;
$$;

revoke all on function crm_private.dispatch_booking_card(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.dispatch_booking_card_after_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  begin
    perform crm_private.dispatch_booking_card(new.id);
  exception when others then
    -- Card generation must never make appointment confirmation or a payment
    -- ledger transition fail. Reconciliation can safely retry later.
    raise warning 'booking card dispatch failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

revoke all on function crm_private.dispatch_booking_card_after_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_cards_dispatch_after_insert
  on crm_private.booking_cards;
create trigger booking_cards_dispatch_after_insert
after insert on crm_private.booking_cards
for each row execute function crm_private.dispatch_booking_card_after_insert();

-- ---------------------------------------------------------------------------
-- 4. Supersession closes queued messages before provider claim
-- ---------------------------------------------------------------------------

create or replace function crm_private.supersede_booking_card_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if old.superseded_at is null and new.superseded_at is not null then
    -- Capabilities from the superseded card must stop working immediately,
    -- even when the calendar version did not change (for example a price edit).
    update crm_private.appointment_client_action_tokens t
    set invalidated_at = now()
    where t.booking_card_id = new.id
      and t.consumed_at is null
      and t.invalidated_at is null;

    update crm_private.booking_card_deliveries d
    set status = 'superseded',
        updated_at = now()
    where d.booking_card_id = new.id
      and d.status in ('pending', 'queued');

    update public.email_messages m
    set status = 'cancelled'::public.email_message_status,
        updated_at = now()
    where m.booking_card_id = new.id
      and m.status in (
        'approved'::public.email_message_status,
        'queued'::public.email_message_status
      );

    update public.communication_messages m
    set status = 'failed'::public.communication_status,
        failed_at = coalesce(m.failed_at, now()),
        error_code = coalesce(m.error_code, 'booking_card_superseded'),
        updated_at = now()
    from crm_private.booking_card_whatsapp_payloads p
    where p.booking_card_id = new.id
      and p.communication_message_id = m.id
      and m.status = 'queued'::public.communication_status;
  end if;
  return new;
end;
$$;

revoke all on function crm_private.supersede_booking_card_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_cards_supersede_delivery
  on crm_private.booking_cards;
create trigger booking_cards_supersede_delivery
after update of superseded_at on crm_private.booking_cards
for each row execute function crm_private.supersede_booking_card_delivery();

-- ---------------------------------------------------------------------------
-- 5. Delivery readback from provider-owned message state
-- ---------------------------------------------------------------------------

create or replace function crm_private.sync_booking_card_email_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.booking_card_id is null then
    return new;
  end if;

  update crm_private.booking_card_deliveries d
  set status = case
        when new.status = 'sent'::public.email_message_status then 'sent'
        when new.status in (
          'failed'::public.email_message_status,
          'cancelled'::public.email_message_status
        ) then 'failed'
        else 'queued'
      end,
      sent_at = case
        when new.status = 'sent'::public.email_message_status
          then coalesce(new.sent_at, d.sent_at, now())
        else d.sent_at
      end,
      failed_at = case
        when new.status in (
          'failed'::public.email_message_status,
          'cancelled'::public.email_message_status
        ) then coalesce(new.failed_at, d.failed_at, now())
        else d.failed_at
      end,
      updated_at = now()
  where d.booking_card_id = new.booking_card_id
    and d.channel = 'email'::public.message_template_channel
    and d.status <> 'superseded';

  return new;
end;
$$;

revoke all on function crm_private.sync_booking_card_email_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists email_messages_sync_booking_card_delivery
  on public.email_messages;
create trigger email_messages_sync_booking_card_delivery
after update of status, sent_at, failed_at on public.email_messages
for each row execute function crm_private.sync_booking_card_email_delivery();

create or replace function crm_private.sync_booking_card_whatsapp_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  update crm_private.booking_card_deliveries d
  set status = case
        when new.status in (
          'sent'::public.communication_status,
          'delivered'::public.communication_status,
          'read'::public.communication_status
        ) then 'sent'
        when new.status = 'failed'::public.communication_status then 'failed'
        else 'queued'
      end,
      sent_at = case
        when new.status in (
          'sent'::public.communication_status,
          'delivered'::public.communication_status,
          'read'::public.communication_status
        ) then coalesce(new.sent_at, new.delivered_at, new.read_at, d.sent_at, now())
        else d.sent_at
      end,
      failed_at = case
        when new.status = 'failed'::public.communication_status
          then coalesce(new.failed_at, d.failed_at, now())
        else d.failed_at
      end,
      updated_at = now()
  from crm_private.booking_card_whatsapp_payloads p
  where p.communication_message_id = new.id
    and d.booking_card_id = p.booking_card_id
    and d.channel = 'whatsapp'::public.message_template_channel
    and d.status <> 'superseded';

  return new;
end;
$$;

revoke all on function crm_private.sync_booking_card_whatsapp_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_sync_booking_card_delivery
  on public.communication_messages;
create trigger communication_messages_sync_booking_card_delivery
after update of status, sent_at, delivered_at, read_at, failed_at
on public.communication_messages
for each row execute function crm_private.sync_booking_card_whatsapp_delivery();

-- ---------------------------------------------------------------------------
-- 6. Email claim: booking-card rows re-check current appointment version
-- ---------------------------------------------------------------------------

create or replace function public.claim_email_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  email_message_id uuid,
  client_id uuid,
  enquiry_id uuid,
  integration_key text,
  mailbox_email text,
  to_email text,
  subject text,
  body text,
  html_body text,
  thread_context_id uuid,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
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
$$;

revoke all on function public.claim_email_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_email_outbox(text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Bounded reconciliation/backfill after channel activation
-- ---------------------------------------------------------------------------

create or replace function crm_private.reconcile_booking_cards(
  p_artist_id uuid default null,
  p_limit integer default 200
)
returns table (
  sessions_seen integer,
  cards_current integer,
  deliveries_queued integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session_id uuid;
  v_card_id uuid;
  v_seen integer := 0;
  v_cards integer := 0;
  v_before integer;
  v_after integer;
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'booking card reconciliation limit is invalid'
      using errcode = '22023';
  end if;

  select count(*) into v_before
  from crm_private.booking_card_deliveries d
  join crm_private.booking_cards b on b.id = d.booking_card_id
  where (p_artist_id is null or b.artist_id = p_artist_id)
    and d.status in ('queued', 'sent');

  for v_session_id in
    select s.id
    from public.sessions s
    join public.artists a on a.id = s.artist_id and a.is_active
    where s.status = 'confirmed'::public.session_status
      and s.start_at > now()
      and s.appointment_type in (
        'tattoo_session'::public.appointment_type,
        'in_person_consultation'::public.appointment_type
      )
      and (p_artist_id is null or s.artist_id = p_artist_id)
    order by s.start_at, s.id
    limit p_limit
  loop
    v_seen := v_seen + 1;
    v_card_id := crm_private.sync_booking_card(v_session_id);
    if v_card_id is not null then
      v_cards := v_cards + 1;
      perform crm_private.dispatch_booking_card(v_card_id);
    end if;
  end loop;

  select count(*) into v_after
  from crm_private.booking_card_deliveries d
  join crm_private.booking_cards b on b.id = d.booking_card_id
  where (p_artist_id is null or b.artist_id = p_artist_id)
    and d.status in ('queued', 'sent');

  sessions_seen := v_seen;
  cards_current := v_cards;
  deliveries_queued := greatest(v_after - v_before, 0);
  return next;
end;
$$;

revoke all on function crm_private.reconcile_booking_cards(uuid, integer)
  from public, anon, authenticated, service_role;
