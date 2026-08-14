-- 0045_vladimir_booking_host_source.sql
--
-- Reserved migration boundary for the dedicated production booking host.
--
-- Intentionally no schema or data mutation.
--
-- `booking.vishartattoo.com` is infrastructure-specific production routing,
-- not canonical CRM bootstrap data. Creating a `booking_sources` row here would
-- change the clean database fixture and couple every local/test environment to
-- one production hostname.
--
-- The trusted source `vladimir-booking-host` must instead be provisioned by the
-- later explicit production rollout after all of these are verified together:
--
--   * the dedicated booking frontend Worker and Custom Domain are live;
--   * the intake Worker exact Origin allow-list includes
--     https://booking.vishartattoo.com;
--   * the existing Vladimir artist/source identity is read from production;
--   * the new source is created inactive first and checked end to end;
--   * activation is performed only after those checks pass.
--
-- Keeping this migration inert preserves the canonical clean CRM database and
-- makes the current PR incapable of changing production booking-source data by
-- merely applying repository migrations.

DO $$
BEGIN
  RAISE NOTICE 'booking host source provisioning is deferred to explicit production rollout';
END;
$$;
