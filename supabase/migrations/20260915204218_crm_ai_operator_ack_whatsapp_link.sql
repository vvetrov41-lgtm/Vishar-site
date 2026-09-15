-- Prevent client-AI "Needs you" noise after the artist has explicitly taken
-- an enquiry in hand, and make exact WhatsApp phone matches part of the same
-- client timeline instead of leaving them unmatched.

create or replace function crm_private.client_request_information_is_actionable(
  p_artist_id uuid,
  p_client_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_status public.enquiry_status;
  v_ack_at timestamptz;
begin
  select e.status, e.updated_at
  into v_status, v_ack_at
  from public.enquiries e
  where e.artist_id = p_artist_id
    and e.client_id = p_client_id
    and e.archived_at is null
  order by e.updated_at desc, e.created_at desc, e.id desc
  limit 1;

  if not found then
    return true;
  end if;

  -- A brand-new enquiry may legitimately need an intake question.
  if v_status = 'new'::public.enquiry_status then
    return true;
  end if;

  -- Terminal states never need another intake-information request.
  if v_status in (
    'declined'::public.enquiry_status,
    'converted'::public.enquiry_status,
    'closed'::public.enquiry_status
  ) then
    return false;
  end if;

  -- reviewing / waiting_for_client / accepted / quote_sent /
  -- deposit_requested / deposit_paid are explicit operator workflow moves.
  -- They acknowledge everything known at that point. A new request for client
  -- information becomes actionable only after a newer inbound interaction.
  return exists (
    select 1
    from crm_private.client_timeline_items(p_artist_id, p_client_id) t
    where t.direction = 'inbound'
      and t.source <> 'enquiry'
      and t.occurred_at > v_ack_at
  );
end;
$$;

revoke execute on function crm_private.client_request_information_is_actionable(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.unique_whatsapp_client_match(
  p_artist_id uuid,
  p_external_contact_id text
) returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_phone text;
  v_count integer;
  v_client_id uuid;
begin
  v_phone := crm_private.normalize_whatsapp_phone(
    '+' || regexp_replace(coalesce(p_external_contact_id, ''), '\D', '', 'g')
  );
  if v_phone is null then
    return null;
  end if;

  select count(*), min(c.id::text)::uuid
  into v_count, v_client_id
  from public.clients c
  where c.archived_at is null
    and crm_private.client_in_artist_scope(c.id, p_artist_id)
    and crm_private.normalize_whatsapp_phone(c.phone) = v_phone;

  if v_count = 1 then
    return v_client_id;
  end if;
  return null;
end;
$$;

revoke execute on function crm_private.unique_whatsapp_client_match(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.auto_link_whatsapp_conversation_client()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_enquiry_id uuid;
begin
  if new.channel <> 'whatsapp'::public.communication_channel
     or new.client_id is not null then
    return new;
  end if;

  v_client_id := crm_private.unique_whatsapp_client_match(
    new.artist_id,
    new.external_contact_id
  );
  if v_client_id is null then
    return new;
  end if;

  select e.id into v_enquiry_id
  from public.enquiries e
  where e.artist_id = new.artist_id
    and e.client_id = v_client_id
    and e.archived_at is null
  order by e.updated_at desc, e.created_at desc, e.id desc
  limit 1;

  new.client_id := v_client_id;
  new.link_state := 'linked'::public.communication_link_state;
  new.enquiry_id := coalesce(new.enquiry_id, v_enquiry_id);
  return new;
end;
$$;

revoke execute on function crm_private.auto_link_whatsapp_conversation_client()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_conversations_auto_link_whatsapp on public.communication_conversations;
create trigger communication_conversations_auto_link_whatsapp
before insert or update of artist_id, channel, external_contact_id, client_id, last_inbound_at
on public.communication_conversations
for each row execute function crm_private.auto_link_whatsapp_conversation_client();

-- Invalid request_information recommendations must be suppressed, not renamed
-- to artist_review (which still generates a "Needs you" notification).
create or replace function crm_private.guard_client_ai_next_action_truth()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.status <> 'open' or new.action_type <> 'request_information' then
    return new;
  end if;

  if crm_private.client_has_scheduled_appointment(new.artist_id, new.client_id) then
    new.status := 'superseded';
    new.draft_reply := null;
    new.missing_information := '[]'::jsonb;
    return new;
  end if;

  if crm_private.client_has_reference_files(new.artist_id, new.client_id)
     and crm_private.client_ai_action_requests_attached_references(
       new.reason, new.draft_reply, new.missing_information
     ) then
    new.status := 'superseded';
    new.draft_reply := null;
    new.missing_information := '[]'::jsonb;
    return new;
  end if;

  if not crm_private.client_request_information_is_actionable(
    new.artist_id, new.client_id
  ) then
    new.status := 'superseded';
    new.draft_reply := null;
    new.missing_information := '[]'::jsonb;
  end if;

  return new;
end;
$$;

revoke execute on function crm_private.guard_client_ai_next_action_truth()
  from public, anon, authenticated, service_role;

-- Telegram gets a second live-state check at claim time. This protects against
-- an already-queued notification if the artist acknowledges the enquiry before
-- the Telegram drain runs.
create or replace function crm_private.client_ai_notification_is_current(
  n public.notifications
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select case
    when n.notification_type <> 'client_ai.next_action' then true
    else exists (
      select 1
      from public.client_ai_next_actions a
      where a.artist_id = n.artist_id
        and a.client_id = n.entity_id
        and a.status = 'open'
        and n.dedupe_key = 'client_ai_next_action:' || a.id::text || ':' || n.recipient_profile_id::text
        and crm_private.client_ai_watermark(a.artist_id, a.client_id)
              is not distinct from a.source_watermark
        and (
          a.action_type <> 'request_information'
          or (
            not crm_private.client_has_scheduled_appointment(a.artist_id, a.client_id)
            and crm_private.client_request_information_is_actionable(a.artist_id, a.client_id)
            and not (
              crm_private.client_has_reference_files(a.artist_id, a.client_id)
              and crm_private.client_ai_action_requests_attached_references(
                a.reason, a.draft_reply, a.missing_information
              )
            )
          )
        )
    )
  end;
$$;

revoke execute on function crm_private.client_ai_notification_is_current(public.notifications)
  from public, anon, authenticated, service_role;

-- Status changes are operator acknowledgements. Close an existing intake
-- request immediately before scheduling a refreshed client brief.
create or replace function crm_private.enqueue_enquiry_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_watermark text;
  v_source_event_id text;
begin
  if new.intake_state <> 'complete' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.intake_state = 'complete'
     and old.status is not distinct from new.status
     and old.project_type is not distinct from new.project_type
     and old.placement is not distinct from new.placement
     and old.approximate_size is not distinct from new.approximate_size
     and old.cover_up is not distinct from new.cover_up
     and old.preferred_timing is not distinct from new.preferred_timing
     and old.idea is not distinct from new.idea
     and old.archived_at is not distinct from new.archived_at then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status is distinct from new.status
     and new.status <> 'new'::public.enquiry_status then
    update public.client_ai_next_actions a
    set status = 'superseded', updated_at = clock_timestamp()
    where a.artist_id = new.artist_id
      and a.client_id = new.client_id
      and a.status = 'open'
      and a.action_type = 'request_information';
  end if;

  begin
    if tg_op = 'INSERT' then
      v_source_event_id := 'enquiry:' || new.id::text || ':' || new.status::text;
    else
      v_watermark := crm_private.client_ai_watermark(new.artist_id, new.client_id);
      v_source_event_id := 'enquiry:' || new.id::text || ':tx:'
        || pg_current_xact_id()::text || ':wm:'
        || left(coalesce(v_watermark, 'missing'), 32);
    end if;

    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, v_source_event_id
    );
  exception when others then null;
  end;
  return new;
end;
$$;

revoke execute on function crm_private.enqueue_enquiry_client_ai()
  from public, anon, authenticated, service_role;

-- Reconcile existing exact WhatsApp matches. Zero/ambiguous matches remain
-- untouched. Updating client_id/link_state intentionally fires the existing
-- conversation-link AI refresh trigger.
update public.communication_conversations c
set client_id = crm_private.unique_whatsapp_client_match(c.artist_id, c.external_contact_id),
    link_state = 'linked'::public.communication_link_state,
    enquiry_id = coalesce(
      c.enquiry_id,
      (
        select e.id
        from public.enquiries e
        where e.artist_id = c.artist_id
          and e.client_id = crm_private.unique_whatsapp_client_match(c.artist_id, c.external_contact_id)
          and e.archived_at is null
        order by e.updated_at desc, e.created_at desc, e.id desc
        limit 1
      )
    ),
    updated_at = clock_timestamp()
where c.channel = 'whatsapp'::public.communication_channel
  and c.client_id is null
  and crm_private.unique_whatsapp_client_match(c.artist_id, c.external_contact_id) is not null;

-- Remove currently-open false positives, including rows produced by the
-- previous guard that renamed a bad reference request to artist_review.
update public.client_ai_next_actions a
set status = 'superseded', updated_at = clock_timestamp()
where a.status = 'open'
  and (
    (
      a.action_type = 'request_information'
      and (
        crm_private.client_has_scheduled_appointment(a.artist_id, a.client_id)
        or not crm_private.client_request_information_is_actionable(a.artist_id, a.client_id)
        or (
          crm_private.client_has_reference_files(a.artist_id, a.client_id)
          and crm_private.client_ai_action_requests_attached_references(
            a.reason, a.draft_reply, a.missing_information
          )
        )
      )
    )
    or (
      a.action_type = 'artist_review'
      and a.reason in (
        'Client already has a scheduled appointment in CRM. Review the current booking and conversation before requesting more intake information.',
        'Reference files are already attached in CRM. Review the existing references before requesting them again.'
      )
    )
  );