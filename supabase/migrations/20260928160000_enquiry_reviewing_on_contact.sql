-- An enquiry stops being `new` once the artist has acted on it.
--
-- The owner's rule: an enquiry moves to `reviewing` as soon as the client has
-- been written to or a consultation has been booked. Until now nothing in the
-- CRM did that, so Today kept reporting "consultation booked, enquiry still
-- new" for work that was already in hand (every consultation booked through
-- GPT, and every one booked from a record page), and listed contacted
-- enquiries as untouched.
--
-- This records the fact, the same way ensure_enquiry_project records
-- `converted` when real work is booked: a direct `new -> reviewing` move with
-- an activity entry, never a move out of any other status. Only `new` is
-- touched, so declined/closed/converted and anything an operator set by hand
-- are left alone.
--
-- Evidence that counts:
--   * a consultation (in person or video) proposed or confirmed for the same
--     client and artist;
--   * an outbound message (WhatsApp/Instagram) the artist sent to the client
--     after the enquiry arrived; automated reminders do not count;
--   * an email the artist sent from the CRM, or Gmail showing the newest
--     message with the client is outbound and later than the enquiry.
-- Every piece of evidence only moves enquiries that arrived before it, so a
-- returning client's later enquiry is never swept up by old history.
-- Replies sent from the WhatsApp phone app are not visible to the CRM yet and
-- are therefore not evidence here.
--
-- Side effects checked: automation rules key on appointment.scheduled only;
-- Meta conversion events fire on `accepted`, not `reviewing`.
--
-- Today also ranks a record contradiction below an unanswered new enquiry:
-- a new enquiry is revenue waiting on a reply, a contradiction is tidying.

