-- Phase 2: personal/non-CRM chat classification immediately resolves
-- stale reply-overdue notifications. Do not change messages, payment records,
-- enquiry statuses, ownership or user read acknowledgements.
--
-- A conversation is hidden from CRM attention only when explicitly marked
-- personal AND still unlinked to a client and an enquiry.  This predicate
-- matches crm_private.conversation_hidden_as_not_crm().
create function crm_private.dismiss_personal_conversation_reply_alerts()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
begin
  if old.not_crm_at is not distinct from new.not_crm_at
     or not crm_private.conversation_hidden_as_not_crm(
       new.not_crm_at, new.client_id, new.enquiry_id
     ) then
    return new;
  end if;

  update public.notifications n
     set status = 'dismissed'::public.notification_status
   where n.notification_type = 'client.reply_overdue'
     and n.entity_type = 'conversation'
     and n.entity_id = new.id
     and n.artist_id = new.artist_id
     and n.status in ('pending'::public.notification_status,
                      'delivered'::public.notification_status)
     and n.read_at is null
     and n.created_at <= new.not_crm_at;
  return new;
end;
$fn$;

revoke all on function crm_private.dismiss_personal_conversation_reply_alerts()
 from public, anon, authenticated;

create trigger communication_conversations_dismiss_personal_reply_alerts
after update of not_crm_at on public.communication_conversations
for each row
when (old.not_crm_at is distinct from new.not_crm_at
      and new.not_crm_at is not null)
execute function crm_private.dismiss_personal_conversation_reply_alerts();

-- Historical reconciliation is deliberately bounded by explicit human
-- classification, not by "looks like a personal chat" heuristics. Preserve
-- notification history as dismissed, never pretend it was read.
update public.notifications n
   set status = 'dismissed'::public.notification_status
  from public.communication_conversations c
 where n.notification_type = 'client.reply_overdue'
   and n.entity_type = 'conversation'
   and n.entity_id = c.id
   and n.artist_id = c.artist_id
   and n.status in ('pending'::public.notification_status,
                    'delivered'::public.notification_status)
   and n.read_at is null
   and crm_private.conversation_hidden_as_not_crm(
     c.not_crm_at, c.client_id, c.enquiry_id
   )
   and n.created_at <= c.not_crm_at;
