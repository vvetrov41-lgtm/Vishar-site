-- Hide settled Monzo reconciliation evidence already linked to a manual invoice receipt.
-- Preserve immutable payment_transactions and the candidate-to-receipt audit link.
-- The sole change is within the Today 'payment_to_confirm' predicate.
-- Source: the current production crm_private.pulse_items definition (2026-11-03).
CREATE OR REPLACE FUNCTION crm_private.pulse_items(p_artist_id uuid, p_include_finance boolean, p_include_integrations boolean, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at, a.resurface_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as materialized (
    select * from crm_private.pulse_attention_batch(p_artist_id, (select t from now_))
  ),
  live_sessions as (
    select s.* from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null
      and s.status in ('draft', 'proposed', 'confirmed')
  ),
  conv as (
    select c.*, crm_private.conversation_awaiting_reply_since(c.id) as awaiting_since
    from public.communication_conversations c
    where c.artist_id = p_artist_id and c.state = 'open'
  ),
  -- Email grouped the way the Inbox groups it: one row per real conversation.
  email_threads as (
    select
      case when m.enquiry_id is not null then 'enquiry-' || m.enquiry_id
           when m.client_id is not null then 'client-' || m.client_id
           else 'message-' || m.id end as thread_key,
      m.*
    from public.email_messages m
    where m.artist_id = p_artist_id
  ),
  email_thread_state as (
    select t.thread_key,
      bool_or(t.status = 'failed') as send_failed,
      bool_or(t.status = 'draft' and t.created_by_kind = 'human') as awaiting_approval,
      max(t.created_at) as last_activity_at,
      (array_agg(t.subject order by t.created_at desc, t.id desc))[1] as subject,
      (array_agg(t.client_id order by t.created_at desc, t.id desc))[1] as client_id,
      (array_agg(t.to_email order by t.created_at desc, t.id desc))[1] as to_email
    from email_threads t
    where t.thread_key not like 'message-%'
    group by t.thread_key
  ),
  -- Manual follow-ups by the client they concern: directly, or through the
  -- enquiry or project they were created on.
  client_follow_ups as (
    select coalesce(f.client_id, e.client_id, p.client_id) as client_id, f.status,
           coalesce(f.completed_at, f.cancelled_at) as closed_at
    from public.follow_ups f
    left join public.enquiries e on e.id = f.enquiry_id
    left join public.projects p on p.id = f.project_id
    where f.artist_id = p_artist_id
  ),
  raw as (
    -- A client asking to move a booked time.
    select 'reschedule_requested'::text as kind, 'reschedule-' || s.id as key, s.client_id,
           null::text as subject, '/appointments/' || s.id as href, s.start_at as at, null::text as detail,
           'client_asked_to_reschedule'::text as reason, null::jsonb as ack
    from live_sessions s
    where s.client_response = 'reschedule_requested' and s.start_at >= (select t from now_)

    union all
    -- Linked conversation whose newest actionable inbound the studio has
    -- not answered (crm_private.conversation_awaiting_reply_since).
    select 'reply', 'reply-' || c.id, c.client_id,
           coalesce(c.external_display_label, c.external_username),
           '/inbox/' || c.id, c.awaiting_since, c.channel::text,
           'client_message_unanswered',
           jsonb_build_object('kind', 'conversation_reply', 'entity_id', c.id, 'observed_at', c.awaiting_since)
    from conv c
    where c.awaiting_since is not null
      and (c.client_id is not null or c.enquiry_id is not null)

    union all
    -- A known client whose newest Gmail message is inbound.
    select 'reply', 'gmail-' || g.client_id, g.client_id, null,
           '/inbox/email/client-' || g.client_id, g.last_message_at, left(g.subject, 120),
           'client_email_unanswered',
           case when g.last_message_at is not null then
             jsonb_build_object('kind', 'gmail_reply', 'entity_id', g.client_id, 'observed_at', g.last_message_at)
           end
    from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id and g.direction = 'inbound'

    union all
    -- Email the CRM failed to send or a person drafted and nobody approved.
    select case when e.send_failed then 'email_send_failed' else 'email_draft_to_approve' end,
           'email-' || e.thread_key, e.client_id, left(e.to_email, 120),
           '/inbox/email/' || e.thread_key, e.last_activity_at, left(e.subject, 120),
           case when e.send_failed then 'email_not_delivered' else 'email_awaiting_approval' end, null
    from email_thread_state e
    where e.send_failed or e.awaiting_approval

    union all
    -- Contradictory authoritative facts (Phase 2 detectors).
    select 'conflict', 'conflict-' || at.client_id || '-' || code, at.client_id, null,
           '/clients/' || at.client_id, null, code, code, null
    from att at, jsonb_array_elements_text(at.a -> 'conflicts') code
    where code <> 'ai_brief_stale'

    union all
    -- Money that landed and only needs agreeing with.
    select 'payment_to_confirm', 'payment-' || r.id, pr.client_id, null, '/payments', r.occurred_at,
           r.amount::text || ' ' || r.currency, 'payment_received_unconfirmed', null
    from public.payment_reconciliation_candidates r
    join public.payment_requests pr
      on pr.id = coalesce(r.matched_payment_request_id, r.suggested_payment_request_id)
    where p_include_finance and r.artist_id = p_artist_id
      and r.provider = 'monzo_easy_bank_transfer'
      and r.status in ('matched', 'candidate')
      -- A verified bank transfer can be linked to an already-booked manual receipt.
      -- Such evidence is settled, not an outstanding action, and must not be counted twice.
      and not exists (select 1 from public.monzo_recorded_receipt_links l
                      where l.candidate_id = r.id and l.artist_id = r.artist_id)
      and not exists (select 1 from public.payment_transactions t
                      where t.provider = r.provider and t.provider_transaction_id = r.provider_transaction_id
                        and t.status = 'succeeded')

    union all
    -- A proposed appointment nobody confirmed.
    select 'unconfirmed_appointment', 'unconfirmed-' || s.id, s.client_id, null, '/appointments/' || s.id,
           s.start_at, null, 'appointment_not_confirmed', null
    from live_sessions s
    where s.status in ('draft', 'proposed') and s.start_at >= (select t from now_)

    union all
    -- A booked session whose deposit is outstanding. A merely requested
    -- deposit waits until the session is within the week ahead.
    select 'deposit_outstanding', 'deposit-' || p.id, p.client_id, null, '/projects/' || p.id, nxt.start_at,
           p.deposit_status::text, 'deposit_not_received_for_booking',
           jsonb_build_object('kind', 'deposit_outstanding', 'entity_id', p.id, 'observed_at', p.updated_at)
    from public.projects p
    join lateral (
      select min(s.start_at) as start_at from live_sessions s
      where s.project_id = p.id and s.start_at >= (select t from now_)
    ) nxt on nxt.start_at is not null
    where p.artist_id = p_artist_id
      and p.deposit_status not in ('paid', 'not_required')
      and (p.deposit_status <> 'requested' or nxt.start_at < (select t from now_) + interval '8 days')

    union all
    -- A new enquiry the artist has not answered yet. A person's unsent draft
    -- or a failed send for it is already its own item above.
    select 'new_enquiry', 'enquiry-' || e.id, e.client_id, null, '/enquiries/' || e.id, e.created_at,
           e.project_type, 'new_enquiry_untouched',
           jsonb_build_object('kind', 'new_enquiry', 'entity_id', e.id, 'observed_at', e.created_at)
    from public.enquiries e
    where e.artist_id = p_artist_id and e.archived_at is null and e.status = 'new'
      and e.intake_state = 'complete'
      and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
      and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
      and not crm_private.enquiry_has_artist_reply(e.id, (select t from now_))
      and not exists (select 1 from email_threads m
                      where m.thread_key in ('enquiry-' || e.id, 'client-' || e.client_id)
                        and m.created_at >= e.created_at
                        and ((m.status = 'draft' and m.created_by_kind = 'human') or m.status = 'failed'))

    union all
    -- Messages from somebody the CRM cannot name yet, as one row. Deciding
    -- who they are is Inbox work; Today only says how many wait. A
    -- personal (not_crm) conversation and one handled outside the CRM for
    -- its current actionable inbound do not count.
    select 'unmatched_inbound', 'unmatched-inbound', null, null, '/inbox?view=unmatched',
           max(c.awaiting_since), count(*)::text, 'unknown_sender_unanswered', null
    from conv c
    where c.client_id is null and c.enquiry_id is null
      and c.awaiting_since is not null
      and not crm_private.conversation_hidden_as_not_crm(c.not_crm_at, c.client_id, c.enquiry_id)
      and not exists (select 1 from acks k
                      where k.item_kind = 'conversation_reply' and k.entity_id = c.id
                        and k.observed_at >= c.awaiting_since)
    having count(*) > 0

    union all
    -- Operator follow-ups past due.
    select 'overdue_follow_up', 'follow-up-' || f.id, f.client_id, left(f.subject, 120),
           case when f.enquiry_id is not null then '/enquiries/' || f.enquiry_id
                when f.project_id is not null then '/projects/' || f.project_id
                when f.client_id is not null then '/clients/' || f.client_id end,
           f.due_at, null, 'follow_up_overdue', null
    from public.follow_ups f
    where f.artist_id = p_artist_id and f.status = 'open' and f.due_at < (select t from now_)

    union all
    -- The studio's last message is unanswered: one item per cycle. The 7-day
    -- and 21-day kinds share the acknowledgement keyed by the cycle, so a
    -- decision taken on day 7 still holds on day 21.
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason',
           jsonb_build_object('kind', 'client_silence', 'entity_id', at.client_id,
                              'observed_at', (at.a ->> 'last_outbound_at')::timestamptz)
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')
      and at.a ->> 'last_outbound_at' is not null
      -- A manual follow-up: open, or completed/cancelled during this cycle.
      and not exists (
        select 1 from client_follow_ups f
        where f.client_id = at.client_id
          and (f.status = 'open' or f.closed_at >= (at.a ->> 'last_outbound_at')::timestamptz))
      -- A proposed appointment already has its own row.
      and not exists (
        select 1 from live_sessions s
        where s.client_id = at.client_id and s.status in ('draft', 'proposed')
          and s.start_at >= (select t from now_))
      -- A paid deposit: the next step is the studio's.
      and not exists (
        select 1 from public.projects p
        where p.artist_id = p_artist_id and p.client_id = at.client_id and p.archived_at is null
          and p.status in ('draft', 'active', 'on_hold') and p.deposit_status = 'paid')

    union all
    -- Integration failures, grouped: the detail belongs on the integrations screen.
    select 'integration_failure', 'integration-failures', null, null, '/integrations', null,
           count(*)::text, 'integration_jobs_failed', null
    from public.integration_outbox o
    where p_include_integrations and o.artist_id = p_artist_id and o.status in ('failed', 'dead')
    having count(*) > 0
  ),
  visible as (
    select r.* from raw r
    where r.ack is null
       or not exists (select 1 from acks k
                      where k.item_kind = r.ack ->> 'kind'
                        and k.entity_id = (r.ack ->> 'entity_id')::uuid
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz
                        -- "Not now" covers the cycle until its time comes.
                        and (k.resurface_at is null or k.resurface_at > (select t from now_)))
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state,
      case when r.kind in ('client_follow_up_due', 'client_cold')
        then crm_private.client_silence_context(p_artist_id, r.client_id, r.at) end as context
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', case
      when r.context ->> 'conversation_id' is not null then '/inbox/' || (r.context ->> 'conversation_id')
      when r.context ->> 'channel' = 'email' then '/inbox/email/client-' || r.client_id
      else r.href end,
    'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'context', r.context,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$function$
