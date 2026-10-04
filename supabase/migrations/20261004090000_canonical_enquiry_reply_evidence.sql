-- 20261004090000_canonical_enquiry_reply_evidence.sql
--
-- One answer to "has the artist answered this enquiry yet, and when".
--
-- Observed on production on 2026-10-04: Today reported
-- enquiries_without_reply_30d = 23 and median_first_reply_hours = 236.8 for
-- Vladimir, while most of those clients had been answered. The summary only
-- looked at two CRM tables:
--   * communication_messages, where replies typed in the WhatsApp phone app
--     exist only since smb_message_echoes ingestion started (2026-09-28); and
--   * email_messages, which holds mail sent FROM the CRM (3 rows), not the
--     replies Vladimir writes in Gmail directly.
-- The durable Gmail evidence the CRM already collects was never consulted,
-- and when it was consulted elsewhere it only stored the newest message per
-- client, so an outbound followed by a client reply disappeared. It also
-- counted failed and queued outbound messages and automated reminders as the
-- artist replying, and the "first" reply for the median was whatever the CRM
-- happened to see first (the 2026-09-28 echo backlog), not the real one.
--
-- Definition (crm_private.enquiry_first_artist_reply):
--   An enquiry E of client C for artist A is answered at the earliest time t
--   with E.created_at <= t < (C's next enquiry for A).created_at at which one
--   of these exists:
--     1. a WhatsApp/Instagram message from A to C that the provider accepted
--        (status sent, delivered or read) and that a person wrote (origin crm
--        or provider_app). queued, failed and automation messages are not a
--        reply;
--     2. an email the CRM sent (status sent, sent_at and a provider message
--        id present) that a person wrote. Drafts, approved, queued, failed,
--        cancelled, AI drafts never sent, and system/automation mail
--        (booking cards, deposit confirmations) are not a reply;
--     3. a message Gmail holds in the artist mailbox's SENT label, From the
--        mailbox To the client (crm_private.gmail_client_outbound_messages,
--        filled by the Gmail Worker, which checks the SENT label).
--   The enquiry status (new, reviewing, ...) is not evidence either way.
--   Replies before the enquiry, and replies after the client's next enquiry,
--   belong to another enquiry.
--
-- Some replies happened where the CRM could not see them (the WhatsApp phone
-- app before echo ingestion). For those the CRM has operator facts that, by
-- their own definition, say the studio already answered
-- (crm_private.enquiry_reply_attestation):
--     * the operator cleared this client's reply item or this enquiry's new
--       enquiry item in Today (the attention engine already reads that as
--       "the studio took its turn");
--     * the operator moved the enquiry to waiting_for_client;
--     * the operator booked an appointment for it.
--   An attested enquiry is not counted as without reply, but it has no
--   reliable reply time, so it never enters the median. When an attestation
--   is older than the first message the CRM can see, that message was not
--   the first reply (the real one was unobservable), so its time is not used
--   either (crm_private.enquiry_reply_state). The summary reports how many
--   enquiries are answered without a known reply time.
--
-- Used by: pulse_summary (enquiries_without_reply_30d,
-- median_first_reply_hours), the Today new_enquiry item, and the Telegram
-- unanswered-enquiry reminder (unanswered_waiting_since).

-- ---------------------------------------------------------------------------
-- 1. Gmail outbound evidence, one row per sent message, no content
-- ---------------------------------------------------------------------------

create table crm_private.gmail_client_outbound_messages (
  artist_id uuid not null references public.artists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  sent_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (artist_id, client_id, sent_at)
);

alter table crm_private.gmail_client_outbound_messages enable row level security;
revoke all on crm_private.gmail_client_outbound_messages
  from public, anon, authenticated, service_role;

comment on table crm_private.gmail_client_outbound_messages is
  'Times of messages in an artist Gmail mailbox SENT label addressed to a known client. No subject, body, address or provider id. A retried or duplicated observation of the same message is the same row.';

create table crm_private.gmail_enquiry_reply_checks (
  enquiry_id uuid primary key references public.enquiries(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  checked_at timestamptz not null,
  found boolean not null
);

alter table crm_private.gmail_enquiry_reply_checks enable row level security;
revoke all on crm_private.gmail_enquiry_reply_checks
  from public, anon, authenticated, service_role;

comment on table crm_private.gmail_enquiry_reply_checks is
  'When the Gmail Worker last looked for the artist''s first sent mail after an enquiry, so each enquiry is looked up at most every six hours.';

create function crm_private.note_gmail_client_outbound(
  p_artist_id uuid,
  p_client_id uuid,
  p_sent_at timestamptz
)
returns void
language sql
security definer
set search_path = pg_catalog, public, crm_private
as $$
  insert into crm_private.gmail_client_outbound_messages (artist_id, client_id, sent_at)
  select p_artist_id, p_client_id, p_sent_at
  where p_artist_id is not null and p_client_id is not null and p_sent_at is not null
    and p_sent_at <= clock_timestamp() + interval '5 minutes'
  on conflict do nothing;
$$;

revoke all on function crm_private.note_gmail_client_outbound(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- Only messages Gmail filed as SENT are evidence. The snapshot and the
-- per-client activity record keep the newest message of any outbound kind
-- (a scheduled message included), so they are not copied here: the Gmail
-- Worker records SENT messages and looks up each recent enquiry itself.

-- ---------------------------------------------------------------------------
-- 2. The canonical reply predicate
-- ---------------------------------------------------------------------------

-- The span of time in which a message to the client answers this enquiry:
-- from its creation until the same client's next enquiry to the same artist.
create function crm_private.enquiry_reply_window(p_enquiry_id uuid)
returns table (
  enquiry_id uuid,
  artist_id uuid,
  client_id uuid,
  opened_at timestamptz,
  closed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select e.id, e.artist_id, e.client_id, e.created_at,
    (select min(n.created_at) from public.enquiries n
     where n.artist_id = e.artist_id and n.client_id = e.client_id and n.id <> e.id
       and n.archived_at is null and n.intake_state = 'complete'
       and n.created_at > e.created_at)
  from public.enquiries e
  where e.id = p_enquiry_id;
$$;

revoke all on function crm_private.enquiry_reply_window(uuid)
  from public, anon, authenticated, service_role;

create function crm_private.enquiry_first_artist_reply(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns table (
  replied_at timestamptz,
  channel text,
  evidence_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with w as (select * from crm_private.enquiry_reply_window(p_enquiry_id)),
  evidence as (
    -- 1. WhatsApp / Instagram, written by a person, accepted by the provider.
    select coalesce(m.provider_timestamp, m.sent_at, m.created_at) as at,
           m.channel::text as channel, 'communication_message'::text as source
    from w
    join public.communication_conversations c
      on c.artist_id = w.artist_id and (c.client_id = w.client_id or c.enquiry_id = w.enquiry_id)
    join public.communication_messages m
      on m.conversation_id = c.id and m.artist_id = w.artist_id
    where m.direction = 'outbound'::public.communication_direction
      and m.origin in ('crm'::public.communication_origin, 'provider_app'::public.communication_origin)
      and m.status in ('sent'::public.communication_status,
                       'delivered'::public.communication_status,
                       'read'::public.communication_status)

    union all
    -- 2. Email the CRM sent through the provider, written by a person.
    select em.sent_at, 'email', 'crm_email'
    from w
    join public.email_messages em
      on em.artist_id = w.artist_id and (em.enquiry_id = w.enquiry_id or em.client_id = w.client_id)
    where em.status = 'sent'::public.email_message_status
      and em.sent_at is not null
      and em.provider_message_id is not null
      and em.automation_job_id is null
      and coalesce(em.created_by_kind, '') <> 'system'

    union all
    -- 3. Mail the artist sent from Gmail itself (SENT label, to the client).
    select g.sent_at, 'email', 'gmail_mailbox'
    from w
    join crm_private.gmail_client_outbound_messages g
      on g.artist_id = w.artist_id and g.client_id = w.client_id
  )
  select ev.at, ev.channel, ev.source
  from evidence ev, w
  where ev.at >= w.opened_at
    and (w.closed_at is null or ev.at < w.closed_at)
    and (p_as_of is null or ev.at <= p_as_of)
  order by ev.at, ev.source
  limit 1;
$$;

revoke all on function crm_private.enquiry_first_artist_reply(uuid, timestamptz)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_first_artist_reply(uuid, timestamptz) is
  'The first provider-confirmed message a person sent the client for this enquiry (WhatsApp/Instagram sent|delivered|read, CRM email sent, Gmail SENT), inside the enquiry reply window. Empty when none is known.';

-- Operator facts that by definition say the studio already answered, for
-- replies the CRM could not observe. No reply time is claimed.
create function crm_private.enquiry_reply_attestation(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns table (
  attested_at timestamptz,
  attestation_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with w as (select * from crm_private.enquiry_reply_window(p_enquiry_id)),
  facts as (
    -- The operator cleared this client's reply item or this enquiry's item.
    select a.acknowledged_at as at, 'today_item_handled'::text as source, false as enquiry_scoped
    from w
    join public.attention_acknowledgements a on a.artist_id = w.artist_id
    where (a.item_kind = 'new_enquiry' and a.entity_id = w.enquiry_id)
       or (a.item_kind = 'gmail_reply' and a.entity_id = w.client_id)
       or (a.item_kind = 'conversation_reply' and exists (
             select 1 from public.communication_conversations c
             where c.id = a.entity_id and c.artist_id = w.artist_id
               and (c.client_id = w.client_id or c.enquiry_id = w.enquiry_id)))

    union all
    -- The operator said the studio is now waiting for the client.
    select l.occurred_at, 'operator_waiting_for_client', true
    from w
    join public.activity_log l on l.enquiry_id = w.enquiry_id
    where l.event_type = 'enquiry.status_changed'
      and l.metadata ->> 'to_status' = 'waiting_for_client'
      and l.actor_kind in ('owner', 'staff')

    union all
    -- The operator booked an appointment for this enquiry or this client.
    select l.occurred_at, 'operator_booked_appointment', l.enquiry_id is not distinct from w.enquiry_id
    from w
    join public.activity_log l
      on l.enquiry_id = w.enquiry_id
      or (l.client_id = w.client_id and l.artist_id = w.artist_id)
    where l.event_type = 'appointment.scheduled'
      and l.actor_kind in ('owner', 'staff')
  )
  select f.at, f.source
  from facts f, w
  where f.at >= w.opened_at
    and (f.enquiry_scoped or w.closed_at is null or f.at < w.closed_at)
    and (p_as_of is null or f.at <= p_as_of)
  order by f.at, f.source
  limit 1;
$$;

revoke all on function crm_private.enquiry_reply_attestation(uuid, timestamptz)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_reply_attestation(uuid, timestamptz) is
  'An operator fact that the studio already answered this enquiry where the CRM could not see the message (Today item handled, moved to waiting_for_client, appointment booked). Carries no reply time.';

create function crm_private.enquiry_has_artist_reply(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (select 1 from crm_private.enquiry_first_artist_reply(p_enquiry_id, p_as_of))
      or exists (select 1 from crm_private.enquiry_reply_attestation(p_enquiry_id, p_as_of));
$$;

revoke all on function crm_private.enquiry_has_artist_reply(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- Everything the summary needs about one enquiry, from the two facts above.
create function crm_private.enquiry_reply_state(
  p_enquiry_id uuid,
  p_as_of timestamptz default null
)
returns table (
  answered boolean,
  first_reply_at timestamptz,
  first_reply_source text,
  attested_at timestamptz,
  attestation_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select fr.replied_at is not null or att.attested_at is not null,
         -- An operator already attested an earlier, unseen reply: the first
         -- visible message is not the first reply, so no time is known.
         case when att.attested_at is null or att.attested_at >= fr.replied_at then fr.replied_at end,
         fr.evidence_source,
         att.attested_at,
         att.attestation_source
  from (select 1) one
  left join lateral crm_private.enquiry_first_artist_reply(p_enquiry_id, p_as_of) fr on true
  left join lateral crm_private.enquiry_reply_attestation(p_enquiry_id, p_as_of) att on true;
$$;

revoke all on function crm_private.enquiry_reply_state(uuid, timestamptz)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_reply_state(uuid, timestamptz) is
  'Whether the enquiry is answered, and the first reply time when it is known (provider-confirmed and not preceded by an attestation of an earlier unseen reply).';

-- ---------------------------------------------------------------------------
-- 3. Today summary numbers
-- ---------------------------------------------------------------------------

create or replace function crm_private.pulse_summary(p_artist_id uuid, p_now timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with t as (select coalesce(p_now, clock_timestamp()) as now_,
                    coalesce(p_now, clock_timestamp()) - interval '24 hours' as since),
  recent_enquiries as (
    select e.id, e.created_at from public.enquiries e, t
    where e.artist_id = p_artist_id and e.archived_at is null and e.intake_state = 'complete'
      and not e.excluded_from_analytics
      and e.created_at >= t.now_ - interval '30 days' and e.created_at <= t.now_
  ),
  reply as (
    select re.id, re.created_at, st.answered, st.first_reply_at as replied_at
    from recent_enquiries re, t
    cross join lateral crm_private.enquiry_reply_state(re.id, t.now_) st
  ),
  snap as (
    select max(g.refreshed_at) as refreshed_at from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id
  )
  select jsonb_build_object(
    'changes', jsonb_build_object(
      'new_enquiries', (select count(*) from public.enquiries e, t
                        where e.artist_id = p_artist_id and e.created_at >= t.since
                          and e.archived_at is null and e.intake_state = 'complete'),
      'inbound_messages', (select count(*) from public.communication_messages m, t
                           where m.artist_id = p_artist_id and m.direction = 'inbound'
                             and coalesce(m.provider_timestamp, m.created_at) >= t.since),
      'sessions_booked', (select count(*) from public.sessions s, t
                          where s.artist_id = p_artist_id and s.created_at >= t.since and s.cancelled_at is null),
      'payments_received', (select count(*) from public.payment_transactions pt, t
                            where pt.artist_id = p_artist_id and pt.status = 'succeeded'
                              and pt.direction = 'credit' and pt.occurred_at >= t.since)
    ),
    -- Only known first-reply times; answered-without-time enquiries have none.
    'median_first_reply_hours', (
      select round((percentile_cont(0.5) within group (
        order by extract(epoch from r.replied_at - r.created_at)) / 3600)::numeric, 1)
      from reply r where r.replied_at is not null),
    'first_reply_timed_30d', (select count(*) from reply r where r.replied_at is not null),
    'enquiries_reply_attested_30d', (
      select count(*) from reply r where r.answered and r.replied_at is null),
    'enquiries_without_reply_30d', (select count(*) from reply r where not r.answered),
    'sources', jsonb_build_object(
      'gmail_snapshot', case
        when (select refreshed_at from snap) is null then 'unavailable'
        when (select refreshed_at from snap) < (select now_ from t) - interval '24 hours' then 'stale'
        else 'fresh' end,
      'gmail_refreshed_at', (select refreshed_at from snap)
    )
  );
$$;

revoke all on function crm_private.pulse_summary(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Today items: a new enquiry is untouched until the artist answered it
-- ---------------------------------------------------------------------------
-- Unchanged from 20260924050000 except the new_enquiry rule. It used to treat
-- any conversation or Gmail activity after the enquiry (an inbound message
-- from the client included) and any approved/queued/failed email as engagement.

create or replace function crm_private.pulse_items(
  p_artist_id uuid,
  p_include_finance boolean,
  p_include_integrations boolean,
  p_now timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as (
    select ac.client_id, crm_private.client_attention(p_artist_id, ac.client_id, (select t from now_)) as a
    from crm_private.pulse_active_clients(p_artist_id) ac
  ),
  live_sessions as (
    select s.* from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null
      and s.status in ('draft', 'proposed', 'confirmed')
  ),
  conv as (
    select c.*, latest.direction as latest_direction
    from public.communication_conversations c
    left join lateral (
      select m.direction from public.communication_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc limit 1
    ) latest on true
    where c.artist_id = p_artist_id
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
  raw as (
    -- A client asking to move a booked time.
    select 'reschedule_requested'::text as kind, 'reschedule-' || s.id as key, s.client_id,
           null::text as subject, '/appointments/' || s.id as href, s.start_at as at, null::text as detail,
           'client_asked_to_reschedule'::text as reason, null::jsonb as ack
    from live_sessions s
    where s.client_response = 'reschedule_requested' and s.start_at >= (select t from now_)

    union all
    -- Linked conversation whose newest message is the client's.
    select 'reply', 'reply-' || c.id, c.client_id,
           coalesce(c.external_display_label, c.external_username),
           '/inbox/' || c.id, coalesce(c.last_inbound_at, c.last_message_at), c.channel::text,
           'client_message_unanswered',
           case when c.last_inbound_at is not null then
             jsonb_build_object('kind', 'conversation_reply', 'entity_id', c.id, 'observed_at', c.last_inbound_at)
           end
    from conv c
    where c.state = 'open' and c.latest_direction = 'inbound'
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
    -- who they are is Inbox work (Phase 5); Today only says it is waiting.
    select 'unmatched_inbound', 'unmatched-inbound', null, null, '/inbox?view=unmatched',
           max(c.last_inbound_at), count(*)::text, 'unknown_sender_unanswered', null
    from conv c
    where c.state = 'open' and c.client_id is null and c.enquiry_id is null
      and c.latest_direction = 'inbound'
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
    -- The studio spoke last and the client went quiet (Phase 2 SLA).
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason', null
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')

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
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz)
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', r.href, 'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$$;

revoke all on function crm_private.pulse_items(uuid, boolean, boolean, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Telegram unanswered-enquiry reminder: the same rule as Today
-- ---------------------------------------------------------------------------

create or replace function crm_private.unanswered_waiting_since(p_entity_type text, p_artist_id uuid, p_entity_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case p_entity_type
    when 'conversation' then (
      select c.last_inbound_at
      from public.communication_conversations c
      where c.id = p_entity_id
        and c.artist_id = p_artist_id
        and c.state = 'open'
        and c.last_inbound_at is not null
        and c.last_inbound_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = c.artist_id and k.item_kind = 'conversation_reply'
            and k.entity_id = c.id and k.observed_at >= c.last_inbound_at))
    when 'client' then (
      select g.last_message_at
      from public.gmail_client_metadata_snapshots g
      where g.artist_id = p_artist_id
        and g.client_id = p_entity_id
        and g.direction = 'inbound'
        and g.last_message_at is not null
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = g.artist_id and k.item_kind = 'gmail_reply'
            and k.entity_id = g.client_id and k.observed_at >= g.last_message_at))
    when 'enquiry' then (
      -- A website enquiry the artist has not answered (same rule as Today).
      select e.created_at
      from public.enquiries e
      where e.id = p_entity_id
        and e.artist_id = p_artist_id
        and e.archived_at is null and e.status = 'new' and e.intake_state = 'complete'
        and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
        and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
        and not crm_private.enquiry_has_artist_reply(e.id)
        and not exists (
          select 1 from public.email_messages m
          where m.artist_id = e.artist_id
            and (m.enquiry_id = e.id or m.client_id = e.client_id)
            and m.created_at >= e.created_at
            and ((m.status = 'draft' and m.created_by_kind = 'human') or m.status = 'failed'))
        and not exists (
          select 1 from public.attention_acknowledgements k
          where k.artist_id = e.artist_id and k.item_kind = 'new_enquiry'
            and k.entity_id = e.id and k.observed_at >= e.created_at))
  end;
$$;

revoke all on function crm_private.unanswered_waiting_since(text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Gmail Worker: record sent mail and look up the first reply per enquiry
-- ---------------------------------------------------------------------------

create function public.service_record_gmail_outbound_messages(
  p_artist_id uuid,
  p_messages jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row jsonb;
  v_client uuid;
  v_sent_at timestamptz;
  v_count integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail outbound recording is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or jsonb_typeof(p_messages) is distinct from 'array'
     or jsonb_array_length(p_messages) > 50 then
    raise exception 'invalid Gmail outbound evidence' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_messages) loop
    begin
      v_client := (v_row ->> 'client_id')::uuid;
      v_sent_at := (v_row ->> 'sent_at')::timestamptz;
    exception when others then
      raise exception 'invalid Gmail outbound evidence' using errcode = '22023';
    end;
    if v_client is null or v_sent_at is null or v_sent_at > now() + interval '5 minutes' then
      raise exception 'invalid Gmail outbound evidence' using errcode = '22023';
    end if;
    -- Only a client this artist genuinely works with.
    continue when not exists (
      select 1 from public.enquiries e where e.client_id = v_client and e.artist_id = p_artist_id
      union all
      select 1 from public.sessions s where s.client_id = v_client and s.artist_id = p_artist_id);
    insert into crm_private.gmail_client_outbound_messages (artist_id, client_id, sent_at)
    values (p_artist_id, v_client, v_sent_at)
    on conflict do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.service_record_gmail_outbound_messages(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_outbound_messages(uuid, jsonb) to service_role;

comment on function public.service_record_gmail_outbound_messages(uuid, jsonb) is
  'Backend-only: times of mail the artist mailbox sent to known clients ([{client_id, sent_at}], at most 50). Duplicates are ignored.';

create function public.service_list_gmail_reply_candidates(
  p_artist_id uuid,
  p_limit integer default 3
)
returns table (
  enquiry_id uuid,
  client_email text,
  created_at timestamptz,
  closed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply candidates are backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or coalesce(p_limit, 0) < 1 or p_limit > 10 then
    raise exception 'invalid Gmail reply candidate request' using errcode = '22023';
  end if;

  return query
  select e.id, lower(btrim(c.email)), e.created_at, w.closed_at
  from public.enquiries e
  join public.clients c on c.id = e.client_id and c.archived_at is null
  cross join lateral crm_private.enquiry_reply_window(e.id) w
  left join crm_private.gmail_enquiry_reply_checks k on k.enquiry_id = e.id
  where e.artist_id = p_artist_id
    and e.archived_at is null and e.intake_state = 'complete'
    and e.created_at >= now() - interval '30 days'
    and nullif(btrim(coalesce(c.email, '')), '') is not null
    and (k.checked_at is null or k.checked_at < now() - interval '6 hours')
    and not exists (select 1 from crm_private.enquiry_first_artist_reply(e.id))
  order by k.checked_at nulls first, e.created_at desc, e.id
  limit p_limit;
end;
$$;

revoke all on function public.service_list_gmail_reply_candidates(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_list_gmail_reply_candidates(uuid, integer) to service_role;

comment on function public.service_list_gmail_reply_candidates(uuid, integer) is
  'Backend-only: recent enquiries of this artist with no provider-confirmed first reply yet, with the client address and the reply window to look up in Gmail.';

create function public.service_record_gmail_enquiry_reply_check(
  p_artist_id uuid,
  p_enquiry_id uuid,
  p_first_sent_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail reply recording is backend-only' using errcode = '42501';
  end if;
  select e.id, e.client_id, e.created_at into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id and e.artist_id = p_artist_id;
  if not found then
    raise exception 'Gmail reply target is unavailable' using errcode = '22023';
  end if;
  if p_first_sent_at is not null and p_first_sent_at > now() + interval '5 minutes' then
    raise exception 'invalid Gmail reply time' using errcode = '22023';
  end if;

  if p_first_sent_at is not null then
    perform crm_private.note_gmail_client_outbound(p_artist_id, v_enquiry.client_id, p_first_sent_at);
  end if;
  insert into crm_private.gmail_enquiry_reply_checks (enquiry_id, artist_id, checked_at, found)
  values (p_enquiry_id, p_artist_id, now(), p_first_sent_at is not null)
  on conflict (enquiry_id) do update
  set checked_at = excluded.checked_at,
      found = crm_private.gmail_enquiry_reply_checks.found or excluded.found;
end;
$$;

revoke all on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz) to service_role;

comment on function public.service_record_gmail_enquiry_reply_check(uuid, uuid, timestamptz) is
  'Backend-only: the oldest SENT Gmail message to the client after the enquiry (or none), and that the lookup ran.';
