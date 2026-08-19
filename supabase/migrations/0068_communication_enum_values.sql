-- 0068_communication_enum_values.sql
--
-- Reserve the enum labels the provider-neutral communications domain needs.
--
-- This migration intentionally only extends existing enums. PostgreSQL refuses
-- to use a new enum value inside the transaction that added it, so migrations
-- 0069-0072 use these labels only after this migration has committed. The same
-- split was used for WhatsApp in migration 0046.
--
-- `instagram` becomes an artist integration type so Vladimir and Kristina each
-- own a separate, independently enabled Instagram route. The existing partial
-- unique index `artist_integrations_one_enabled_type_idx` then guarantees at
-- most one enabled Instagram integration per artist, and there is deliberately
-- no shared or global Instagram route.
--
-- `instagram_message` is the durable outbox kind for one outbound Instagram
-- direct message. Keeping a channel-specific kind (rather than one neutral
-- kind) preserves the existing `resolve_outbox_route` mapping shape, where the
-- outbox kind alone determines which artist integration type is resolved.
--
-- Forward-only. No table, no provider call, no credential, no cron change, no
-- deployment and no enqueued work.

alter type public.artist_integration_type
  add value if not exists 'instagram';

alter type public.outbox_kind
  add value if not exists 'instagram_message';
