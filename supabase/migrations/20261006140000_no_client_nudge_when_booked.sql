-- No "client went quiet" nudge while a confirmed appointment is ahead.
--
-- Production readback after rc1029: Mark Abramov (confirmed consultation
-- 2026-11-08) moved from a false "reply owed" to client_cold, and Barry Mehew
-- and Michael Parker (confirmed consultations 2026-11-06) to
-- client_follow_up_due. Once the studio's turn is recognised (booking
-- evidence, or the operator clearing the Today item), attention_sla counted
-- days since that turn as the client going silent, because only a future
-- tattoo session made the stage 'booked'. A confirmed consultation is just as
-- much an agreed next step. The SLA now treats any confirmed, live future
-- appointment as booked for the waiting-on-client clock; the workflow stage
-- shown and the allowed actions are unchanged, and a proposed appointment
-- still waits on the client.

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
         -- A confirmed appointment still ahead is the agreed next step: the
         -- studio is not waiting on the client, so no follow-up or "went
         -- quiet" nudge (20261006140000). A proposed one still waits on the
         -- client's confirmation.
         case when exists (
                select 1 from public.sessions fs
                where fs.artist_id = p_artist_id and fs.client_id = p_client_id
                  and fs.status = 'confirmed' and fs.cancelled_at is null
                  and fs.end_at >= coalesce(p_now, clock_timestamp()))
              and s.workflow_stage not in ('booked', 'aftercare', 'dormant')
           then 'booked' else s.workflow_stage end,
         coalesce(p_now, clock_timestamp())) l;
$$;

revoke all on function crm_private.client_attention(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
