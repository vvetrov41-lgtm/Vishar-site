-- Phase 2: after the separate 110000 OAuth and 120000 v5 staging releases,
-- remove obsolete reply-overdue notifications only after an actual
-- artist/provider-app response was accepted, never after an automation.
-- The update is limited to notification status. Message and financial records
-- remain unchanged; dismissed alerts remain queryable as history.
create function crm_private.dismiss_reply_overdue_after_human_response()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_replied_at timestamptz;
begin
  if new.direction <> 'outbound'::public.communication_direction
     or new.origin not in ('crm'::public.communication_origin, 'provider_app'::public.communication_origin)
     or new.status not in ('sent'::public.communication_status,
                           'delivered'::public.communication_status,
                           'read'::public.communication_status)
     or not crm_private.communication_event_is_actionable(new.message_type) then
    return new;
  end if;

  v_replied_at := coalesce(new.provider_timestamp, new.sent_at, new.created_at);
  -- A newer client message takes precedence, including when a delayed
  -- provider acknowledgement arrives after that client message.
  if v_replied_at is null
     or v_replied_at <= coalesce(
       crm_private.conversation_last_actionable_inbound_at(new.conversation_id),
       '-infinity'::timestamptz
     ) then
    return new;
  end if;

  -- Reuse the CRM's authoritative outstanding-reply rule, not an approximation
  -- based on conversation.last_outbound_at (which automated cards can update).
  if crm_private.unanswered_waiting_since('conversation', new.artist_id, new.conversation_id)
     is not null then
    return new;
  end if;

  update public.notifications n
  set status = 'dismissed'::public.notification_status
  where n.notification_type = 'client.reply_overdue'
    and n.entity_type = 'conversation'
    and n.entity_id = new.conversation_id
    and n.artist_id = new.artist_id
    and n.status in ('pending'::public.notification_status,
                     'delivered'::public.notification_status)
    and n.read_at is null
    and n.created_at < v_replied_at;
  return new;
end;
$fn$;

revoke all on function crm_private.dismiss_reply_overdue_after_human_response()
  from public, anon, authenticated;

create trigger communication_messages_dismiss_answered_reply_overdue
after insert or update of status, provider_timestamp, sent_at, delivered_at, read_at
on public.communication_messages
for each row
execute function crm_private.dismiss_reply_overdue_after_human_response();

-- One-off bounded cleanup. Do not infer a reply from the conversation's
-- generic last_outbound_at: automated cards can advance it too.
update public.notifications n
set status = 'dismissed'::public.notification_status
where n.notification_type = 'client.reply_overdue'
  and n.entity_type = 'conversation'
  and n.status = 'delivered'::public.notification_status
  and n.read_at is null
  and n.created_at >= now() - interval '14 days'
  and crm_private.unanswered_waiting_since('conversation', n.artist_id, n.entity_id) is null
  and exists (
    select 1 from public.communication_messages m
    where m.conversation_id = n.entity_id
      and m.artist_id = n.artist_id
      and m.direction = 'outbound'::public.communication_direction
      and m.origin in ('crm'::public.communication_origin, 'provider_app'::public.communication_origin)
      and m.status in ('sent'::public.communication_status,
                       'delivered'::public.communication_status,
                       'read'::public.communication_status)
      and crm_private.communication_event_is_actionable(m.message_type)
      and coalesce(m.provider_timestamp, m.sent_at, m.created_at) > n.created_at
      and coalesce(m.provider_timestamp, m.sent_at, m.created_at)
          > coalesce(crm_private.conversation_last_actionable_inbound_at(n.entity_id),
                     '-infinity'::timestamptz)
  );
