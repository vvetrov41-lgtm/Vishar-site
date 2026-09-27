-- 20260926160000_booking_card_client_actions.sql
--
-- Each booking-card delivery channel gets its own two-action capability pair.
-- The existing branded action endpoint remains authoritative: GET resolves only
-- and POST mutates. A successful response invalidates every remaining sibling
-- capability for the session/version, so Email and WhatsApp cannot contradict
-- one another. Booking cards deliberately never mint a cancel capability.

alter table crm_private.appointment_client_action_tokens
  add column if not exists booking_card_id uuid
    references crm_private.booking_cards(id) on delete cascade;

create index if not exists appointment_client_action_tokens_booking_card_idx
  on crm_private.appointment_client_action_tokens(booking_card_id)
  where booking_card_id is not null
    and consumed_at is null
    and invalidated_at is null;

-- Lifecycle reminders keep "one live capability per session and action".
-- Booking cards deliberately issue one pair per delivery channel (spec), so
-- their capabilities are outside that rule; the per-channel delivery row and
-- sibling invalidation on first response bound them instead.
drop index if exists crm_private.appointment_client_action_one_live_per_action_idx;
create unique index appointment_client_action_one_live_per_action_idx
  on crm_private.appointment_client_action_tokens (session_id, action)
  where consumed_at is null
    and invalidated_at is null
    and booking_card_id is null;

comment on column crm_private.appointment_client_action_tokens.booking_card_id is
  'Present only for capabilities minted by a canonical booking card. Lifecycle reminder capabilities remain NULL.';

create or replace function crm_private.issue_booking_card_client_actions(
  p_booking_card_id uuid
)
returns table (
  action public.appointment_client_action,
  raw_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_card crm_private.booking_cards%rowtype;
  v_status public.session_status;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_action public.appointment_client_action;
  v_raw text;
  v_expiry timestamptz;
begin
  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    raise exception 'booking card is not eligible for client actions'
      using errcode = '42501';
  end if;

  select s.status, s.start_at, s.calendar_version
    into v_status, v_start_at, v_calendar_version
  from public.sessions s
  join crm_private.artist_state st
    on st.artist_id = s.artist_id
   and st.is_active
  where s.id = v_card.session_id
    and s.artist_id = v_card.artist_id
    and s.client_id = v_card.client_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now()
     or v_calendar_version <> v_card.calendar_version then
    raise exception 'booking card is not eligible for client actions'
      using errcode = '42501';
  end if;

  -- Booking-card links are intentionally short-lived even when the appointment
  -- is months away. A later lifecycle reminder can issue a fresh set.
  v_expiry := least(v_start_at, now() + interval '7 days');

  -- Do not invalidate an already queued sibling channel here. If Email queued
  -- successfully and WhatsApp becomes reachable later, WhatsApp must be able
  -- to mint its own pair without breaking the Email buttons already delivered.
  -- service_apply_appointment_client_action invalidates every remaining live
  -- sibling after the first successful response.
  foreach v_action in array array[
    'confirm_attendance'::public.appointment_client_action,
    'request_reschedule'::public.appointment_client_action
  ]
  loop
    v_raw := encode(extensions.gen_random_bytes(32), 'hex');

    insert into crm_private.appointment_client_action_tokens (
      session_id,
      action,
      token_hash,
      session_calendar_version,
      expires_at,
      booking_card_id
    ) values (
      v_card.session_id,
      v_action,
      encode(extensions.digest(v_raw, 'sha256'), 'hex'),
      v_calendar_version,
      v_expiry,
      v_card.id
    );

    action := v_action;
    raw_token := v_raw;
    expires_at := v_expiry;
    return next;
  end loop;
end;
$$;

revoke all on function crm_private.issue_booking_card_client_actions(uuid)
  from public, anon, authenticated, service_role;