create or replace function crm_private.pulse_rank(p_kind text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_kind
    when 'reschedule_requested' then 10
    when 'reply' then 20
    when 'email_send_failed' then 30
    when 'email_draft_to_approve' then 35
    when 'payment_to_confirm' then 45
    when 'unconfirmed_appointment' then 50
    when 'deposit_outstanding' then 55
    when 'new_enquiry' then 60
    when 'conflict' then 62
    when 'unmatched_inbound' then 65
    when 'overdue_follow_up' then 70
    when 'client_follow_up_due' then 75
    when 'client_cold' then 80
    when 'integration_failure' then 95
    else 99
  end;
$$;

revoke all on function crm_private.pulse_rank(text) from public, anon, authenticated, service_role;

create or replace function crm_private.mark_enquiries_reviewing(
  p_artist_id uuid,
  p_client_id uuid,
  p_reason text,
  p_after timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry record;
  v_count integer := 0;
begin
  if p_artist_id is null or p_client_id is null then
    return 0;
  end if;

  for v_enquiry in
    select e.id
    from public.enquiries e
    where e.artist_id = p_artist_id
      and e.client_id = p_client_id
      and e.archived_at is null
      and e.status = 'new'
      and (p_after is null or e.created_at < p_after)
    for update
  loop
    update public.enquiries e set status = 'reviewing' where e.id = v_enquiry.id;
    perform crm_private.log_activity(
      'enquiry.status_changed', 'system', null, p_client_id, v_enquiry.id,
      null, null, null, null, null, null,
      jsonb_build_object('from_status', 'new', 'to_status', 'reviewing', 'reason', p_reason)
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function crm_private.mark_enquiries_reviewing(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

-- A consultation booked by any path. A projectless consultation with no
-- enquiry link is linked when the client has exactly one open `new` enquiry
-- with this artist, so the enquiry page shows the booking.
create or replace function crm_private.consultation_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_only uuid;
begin
  if new.appointment_type not in ('in_person_consultation', 'video_consultation')
     or new.status not in ('proposed', 'confirmed')
     or new.cancelled_at is not null then
    return new;
  end if;

  if new.enquiry_id is null and new.project_id is null then
    select min(e.id::text)::uuid into v_only
    from public.enquiries e
    where e.artist_id = new.artist_id and e.client_id = new.client_id
      and e.archived_at is null and e.status = 'new'
    having count(*) = 1;
    if v_only is not null then
      new.enquiry_id := v_only;
    end if;
  end if;

  -- Only enquiries that arrived before this consultation was booked: a later
  -- enquiry from a returning client is new work, not the one being handled.
  perform crm_private.mark_enquiries_reviewing(
    new.artist_id, new.client_id, 'consultation_booked', coalesce(new.created_at, clock_timestamp()));
  return new;
end;
$$;

revoke all on function crm_private.consultation_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_consultation_marks_enquiry_reviewing on public.sessions;
-- Named to sort after sessions_assign_artist and before sessions_validate_*:
-- the artist is resolved first, and the enquiry link it sets is validated.
create trigger sessions_consultation_marks_enquiry_reviewing
  before insert or update of status, appointment_type, cancelled_at on public.sessions
  for each row execute function crm_private.consultation_marks_enquiry_reviewing();

-- The artist wrote to the client from the CRM.
create or replace function crm_private.outbound_message_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_conv record;
begin
  -- The artist writing, from the CRM or (once echoes are ingested) from the
  -- phone app. Automated reminders are not the artist replying.
  if new.direction <> 'outbound' or new.origin = 'automation' then
    return null;
  end if;
  select c.artist_id, c.client_id into v_conv
  from public.communication_conversations c where c.id = new.conversation_id;
  if found and v_conv.client_id is not null then
    perform crm_private.mark_enquiries_reviewing(
      v_conv.artist_id, v_conv.client_id, 'client_contacted', new.created_at);
  end if;
  return null;
end;
$$;

revoke all on function crm_private.outbound_message_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_mark_enquiry_reviewing on public.communication_messages;
create trigger communication_messages_mark_enquiry_reviewing
  after insert on public.communication_messages
  for each row execute function crm_private.outbound_message_marks_enquiry_reviewing();

-- The artist replied by email (Gmail history evidence, including mail sent
-- outside the CRM).
create or replace function crm_private.gmail_outbound_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.last_direction = 'outbound' and new.last_message_at is not null
     and (tg_op = 'INSERT'
          or old.last_message_at is distinct from new.last_message_at
          or old.last_direction is distinct from new.last_direction) then
    perform crm_private.mark_enquiries_reviewing(
      new.artist_id, new.client_id, 'client_contacted', new.last_message_at);
  end if;
  return null;
end;
$$;

revoke all on function crm_private.gmail_outbound_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists gmail_client_email_activity_mark_enquiry_reviewing
  on crm_private.gmail_client_email_activity;
create trigger gmail_client_email_activity_mark_enquiry_reviewing
  after insert or update on crm_private.gmail_client_email_activity
  for each row execute function crm_private.gmail_outbound_marks_enquiry_reviewing();

-- The artist sent an email from the CRM: the send is authoritative as soon
-- as it is recorded, without waiting for the Gmail history refresh.
create or replace function crm_private.sent_email_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.status = 'sent'
     and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    perform crm_private.mark_enquiries_reviewing(
      new.artist_id, new.client_id, 'client_contacted', coalesce(new.sent_at, clock_timestamp()));
  end if;
  return null;
end;
$$;

revoke all on function crm_private.sent_email_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists email_messages_mark_enquiry_reviewing on public.email_messages;
create trigger email_messages_mark_enquiry_reviewing
  after insert or update of status on public.email_messages
  for each row execute function crm_private.sent_email_marks_enquiry_reviewing();

-- A reply sent while the conversation was still unmatched counts once the
-- conversation is linked to the client.
create or replace function crm_private.linked_conversation_marks_enquiry_reviewing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_last_out timestamptz;
begin
  if new.client_id is null or new.client_id is not distinct from old.client_id then
    return null;
  end if;
  select max(m.created_at) into v_last_out
  from public.communication_messages m
  where m.conversation_id = new.id and m.direction = 'outbound' and m.origin <> 'automation';
  if v_last_out is not null then
    perform crm_private.mark_enquiries_reviewing(
      new.artist_id, new.client_id, 'client_contacted', v_last_out);
  end if;
  return null;
end;
$$;

revoke all on function crm_private.linked_conversation_marks_enquiry_reviewing()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_conversations_mark_enquiry_reviewing on public.communication_conversations;
create trigger communication_conversations_mark_enquiry_reviewing
  after update of client_id on public.communication_conversations
  for each row execute function crm_private.linked_conversation_marks_enquiry_reviewing();

-- Existing records: apply the same evidence once.
do $$
declare
  r record;
begin
  for r in
    select s.artist_id, s.client_id, max(s.created_at) as booked_at
    from public.sessions s
    where s.cancelled_at is null
      and s.appointment_type in ('in_person_consultation', 'video_consultation')
      and s.status in ('proposed', 'confirmed')
    group by s.artist_id, s.client_id
  loop
    perform crm_private.mark_enquiries_reviewing(r.artist_id, r.client_id, 'consultation_booked', r.booked_at);
  end loop;

  for r in
    select em.artist_id, em.client_id, max(coalesce(em.sent_at, em.updated_at)) as sent_at
    from public.email_messages em
    where em.status = 'sent' and em.client_id is not null and em.artist_id is not null
    group by em.artist_id, em.client_id
  loop
    perform crm_private.mark_enquiries_reviewing(r.artist_id, r.client_id, 'client_contacted', r.sent_at);
  end loop;

  for r in
    select c.artist_id, c.client_id, max(m.created_at) as last_out
    from public.communication_messages m
    join public.communication_conversations c on c.id = m.conversation_id
    where m.direction = 'outbound' and m.origin <> 'automation' and c.client_id is not null
    group by c.artist_id, c.client_id
  loop
    perform crm_private.mark_enquiries_reviewing(r.artist_id, r.client_id, 'client_contacted', r.last_out);
  end loop;

  for r in
    select g.artist_id, g.client_id, g.last_message_at
    from crm_private.gmail_client_email_activity g
    where g.last_direction = 'outbound' and g.last_message_at is not null
  loop
    perform crm_private.mark_enquiries_reviewing(r.artist_id, r.client_id, 'client_contacted', r.last_message_at);
  end loop;
end;
$$;
