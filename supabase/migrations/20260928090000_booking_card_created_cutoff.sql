-- Booking cards are for appointments booked after cards were switched on.
--
-- The activation cutoff is the booking time (sessions.created_at), not only
-- the appointment date: an appointment booked before activation never gets a
-- card retroactively, even when its price or deposit is recorded later.
-- Saving a real sessions.price on such a legacy appointment is safe and sends
-- nothing. Appointments booked after the cutoff work automatically.
--
-- Cards went live with the private release that finished at
-- 2026-09-27 05:00:32 UTC (release/private-crm-rc923).

alter table crm_private.booking_card_artist_settings
  add column if not exists appointment_created_from timestamptz;

comment on column crm_private.booking_card_artist_settings.appointment_created_from is
  'Only appointments booked (sessions.created_at) at or after this time get booking cards.';

update crm_private.booking_card_artist_settings
set appointment_created_from = '2026-09-27T05:00:00Z',
    updated_at = now()
where appointment_created_from is null;

create or replace function crm_private.booking_card_eligibility(p_session_id uuid)
returns table (
  eligible boolean,
  reason text,
  card_kind text,
  session_price numeric,
  deposit_paid numeric,
  remaining_balance numeric,
  currency text,
  deposit_source text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session record;
  v_deposit numeric;
  v_deposit_currency text;
  v_deposit_source text;
begin
  select s.appointment_type, s.status, s.start_at, s.price, s.currency, s.created_at,
         a.is_active as artist_active, a.timezone, c.archived_at as client_archived_at,
         bs.appointment_created_from
    into v_session
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join public.clients c on c.id = s.client_id
  left join crm_private.booking_card_artist_settings bs on bs.artist_id = s.artist_id
  where s.id = p_session_id;

  if not found then
    return query select false, 'session_not_found', null::text, null::numeric,
      null::numeric, null::numeric, null::text, null::text;
    return;
  end if;

  currency := v_session.currency;
  eligible := false;

  if not v_session.artist_active then
    reason := 'artist_inactive';
  elsif v_session.client_archived_at is not null then
    reason := 'client_archived';
  elsif v_session.status <> 'confirmed'::public.session_status then
    reason := 'not_confirmed';
  elsif v_session.start_at <= clock_timestamp() then
    reason := 'appointment_in_past';
  elsif v_session.appointment_created_from is not null
     and v_session.created_at < v_session.appointment_created_from then
    reason := 'appointment_before_activation';
  elsif nullif(btrim(coalesce(v_session.timezone, '')), '') is null then
    reason := 'artist_timezone_missing';
  elsif v_session.appointment_type = 'in_person_consultation'::public.appointment_type then
    eligible := true;
    reason := 'ready';
    card_kind := 'consultation_booked';
  elsif v_session.appointment_type <> 'tattoo_session'::public.appointment_type then
    reason := 'appointment_type_without_card';
  elsif v_session.price is null or v_session.price <= 0 then
    reason := 'session_price_missing';
  else
    session_price := v_session.price;

    select d.amount, d.currency, d.source_kind
      into v_deposit, v_deposit_currency, v_deposit_source
    from crm_private.booking_card_deposit_for_session(p_session_id) d;

    if not found or v_deposit is null or v_deposit <= 0 then
      reason := 'deposit_not_paid_for_session';
    elsif v_deposit_currency is distinct from v_session.currency then
      reason := 'deposit_currency_mismatch';
    elsif v_deposit > v_session.price then
      reason := 'deposit_exceeds_price';
      deposit_paid := v_deposit;
    else
      eligible := true;
      reason := 'ready';
      card_kind := 'tattoo_deposit_paid';
      deposit_paid := v_deposit;
      remaining_balance := v_session.price - v_deposit;
      deposit_source := v_deposit_source;
    end if;
  end if;

  return next;
end;
$$;

revoke all on function crm_private.booking_card_eligibility(uuid)
  from public, anon, authenticated, service_role;

-- Dispatch re-checks the booking-time cutoff, so a card can never leave for a
-- legacy appointment even if one exists.

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
     or (not v_settings.email_enabled and not v_settings.whatsapp_enabled)
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
    else
      v_message_id := crm_private.queue_booking_card_whatsapp(
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

-- Status: expose the booking-time cutoff next to the appointment-date window.

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

  v_channels_on := found and (v_settings.email_enabled or v_settings.whatsapp_enabled);
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
