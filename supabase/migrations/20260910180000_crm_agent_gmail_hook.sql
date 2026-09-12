-- 20260910180000_crm_agent_gmail_hook.sql
--
-- Gmail correspondence into the derived-state refresh.
--
-- Gmail is the one supported channel whose message bodies the CRM does not
-- store: the Gmail Worker reads them from the mailbox under its own bounded
-- contract, and `crm_private.gmail_thread_contexts` holds the thread metadata.
-- That metadata is enough to know a client has replied, which is what has to
-- trigger a refresh.
--
-- This hangs off the thread-context table rather than modifying
-- `service_observe_gmail_enquiry_ai`. The observation function is a live
-- production integration contract with its own advisory locking, ambiguity
-- rules and baseline-only first-observation behaviour; a trigger on the row it
-- writes gets the same event without reopening any of that.
--
-- Establishing a baseline is not a reply. A first observation records a thread
-- the CRM has not seen before, which happens when the artist opens old mail,
-- so only a CHANGE of the last provider message is treated as new activity.

create function crm_private.enqueue_gmail_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op <> 'UPDATE'
     or new.last_provider_message_id is null
     or old.last_provider_message_id is not distinct from new.last_provider_message_id then
    return new;
  end if;
  -- A Gmail ingestion problem must never roll back the thread context the
  -- Gmail Worker depends on. No SQLERRM is emitted: it can carry a subject
  -- line or an address.
  begin
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, 'gmail:' || new.last_provider_message_id);
  exception when others then null;
  end;
  return new;
end;
$$;

revoke all on function crm_private.enqueue_gmail_client_ai()
  from public, anon, authenticated, service_role;

create trigger gmail_thread_contexts_enqueue_client_ai
  after update of last_provider_message_id on crm_private.gmail_thread_contexts
  for each row execute function crm_private.enqueue_gmail_client_ai();

comment on function crm_private.enqueue_gmail_client_ai() is
  'Schedules a client-state refresh when a Gmail thread advances to a new provider message. A first observation only establishes a baseline and is deliberately not treated as a reply.';
