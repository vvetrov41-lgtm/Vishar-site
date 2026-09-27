-- Instagram is a full booking-card channel.
--
-- Single-channel routing is unchanged: the card goes to the client's newest
-- real conversation. When that conversation is on Instagram, the card goes to
-- Instagram only; there is never a fallback to Email or WhatsApp.
--
-- Transport is the existing Instagram connector: the card is an automated
-- outbound message in the client's existing Instagram conversation, queued in
-- integration_outbox as instagram_message and delivered by the shared
-- communications drain through sendInstagramMessage. The text is rendered from
-- the canonical card. The two actions are Instagram quick replies ("I'll be
-- there", "Need another time") whose payload is the same one-time appointment
-- capability as WhatsApp, applied through the existing canonical response
-- flow. Quick replies are not shown on desktop, so the text also carries the
-- same capability links as the Email card.
--
-- Meta only allows a standard message within 24 hours of the client's last
-- inbound message. Outside that window the card fails closed with
-- messaging_window_closed and is re-evaluated when the client writes again.

-- ---------------------------------------------------------------------------
-- 1. Settings, delivery and decision shapes
-- ---------------------------------------------------------------------------

alter table crm_private.booking_card_artist_settings
  add column if not exists instagram_enabled boolean not null default false;

alter table crm_private.booking_card_artist_settings
  drop constraint if exists booking_card_settings_instagram_ready;
alter table crm_private.booking_card_artist_settings
  add constraint booking_card_settings_instagram_ready check (
    not instagram_enabled
    or (
      client_action_base_url is not null
      and nullif(btrim(studio_name), '') is not null
      and nullif(btrim(studio_address), '') is not null
    )
  );

alter table crm_private.booking_card_deliveries
  drop constraint if exists booking_card_deliveries_channel_check;
alter table crm_private.booking_card_deliveries
  add constraint booking_card_deliveries_channel_check check (
    channel in (
      'email'::public.message_template_channel,
      'whatsapp'::public.message_template_channel,
      'instagram'::public.message_template_channel
    )
  );

alter table crm_private.booking_card_deliveries
  drop constraint if exists booking_card_delivery_target_shape;
alter table crm_private.booking_card_deliveries
  add constraint booking_card_delivery_target_shape check (
    (channel = 'email' and communication_message_id is null)
    or (channel in ('whatsapp', 'instagram') and email_message_id is null)
  );

alter table crm_private.booking_card_channel_decisions
  drop constraint if exists booking_card_channel_decisions_outcome_check;
alter table crm_private.booking_card_channel_decisions
  add constraint booking_card_channel_decisions_outcome_check check (
    outcome in (
      'selected',
      'no_conversation_channel',
      'conversation_channel_unsupported',
      'conversation_channel_disabled',
      'conversation_channel_unreachable',
      'messaging_window_closed',
      'delivery_unavailable'
    )
  );

alter table crm_private.booking_card_channel_decisions
  drop constraint if exists booking_card_channel_decision_supported;
alter table crm_private.booking_card_channel_decisions
  add constraint booking_card_channel_decision_supported check (
    outcome not in ('selected', 'delivery_unavailable')
    or channel in ('email', 'whatsapp', 'instagram')
  );

-- ---------------------------------------------------------------------------
-- 2. Instagram card payload: what the drain sends, never shown in the CRM
-- ---------------------------------------------------------------------------

create table crm_private.booking_card_instagram_payloads (
  booking_card_id uuid primary key
    references crm_private.booking_cards(id) on delete restrict,
  communication_message_id uuid not null unique
    references public.communication_messages(id) on delete restrict,
  message_text text not null
    check (char_length(message_text) between 1 and 1000),
  confirm_payload text not null
    check (confirm_payload ~ '^booking_action:[0-9a-f]{64}$'),
  reschedule_payload text not null
    check (reschedule_payload ~ '^booking_action:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint booking_card_instagram_payloads_distinct check (confirm_payload <> reschedule_payload)
);

alter table crm_private.booking_card_instagram_payloads enable row level security;
revoke all on crm_private.booking_card_instagram_payloads
  from public, anon, authenticated, service_role;

comment on table crm_private.booking_card_instagram_payloads is
  'Rendered Instagram booking card text and quick-reply capabilities. Read only by the backend drain; the CRM timeline shows the short message body instead.';

-- ---------------------------------------------------------------------------
-- 3. The client's current Instagram conversation and its messaging window
-- ---------------------------------------------------------------------------

create or replace function crm_private.booking_card_instagram_conversation(
  p_client_id uuid,
  p_artist_id uuid
)
returns public.communication_conversations
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select c.*
  from public.communication_conversations c
  join public.artist_integrations i
    on i.artist_id = c.artist_id
   and i.integration_type = 'instagram'::public.artist_integration_type
   and i.provider = 'instagram_login'
   and i.integration_key = c.integration_key
   and i.is_enabled
  where c.client_id = p_client_id
    and c.artist_id = p_artist_id
    and c.channel = 'instagram'::public.communication_channel
    and c.link_state = 'linked'::public.communication_link_state
  order by coalesce(c.last_inbound_at, c.last_message_at, c.created_at) desc nulls last, c.id
  limit 1;
$$;

revoke all on function crm_private.booking_card_instagram_conversation(uuid, uuid)
  from public, anon, authenticated, service_role;

-- A standard Instagram message is allowed for 24 hours after the client's last
-- message. Cards are held two minutes before sending, so keep a margin.
create or replace function crm_private.instagram_window_open(
  p_conversation public.communication_conversations
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select p_conversation.last_inbound_at is not null
    and p_conversation.last_inbound_at > now() - interval '24 hours' + interval '10 minutes';
$$;

revoke all on function crm_private.instagram_window_open(public.communication_conversations)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Channel resolution: Instagram is a supported channel
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_booking_card_channel(
  p_client_id uuid,
  p_artist_id uuid
)
returns table (
  channel text,
  outcome text,
  evidence_source text,
  evidence_conversation_id uuid,
  evidence_message_id uuid,
  evidence_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_evidence record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client public.clients%rowtype;
  v_conversation public.communication_conversations%rowtype;
  v_phone text;
begin
  select * into v_evidence
  from crm_private.booking_card_conversation_evidence(p_client_id, p_artist_id);

  if not found then
    return query select null::text, 'no_conversation_channel'::text,
      null::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  channel := v_evidence.channel;
  evidence_source := v_evidence.evidence_source;
  evidence_conversation_id := v_evidence.evidence_conversation_id;
  evidence_message_id := v_evidence.evidence_message_id;
  evidence_at := v_evidence.evidence_at;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = p_artist_id;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
    and c.archived_at is null;

  if v_evidence.channel = 'whatsapp' then
    if not coalesce(v_settings.whatsapp_enabled, false) then
      outcome := 'conversation_channel_disabled';
    else
      select c.* into v_conversation
      from public.communication_conversations c
      where c.id = v_evidence.evidence_conversation_id;

      v_phone := crm_private.normalize_whatsapp_phone(v_client.phone);

      -- The card must reach the same WhatsApp contact the conversation is
      -- with, never another number that merely sits on the client record.
      if v_client.id is null
         or v_phone is null
         or v_phone !~ '^\+[0-9]{6,20}$'
         or v_conversation.id is null
         or v_conversation.state <> 'open'::public.communication_conversation_state
         or v_conversation.external_contact_id is distinct from substring(v_phone from 2)
         or crm_private.client_send_block_reason(
           p_client_id,
           'whatsapp'::public.message_template_channel,
           'service'::public.message_classification
         ) is not null then
        outcome := 'conversation_channel_unreachable';
      else
        outcome := 'selected';
      end if;
    end if;
  elsif v_evidence.channel = 'email' then
    if not coalesce(v_settings.email_enabled, false) then
      outcome := 'conversation_channel_disabled';
    elsif v_client.id is null
       or nullif(lower(btrim(coalesce(v_client.email, ''))), '') is null
       or crm_private.client_send_block_reason(
         p_client_id,
         'email'::public.message_template_channel,
         'service'::public.message_classification
       ) is not null then
      outcome := 'conversation_channel_unreachable';
    else
      outcome := 'selected';
    end if;
  elsif v_evidence.channel = 'instagram' then
    if not coalesce(v_settings.instagram_enabled, false) then
      outcome := 'conversation_channel_disabled';
    else
      v_conversation := crm_private.booking_card_instagram_conversation(p_client_id, p_artist_id);
      if v_client.id is null
         or v_conversation.id is null
         or v_conversation.state <> 'open'::public.communication_conversation_state
         or crm_private.client_send_block_reason(
           p_client_id,
           'instagram'::public.message_template_channel,
           'service'::public.message_classification
         ) is not null then
        outcome := 'conversation_channel_unreachable';
      elsif not crm_private.instagram_window_open(v_conversation) then
        -- Never switched to another channel: it waits for the client to write.
        outcome := 'messaging_window_closed';
      else
        outcome := 'selected';
      end if;
    end if;
  else
    -- A future channel without a booking card transport.
    outcome := 'conversation_channel_unsupported';
  end if;

  return next;
end;
$$;

revoke all on function crm_private.resolve_booking_card_channel(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Materialise and queue an Instagram card in the existing conversation
-- ---------------------------------------------------------------------------

create or replace function crm_private.create_booking_card_instagram(
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
  v_conversation public.communication_conversations%rowtype;
  v_message_id uuid;
  v_first_name text;
  v_when text;
  v_place text;
  v_money text := '';
  v_headline text;
  v_body text;
  v_text text;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('booking-card-instagram:' || p_booking_card_id::text, 0)
  );

  select p.communication_message_id into v_message_id
  from crm_private.booking_card_instagram_payloads p
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
    and s.instagram_enabled;
  if not found then
    return null;
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = v_card.client_id and c.archived_at is null;
  select a.* into v_artist
  from public.artists a
  where a.id = v_card.artist_id and a.is_active;
  if v_client.id is null or v_artist.id is null then
    return null;
  end if;

  if crm_private.client_send_block_reason(
    v_card.client_id,
    'instagram'::public.message_template_channel,
    'service'::public.message_classification
  ) is not null then
    return null;
  end if;

  v_conversation := crm_private.booking_card_instagram_conversation(v_card.client_id, v_card.artist_id);
  if v_conversation.id is null
     or v_conversation.state <> 'open'::public.communication_conversation_state
     or not crm_private.instagram_window_open(v_conversation) then
    return null;
  end if;

  v_first_name := split_part(btrim(v_client.full_name), ' ', 1);
  if nullif(v_first_name, '') is null then
    return null;
  end if;

  v_when := to_char(v_card.start_at at time zone v_card.timezone, 'FMDay, FMDD FMMonth YYYY')
    || ' at ' || to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  v_place := btrim(v_settings.studio_name) || E'\n' || btrim(v_settings.studio_address)
    || case when nullif(btrim(coalesce(v_settings.studio_map_url, '')), '') is null
            then '' else E'\n' || btrim(v_settings.studio_map_url) end;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_headline := 'your tattoo session with ' || v_artist.display_name || ' is booked ✓';
    v_money := E'\n\nDeposit paid: '
      || crm_private.booking_card_money(v_card.deposit_paid, v_card.currency)
      || E'\nRemaining balance: '
      || crm_private.booking_card_money(v_card.remaining_balance, v_card.currency);
    v_body := 'Your tattoo session is booked. '
      || 'Deposit paid: ' || crm_private.booking_card_money(v_card.deposit_paid, v_card.currency)
      || '. Remaining balance: '
      || crm_private.booking_card_money(v_card.remaining_balance, v_card.currency) || '.';
  elsif v_card.card_kind = 'consultation_booked' then
    v_headline := 'your consultation with ' || v_artist.display_name || ' is booked ✓';
    v_body := 'Your consultation is booked.';
  else
    return null;
  end if;

  v_text := 'Hi ' || v_first_name || ', ' || v_headline
    || E'\n\n' || v_when
    || E'\n' || v_place
    || v_money
    || E'\n\nPlease confirm so I know to expect you: tap a button below, or use a link.'
    || E'\nI''ll be there: ' || v_settings.client_action_base_url || p_confirm_token
    || E'\nNeed another time: ' || v_settings.client_action_base_url || p_reschedule_token;

  if char_length(v_text) > 1000 then
    return null;
  end if;

  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status,
    message_type, body, created_by
  ) values (
    v_conversation.id, v_card.artist_id,
    'instagram'::public.communication_channel,
    'outbound'::public.communication_direction,
    'automation'::public.communication_origin,
    'queued'::public.communication_status,
    'booking_card', v_body, null
  )
  returning id into v_message_id;

  insert into crm_private.booking_card_instagram_payloads (
    booking_card_id, communication_message_id, message_text,
    confirm_payload, reschedule_payload
  ) values (
    v_card.id, v_message_id, v_text,
    'booking_action:' || p_confirm_token,
    'booking_action:' || p_reschedule_token
  );

  update public.communication_conversations c
  set last_message_at = now(),
      last_outbound_at = now(),
      updated_at = now()
  where c.id = v_conversation.id;

  return v_message_id;
end;
$$;

revoke all on function crm_private.create_booking_card_instagram(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.queue_booking_card_instagram(
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
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;
  if not found then
    return null;
  end if;

  select d.communication_message_id into v_message_id
  from crm_private.booking_card_deliveries d
  where d.booking_card_id = v_card.id
    and d.channel = 'instagram'::public.message_template_channel;
  if found then
    return v_message_id;
  end if;

  v_message_id := crm_private.create_booking_card_instagram(
    v_card.id, p_confirm_token, p_reschedule_token
  );
  if v_message_id is null then
    return null;
  end if;

  insert into public.integration_outbox (
    kind, dedupe_key, payload, artist_id, client_id, enquiry_id,
    project_id, session_id, communication_message_id
  ) values (
    'instagram_message'::public.outbox_kind,
    'instagram:booking_card:' || v_card.id::text,
    jsonb_build_object('communication_message_id', v_message_id),
    v_card.artist_id, v_card.client_id, v_card.enquiry_id, v_card.project_id,
    -- integration_outbox_communication_entity: message jobs carry no session.
    null,
    v_message_id
  )
  on conflict (dedupe_key) do nothing;

  insert into crm_private.booking_card_deliveries (
    booking_card_id, channel, status, communication_message_id, queued_at
  ) values (
    v_card.id, 'instagram'::public.message_template_channel, 'queued', v_message_id, now()
  )
  on conflict (booking_card_id, channel) do nothing;

  return v_message_id;
end;
$$;

revoke all on function crm_private.queue_booking_card_instagram(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Dispatch the one resolved channel, now including Instagram
-- ---------------------------------------------------------------------------

create or replace function crm_private.dispatch_booking_card_once(p_booking_card_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_choice record;
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
     or (not v_settings.email_enabled and not v_settings.whatsapp_enabled
         and not v_settings.instagram_enabled)
     or (
       v_settings.appointment_start_from is not null
       and v_card.start_at < v_settings.appointment_start_from
     )
     or (
       v_settings.appointment_created_from is not null
       and exists (
         select 1
         from public.sessions s
         where s.id = v_card.session_id
           and s.created_at < v_settings.appointment_created_from
       )
     ) then
    return;
  end if;

  -- The channel of a card is fixed by its first delivery. Retries and later
  -- conversations never add a sibling channel.
  if exists (
    select 1
    from crm_private.booking_card_deliveries d
    where d.booking_card_id = v_card.id
  ) then
    return;
  end if;

  select * into v_choice
  from crm_private.resolve_booking_card_channel(v_card.client_id, v_card.artist_id);

  insert into crm_private.booking_card_channel_decisions (
    booking_card_id,
    channel,
    outcome,
    evidence_source,
    evidence_conversation_id,
    evidence_message_id,
    evidence_at,
    decided_at
  ) values (
    v_card.id,
    v_choice.channel,
    v_choice.outcome,
    v_choice.evidence_source,
    v_choice.evidence_conversation_id,
    v_choice.evidence_message_id,
    v_choice.evidence_at,
    now()
  )
  on conflict (booking_card_id) do update
  set channel = excluded.channel,
      outcome = excluded.outcome,
      evidence_source = excluded.evidence_source,
      evidence_conversation_id = excluded.evidence_conversation_id,
      evidence_message_id = excluded.evidence_message_id,
      evidence_at = excluded.evidence_at,
      decided_at = excluded.decided_at;

  if v_choice.outcome <> 'selected' then
    return;
  end if;

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
      raise exception 'booking card action issuance failed'
        using errcode = '23514';
    end if;

    if v_choice.channel = 'email' then
      v_message_id := crm_private.queue_booking_card_email(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    elsif v_choice.channel = 'whatsapp' then
      v_message_id := crm_private.queue_booking_card_whatsapp(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    elsif v_choice.channel = 'instagram' then
      v_message_id := crm_private.queue_booking_card_instagram(
        v_card.id, v_confirm_token, v_reschedule_token
      );
    end if;

    if v_message_id is null then
      -- Rolls back the token pair and any partial message with it.
      raise exception 'booking card channel is unavailable'
        using errcode = '23514';
    end if;
  exception when others then
    get stacked diagnostics v_error_constraint = constraint_name,
                            v_error_table = table_name;
    raise warning 'booking card queue failed, channel=% sqlstate=% constraint=% table=%',
      v_choice.channel, sqlstate,
      coalesce(v_error_constraint, '-'), coalesce(v_error_table, '-');

    update crm_private.booking_card_channel_decisions x
    set outcome = 'delivery_unavailable',
        decided_at = now()
    where x.booking_card_id = v_card.id;
  end;
end;
$$;

revoke all on function crm_private.dispatch_booking_card_once(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. CRM status includes the Instagram switch
-- ---------------------------------------------------------------------------

create or replace function public.get_session_booking_card_status(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_client_id uuid;
  v_start_at timestamptz;
  v_finance boolean;
  v_facts record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_card crm_private.booking_cards%rowtype;
  v_deliveries jsonb;
  v_channels_on boolean;
  v_in_window boolean;
  v_channel record;
  v_channel_decided_at timestamptz;
begin
  if p_session_id is null then
    raise exception 'a session id is required' using errcode = '22023';
  end if;

  select s.artist_id, s.client_id, s.start_at into v_artist_id, v_client_id, v_start_at
  from public.sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'view_sessions');
  v_finance := public.can_view_artist_finance(v_artist_id);

  select * into v_facts from crm_private.booking_card_eligibility(p_session_id);

  select * into v_settings
  from crm_private.booking_card_artist_settings bs
  where bs.artist_id = v_artist_id;

  v_channels_on := found and (v_settings.email_enabled or v_settings.whatsapp_enabled
    or v_settings.instagram_enabled);
  v_in_window := v_settings.appointment_start_from is null
    or v_start_at >= v_settings.appointment_start_from;

  select * into v_card
  from crm_private.booking_cards b
  where b.session_id = p_session_id
    and b.superseded_at is null
  order by b.created_at desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', d.channel,
      'status', d.status,
      'skip_reason', d.skip_reason,
      'queued_at', d.queued_at,
      'sent_at', d.sent_at,
      'failed_at', d.failed_at
    ) order by d.channel), '[]'::jsonb)
    into v_deliveries
  from crm_private.booking_card_deliveries d
  where v_card.id is not null
    and d.booking_card_id = v_card.id;

  -- The recorded decision of the current card wins; before a card exists the
  -- same resolver previews what would happen now.
  select x.channel, x.outcome, x.evidence_source, x.evidence_at, x.decided_at
    into v_channel
  from crm_private.booking_card_channel_decisions x
  where v_card.id is not null
    and x.booking_card_id = v_card.id;

  if found then
    v_channel_decided_at := v_channel.decided_at;
  else
    select r.channel, r.outcome, r.evidence_source, r.evidence_at
      into v_channel
    from crm_private.resolve_booking_card_channel(v_client_id, v_artist_id) r;
  end if;

  return jsonb_build_object(
    'session_id', p_session_id,
    'eligible', coalesce(v_facts.eligible, false),
    'reason', v_facts.reason,
    'card_kind', v_facts.card_kind,
    'currency', v_facts.currency,
    'session_price', case when v_finance then v_facts.session_price end,
    'deposit_paid', case when v_finance then v_facts.deposit_paid end,
    'remaining_balance', case when v_finance then v_facts.remaining_balance end,
    'deposit_source', case when v_finance then v_facts.deposit_source end,
    'email_enabled', coalesce(v_settings.email_enabled, false),
    'whatsapp_enabled', coalesce(v_settings.whatsapp_enabled, false),
    'instagram_enabled', coalesce(v_settings.instagram_enabled, false),
    'channels_enabled', coalesce(v_channels_on, false),
    'in_rollout_window', coalesce(v_in_window, false),
    'rollout_starts_at', v_settings.appointment_start_from,
    'cards_for_appointments_booked_from', v_settings.appointment_created_from,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'revision', v_card.revision,
      'created_at', v_card.created_at,
      'card_kind', v_card.card_kind
    ) end,
    'channel', v_channel.channel,
    'channel_outcome', v_channel.outcome,
    'channel_evidence_source', v_channel.evidence_source,
    'channel_evidence_at', v_channel.evidence_at,
    'channel_decided_at', v_channel_decided_at,
    'deliveries', v_deliveries
  );
end;
$$;

revoke all on function public.get_session_booking_card_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_session_booking_card_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Supersession and delivery readback for Instagram cards
-- ---------------------------------------------------------------------------

create or replace function crm_private.supersede_booking_card_instagram_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if old.superseded_at is null and new.superseded_at is not null then
    update public.communication_messages m
    set status = 'failed'::public.communication_status,
        failed_at = coalesce(m.failed_at, now()),
        error_code = coalesce(m.error_code, 'booking_card_superseded'),
        updated_at = now()
    from crm_private.booking_card_instagram_payloads p
    where p.booking_card_id = new.id
      and p.communication_message_id = m.id
      and m.status = 'queued'::public.communication_status;
  end if;
  return new;
end;
$$;

revoke all on function crm_private.supersede_booking_card_instagram_message()
  from public, anon, authenticated, service_role;

drop trigger if exists booking_cards_supersede_instagram_message on crm_private.booking_cards;
create trigger booking_cards_supersede_instagram_message
after update of superseded_at on crm_private.booking_cards
for each row execute function crm_private.supersede_booking_card_instagram_message();

create or replace function crm_private.sync_booking_card_instagram_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  update crm_private.booking_card_deliveries d
  set status = case
        when new.status in ('sent'::public.communication_status,
                            'delivered'::public.communication_status,
                            'read'::public.communication_status) then 'sent'
        when new.status = 'failed'::public.communication_status then 'failed'
        else 'queued'
      end,
      sent_at = case
        when new.status in ('sent'::public.communication_status,
                            'delivered'::public.communication_status,
                            'read'::public.communication_status)
          then coalesce(new.sent_at, new.delivered_at, new.read_at, d.sent_at, now())
        else d.sent_at
      end,
      failed_at = case
        when new.status = 'failed'::public.communication_status
          then coalesce(new.failed_at, d.failed_at, now())
        else d.failed_at
      end,
      skip_reason = case
        when new.status = 'failed'::public.communication_status
         and new.error_code ~ '^[a-z][a-z0-9_]{2,63}$' then new.error_code
        else d.skip_reason
      end,
      updated_at = now()
  from crm_private.booking_card_instagram_payloads p
  where p.communication_message_id = new.id
    and d.booking_card_id = p.booking_card_id
    and d.channel = 'instagram'::public.message_template_channel
    and d.status <> 'superseded';
  return new;
end;
$$;

revoke all on function crm_private.sync_booking_card_instagram_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_sync_booking_card_instagram_delivery
  on public.communication_messages;
create trigger communication_messages_sync_booking_card_instagram_delivery
after update of status, sent_at, delivered_at, read_at, failed_at
on public.communication_messages
for each row
when (new.channel = 'instagram'::public.communication_channel)
execute function crm_private.sync_booking_card_instagram_delivery();

-- ---------------------------------------------------------------------------
-- 9. Drain: what to send for a leased Instagram job
-- ---------------------------------------------------------------------------

create or replace function public.service_resolve_instagram_booking_card_payload(
  p_outbox_id uuid,
  p_worker_id text
)
returns table (
  is_booking_card boolean,
  booking_card_id uuid,
  communication_message_id uuid,
  artist_id uuid,
  message_text text,
  confirm_payload text,
  reschedule_payload text,
  delivery_allowed boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
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
$$;

revoke all on function public.service_resolve_instagram_booking_card_payload(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_instagram_booking_card_payload(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 10. Quick replies enter the existing canonical response flow
-- ---------------------------------------------------------------------------

create or replace function public.service_apply_instagram_booking_card_action(
  p_artist_id uuid,
  p_integration_key text,
  p_external_contact_id text,
  p_provider_message_id text,
  p_provider_timestamp timestamptz,
  p_payload text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_token text;
  v_hash text;
  v_valid boolean;
  v_ingest jsonb;
  v_apply jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Instagram booking action is backend-only' using errcode = '42501';
  end if;

  if p_artist_id is null
     or coalesce(p_integration_key, '') !~ '^[a-z][a-z0-9_-]{2,79}$'
     or coalesce(p_external_contact_id, '') !~ '^[0-9]{5,40}$'
     or coalesce(p_provider_message_id, '') !~ '^[A-Za-z0-9_=./+-]{8,255}$'
     or p_provider_timestamp is null
     or p_provider_timestamp > now() + interval '5 minutes'
     or coalesce(p_payload, '') !~ '^booking_action:[0-9a-f]{64}$' then
    raise exception 'invalid Instagram booking action envelope' using errcode = '22023';
  end if;

  v_token := substring(p_payload from 16);
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  -- The capability must be the one this card sent to this Instagram contact.
  select true into v_valid
  from crm_private.appointment_client_action_tokens t
  join crm_private.booking_card_instagram_payloads p
    on p.booking_card_id = t.booking_card_id
   and (p.confirm_payload = p_payload or p.reschedule_payload = p_payload)
  join public.communication_messages m on m.id = p.communication_message_id
  join public.communication_conversations c on c.id = m.conversation_id
  join public.sessions s on s.id = t.session_id
  where t.token_hash = v_hash
    and t.consumed_at is null
    and t.invalidated_at is null
    and t.expires_at > now()
    and t.session_calendar_version = s.calendar_version
    and s.artist_id = p_artist_id
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and c.artist_id = p_artist_id
    and c.channel = 'instagram'::public.communication_channel
    and c.integration_key = p_integration_key
    and c.external_contact_id = p_external_contact_id;

  -- The button press is the client's message either way, recorded once.
  v_ingest := public.record_communication_inbound_message(
    p_artist_id, 'instagram', p_integration_key, p_external_contact_id,
    p_provider_message_id, p_provider_timestamp,
    case when nullif(btrim(coalesce(p_body, '')), '') is null then 'unsupported' else 'text' end,
    nullif(left(btrim(coalesce(p_body, '')), 4096), ''),
    '[]'::jsonb,
    null
  );

  if not coalesce(v_valid, false) then
    return jsonb_build_object('applied', false, 'reason', 'action_unavailable');
  end if;
  if coalesce((v_ingest ->> 'changed')::boolean, false) is false then
    return jsonb_build_object('applied', false, 'replayed', true, 'reason', 'provider_event_replayed');
  end if;

  v_apply := public.service_apply_appointment_client_action(v_token);
  return jsonb_build_object(
    'applied', true,
    'replayed', false,
    'action', v_apply ->> 'action',
    'outcome', v_apply ->> 'outcome'
  );
end;
$$;

revoke all on function public.service_apply_instagram_booking_card_action(uuid, text, text, text, timestamptz, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_apply_instagram_booking_card_action(uuid, text, text, text, timestamptz, text, text)
  to service_role;

comment on function public.service_apply_instagram_booking_card_action(uuid, text, text, text, timestamptz, text, text) is
  'Backend-only signed-webhook bridge for Instagram booking-card quick replies. Records the inbound message and applies the one-time appointment capability this card sent to this Instagram contact, atomically.';
