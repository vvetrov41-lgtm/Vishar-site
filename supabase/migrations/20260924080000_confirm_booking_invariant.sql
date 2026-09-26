-- 20260924080000_confirm_booking_invariant.sql
--
-- confirm_booking becomes a deterministic invariant instead of a prompt rule.
--
-- Before: attention_allowed_actions offered confirm_booking whenever the client
-- had NO future tattoo session, and withheld it once a session was proposed.
-- That is the opposite of the booking flow, and the only thing keeping the
-- model from recommending a premature confirmation was the v2 prompt.
--
-- After: confirm_booking is allowed only when authoritative CRM rows show all
-- of the following:
--   1. the client accepted a specific studio-offered date: a future tattoo or
--      touch-up session in status 'proposed' whose client_response is
--      'attendance_confirmed' for the current calendar_version (the response
--      is cleared by trigger on any schedule change, 0098);
--   2. the deposit requirement of that session's project is met: 'paid' or
--      'not_required' (a session without a project has no deposit fact, so it
--      never qualifies);
--   3. booking, session and project state agree: the project is open and not
--      archived, and neither past_session_unresolved nor
--      session_without_project is raised for the client.
--
-- With crm_agent_config.deterministic_state on (20260924045000), the existing
-- trigger client_ai_next_action_allowed supersedes any confirm_booking row
-- written outside this rule, whatever the model or prompt says.
--
-- Reachability: the only client-acceptance capability today (0098 tokens) is
-- issued for confirmed sessions only, so no proposed date can carry an
-- authoritative acceptance yet. confirm_booking is therefore withheld in every
-- production state until a proposed-date acceptance path exists. That is the
-- intended safety posture: a model reading "the 10th works" in chat is not an
-- authoritative acceptance. pgTAP 302 pins this fact.
--
-- No data changes: at release time production has no open confirm_booking
-- recommendation and no proposed future session.

create function crm_private.attention_confirm_booking_ready(p_artist_id uuid, p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.sessions s
    join public.projects p
      on p.id = s.project_id
     and p.artist_id = p_artist_id and p.client_id = p_client_id
    where s.artist_id = p_artist_id and s.client_id = p_client_id
      and s.cancelled_at is null
      and s.appointment_type in ('tattoo_session', 'touch_up')
      and s.status = 'proposed'
      and s.start_at > clock_timestamp()
      and s.client_response = 'attendance_confirmed'
      and s.client_response_calendar_version = s.calendar_version
      and p.archived_at is null
      and p.status in ('draft', 'active', 'on_hold')
      and p.deposit_status in ('paid', 'not_required')
  )
  and not exists (
    select 1 from public.sessions s
    where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
      and s.status in ('proposed', 'confirmed') and s.end_at < clock_timestamp() - interval '1 day')
  and not exists (
    select 1 from public.sessions s
    where s.artist_id = p_artist_id and s.client_id = p_client_id and s.cancelled_at is null
      and s.appointment_type = 'tattoo_session' and s.project_id is null
      and s.status in ('proposed', 'confirmed', 'completed'));
$$;

revoke all on function crm_private.attention_confirm_booking_ready(uuid, uuid) from public, anon, authenticated, service_role;

comment on function crm_private.attention_confirm_booking_ready(uuid, uuid) is
  'True only when the client accepted a specific proposed tattoo date (current calendar version), the session''s project deposit is paid or not required, and no booking-state conflict exists. The sole gate for confirm_booking in allowed_actions.';

-- The allowed-action rule takes the readiness fact explicitly. A caller that
-- does not supply it gets confirm_booking withheld (fail-closed default).
drop function crm_private.attention_allowed_actions(text, text, boolean, boolean, boolean);

create function crm_private.attention_allowed_actions(
  p_workflow_stage text,
  p_deposit_state text,
  p_has_future_tattoo_session boolean,
  p_has_future_consultation boolean,
  p_response_debt boolean,
  p_confirm_booking_ready boolean default false
)
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select array_agg(a order by ord)
  from unnest(array[
    'request_information', 'artist_review', 'prepare_quote', 'offer_dates',
    'request_deposit', 'confirm_booking', 'follow_up', 'await_client', 'no_action'
  ]) with ordinality as t(a, ord)
  where not (
    (a = 'request_information' and (p_has_future_tattoo_session or p_has_future_consultation
                                    or p_workflow_stage in ('booked', 'aftercare')))
    or (a = 'request_deposit' and p_deposit_state in ('paid', 'requested', 'not_required'))
    or (a = 'offer_dates' and p_has_future_tattoo_session)
    or (a = 'confirm_booking' and not coalesce(p_confirm_booking_ready, false))
    or (a = 'prepare_quote' and p_workflow_stage in ('booked', 'aftercare', 'deposit_pending', 'scheduling'))
    or (a = 'await_client' and p_response_debt)
  );
$$;

revoke all on function crm_private.attention_allowed_actions(text, text, boolean, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;

-- client_attention as in 20260924035000, with the readiness fact passed through
-- and exposed for readback. Every other key is unchanged.
create or replace function crm_private.client_attention(p_artist_id uuid, p_client_id uuid, p_now timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'client_id', p_client_id,
    'last_inbound_at', c.last_inbound_at,
    'last_inbound_source', c.last_inbound_source,
    'last_outbound_at', c.last_outbound_at,
    'last_speaker', c.last_speaker,
    'reply_state', c.reply_state,
    'reply_state_source', c.reply_state_source,
    'handled_at', c.handled_at,
    'response_debt_candidate', c.response_debt_candidate,
    'workflow_stage', s.workflow_stage,
    'enquiry_status', s.enquiry_status,
    'deposit_state', s.deposit_state,
    'has_future_tattoo_session', s.has_future_tattoo_session,
    'has_future_consultation', s.has_future_consultation,
    'next_session_at', s.next_session_at,
    'confirm_booking_ready', r.ready,
    'sla_state', l.sla_state,
    'sla_reason', l.sla_reason,
    'waiting_on_candidate', l.waiting_on_candidate,
    'age_hours', l.age_hours,
    'allowed_actions', to_jsonb(crm_private.attention_allowed_actions(
      s.workflow_stage, s.deposit_state, s.has_future_tattoo_session, s.has_future_consultation,
      c.response_debt_candidate and c.reply_state not in ('no_reply_needed', 'handled'),
      r.ready)),
    'conflicts', to_jsonb(crm_private.attention_conflicts(p_artist_id, p_client_id)),
    'has_valid_next_step', (
      s.workflow_stage in ('booked', 'dormant')
      or s.next_session_at is not null
      or exists (select 1 from public.client_ai_next_actions n
                 where n.artist_id = p_artist_id and n.client_id = p_client_id and n.status = 'open')
      or exists (select 1 from public.follow_ups f
                 where f.artist_id = p_artist_id and f.client_id = p_client_id and f.status = 'open')
    )
  )
  from crm_private.attention_comm_facts(p_artist_id, p_client_id) c,
       crm_private.attention_stage_facts(p_artist_id, p_client_id) s,
       (select crm_private.attention_confirm_booking_ready(p_artist_id, p_client_id) as ready) r,
       -- A handled message counts as the studio's turn, taken when it was handled.
       crm_private.attention_sla(
         case when c.reply_state = 'handled' then 'studio' else c.last_speaker end,
         c.reply_state, c.last_inbound_at,
         case when c.reply_state = 'handled' then greatest(c.last_outbound_at, c.handled_at) else c.last_outbound_at end,
         s.workflow_stage, coalesce(p_now, clock_timestamp())) l;
$$;

revoke all on function crm_private.client_attention(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
