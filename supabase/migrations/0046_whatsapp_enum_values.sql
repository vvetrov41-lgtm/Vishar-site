-- 0046_whatsapp_enum_values.sql
--
-- Reserve the enum labels the WhatsApp Business Platform integration needs.
-- This migration intentionally only extends enums. Migration 0047 uses these
-- values only after this migration has committed, avoiding PostgreSQL's
-- same-transaction enum-value restriction.
--
-- `whatsapp` becomes an artist integration type so Vladimir and Kristina each
-- own a separate, independently enabled WhatsApp route. The existing partial
-- unique index `artist_integrations_one_enabled_type_idx` then guarantees at
-- most one enabled WhatsApp integration per artist, and there is deliberately
-- no shared or global WhatsApp route.
--
-- `whatsapp_message` is the durable outbox kind for one outbound WhatsApp
-- message. It is a distinct kind rather than a reuse of telegram_notification
-- so routing, claiming and draining stay artist- and provider-specific.
--
-- Forward-only. No provider call, no credential, no cron change, no
-- deployment, and no enqueued work.

alter type public.artist_integration_type
  add value if not exists 'whatsapp';

alter type public.outbox_kind
  add value if not exists 'whatsapp_message';
