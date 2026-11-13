-- Phase 3 Today SQL hot path: the live pulse checks the most recent
-- actionable inbound and the latest sent studio reply for each open thread.
-- Without matching expression indexes it scans/sorts older messages for each
-- conversation (167 open threads, 6056 messages at diagnosis).
--
-- Add only indexes. Message status, reply classification, artist permissions,
-- delivery/notification rules and calendar behavior remain unchanged.
-- The live table is small; normal ordered migration gates are required.

create index if not exists communication_messages_today_inbound_idx
  on public.communication_messages
  (conversation_id, (coalesce(provider_timestamp, created_at)) desc, id desc)
  include (message_type)
  where direction = 'inbound';

create index if not exists communication_messages_today_studio_idx
  on public.communication_messages
  (conversation_id, (coalesce(sent_at, provider_timestamp, created_at)) desc)
  include (message_type)
  where direction = 'outbound'
    and origin in ('crm', 'provider_app')
    and status in ('sent', 'delivered', 'read');
