-- 0040_calendar_availability_outbox_kinds.sql
--
-- Reserve explicit durable outbox kinds for artist Availability / Time Off
-- Calendar projection. This migration intentionally only extends the enum.
-- Migration 0041 uses these values only after this migration has committed,
-- avoiding PostgreSQL's same-transaction enum-value restriction.
-- This boundary is intentionally separate from all projection functions and
-- does not enqueue work by itself or mutate retained provider state.
--
-- Forward-only. No provider call, OAuth change, cron change or deployment.

alter type public.outbox_kind
  add value if not exists 'calendar_availability_create';
alter type public.outbox_kind
  add value if not exists 'calendar_availability_update';
alter type public.outbox_kind
  add value if not exists 'calendar_availability_cancel';